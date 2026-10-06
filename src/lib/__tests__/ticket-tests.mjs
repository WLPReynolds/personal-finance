// v0.13 — ticket purchases on the card, ring-fencing, money back before the payment.
// Run with: node src/lib/__tests__/ticket-tests.mjs
import assert from 'node:assert/strict';
import { BUILT_IN_BANK_HOLIDAYS } from '../workdays.js';
import { emptyLedger, addAccount, addTransaction, updateTransaction, deleteTransaction, balanceAsOf } from '../ops.js';
import { addRecurring, withProjections, projections } from '../schedule.js';
import { statementFor } from '../statements.js';
import { envelopeBalances } from '../envelopes.js';
import { parseTrackerEstimates, usesTracker, refreshTrackerEstimates, TRACKER_READER } from '../tracker-estimates.js';
import {
  setTicketSettings, ticketSettings, ticketSettingsProblem, ticketProjections, confirmTicket, confirmedTicketIds,
  addRingFence, removeRingFence, syncRingFence, ringFenceLegs, ticketsMissingFromTracker, confirmReturn, ticketTxId,
} from '../tickets.js';
import { prepareMerge } from '../sync-core.js';
import { buildExport, parseImport } from '../transfer-file.js';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL - ${name}`);
    console.log(`    ${err.message.slice(0, 900)}`);
  }
}
const HOL = new Set(BUILT_IN_BANK_HOLIDAYS);
const PRICE = 15360;

function period(paydayMonth, start, end) {
  return { paydayMonth, start, end, status: 'projected', ticketCount: 2, ticketPence: 30720, parkingDays: 0, parkingPence: 0, totalPence: 30720 };
}
const tk = (status, validFrom, validTo, purchaseDate, pricePence = PRICE) => ({ id: `${status === 'bought' ? 'p' : 'f'}-${validFrom}`, validFrom, validTo, purchaseDate, pricePence, status });
/** Shaped like the tracker's real file of 6 Oct 2026 (trimmed). */
function fileObj(tickets) {
  return {
    format: 'transport-estimates', version: 1, generatedAt: '2026-10-06T21:07:27.610Z',
    source: { app: 'ticket-tracker', appVersion: 'v2026-10-06.21:57' },
    assumptions: { ticketPricePence: PRICE, parkingDayPence: 639 },
    periods: [period('2026-09', '2026-09-28', '2026-10-27'), period('2026-10', '2026-10-28', '2026-11-26'), period('2026-11', '2026-11-27', '2026-12-23')],
    tickets,
  };
}
const TICKETS = [
  tk('bought', '2026-09-23', '2026-10-06', '2026-09-22'),
  tk('bought', '2026-10-07', '2026-10-20', '2026-10-06'),
  tk('projected', '2026-10-21', '2026-11-03', '2026-10-20'),
  tk('projected', '2026-11-04', '2026-11-17', '2026-11-03'),
  tk('projected', '2026-11-18', '2026-12-01', '2026-11-17'),
  tk('projected', '2026-12-02', '2026-12-15', '2026-12-01'),
];
function estimatesOf(tickets = TICKETS) {
  const r = parseTrackerEstimates(JSON.stringify(fileObj(tickets)));
  assert.ok(r.ok, r.error);
  return r.estimates;
}

/** Current, Barclaycard (13th working day / 25 days), Monzo pots with Transport, Safe keeping — all from 1 Oct. */
function setup({ settings = true } = {}) {
  let r = addAccount(emptyLedger(), { name: 'Current Account', type: 'current', institution: 'other', openingBalance: 200000, openingDate: '2026-10-01' });
  const current = r.account;
  r = addAccount(r.ledger, { name: 'Barclaycard', type: 'credit', institution: 'barclaycard', openingBalance: 0, openingDate: '2026-10-01', creditCard: { statementWorkingDay: 13 } });
  const card = r.account;
  r = addAccount(r.ledger, {
    name: 'Monzo pots', type: 'savings', institution: 'monzo', openingBalance: 100000, openingDate: '2026-10-01',
    envelopes: { enabled: true, list: [{ id: 'M', name: 'Maintenance', openingBalance: 20000 }, { id: 'T', name: 'Transport', openingBalance: 80000 }] },
  });
  const monzo = r.account;
  r = addAccount(r.ledger, { name: 'Safe keeping', type: 'savings', institution: 'monzo', openingBalance: 0, openingDate: '2026-10-01' });
  const safe = r.account;
  let ledger = r.ledger;
  const fields = { enabled: true, cardAccountId: card.id, envelopeAccountId: monzo.id, envelopeId: 'T', safeAccountId: safe.id, returnAccountId: current.id, startDate: '2026-10-06' };
  if (settings) ledger = setTicketSettings(ledger, fields);
  return { ledger, current, card, monzo, safe, fields };
}
const src = (today, tickets) => ({ tracker: estimatesOf(tickets), today });
const ticketProj = (ledger, today, to = '2027-01-31', tickets) => projections(ledger, to, HOL, src(today, tickets)).filter((p) => p.kind === 'ticket');
const returnProj = (ledger, today, to = '2027-01-31', tickets) => projections(ledger, to, HOL, src(today, tickets)).filter((p) => p.kind === 'ticketReturn');

console.log('reading the tracker’s ticket list');
await test('the tickets are read, oldest first, with periods unchanged', () => {
  const e = estimatesOf();
  assert.equal(e.tickets.length, 6);
  assert.equal(e.tickets[1].id, 'p-2026-10-07');
  assert.equal(e.ticketsError, null);
  assert.equal(e.periods.length, 3);
});
await test('no list (an older tracker) → tickets null, no error', () => {
  const f = fileObj(TICKETS);
  delete f.tickets;
  const r = parseTrackerEstimates(JSON.stringify(f));
  assert.ok(r.ok);
  assert.equal(r.estimates.tickets, null);
  assert.equal(r.estimates.ticketsError, null);
});
await test('a bad ticket list is ignored on its own — the periods are still used', () => {
  for (const bad of [
    [{ ...TICKETS[0], id: 'f-2026-09-23' }], // bought with an f- id
    [{ ...TICKETS[0], pricePence: 153.6 }],
    [{ ...TICKETS[0], purchaseDate: '2026-02-30' }],
    [TICKETS[0], TICKETS[0]],
    [{ ...TICKETS[0], status: 'maybe' }],
    'nope',
  ]) {
    const r = parseTrackerEstimates(JSON.stringify(fileObj(bad)));
    assert.ok(r.ok);
    assert.equal(r.estimates.tickets, null);
    assert.match(r.estimates.ticketsError, /ticket purchases not shown/);
    assert.equal(r.estimates.periods.length, 3);
  }
});
await test('switched-on ticket purchases make the app read the tracker’s file', () => {
  assert.equal(usesTracker(setup({ settings: false }).ledger), false);
  assert.equal(usesTracker(setup().ledger), true);
});
await test('a copy cached by an older version is downloaded again once', async () => {
  const text = JSON.stringify(fileObj(TICKETS));
  let downloads = 0;
  const drive = { findFilesByName: async () => [{ id: 'F', version: '7' }], download: async () => { downloads++; return text; } };
  const old = { fileId: 'F', version: '7', checkedAt: 'x', estimates: { periods: [] }, error: null }; // v0.12: no reader
  const rec = await refreshTrackerEstimates({ drive, token: 't', cached: old });
  assert.equal(downloads, 1);
  assert.equal(rec.reader, TRACKER_READER);
  assert.equal(rec.estimates.tickets.length, 6);
  await refreshTrackerEstimates({ drive, token: 't', cached: rec });
  assert.equal(downloads, 1, 'unchanged file, same reader → not downloaded again');
});

console.log('settings');
await test('settings are checked when switched on', () => {
  const { ledger, fields, card, monzo, current } = setup({ settings: false });
  assert.throws(() => setTicketSettings(ledger, { ...fields, cardAccountId: current.id }), /credit card/);
  assert.throws(() => setTicketSettings(ledger, { ...fields, envelopeId: 'nope' }), /envelope/);
  assert.throws(() => setTicketSettings(ledger, { ...fields, safeAccountId: monzo.id }), /different account/);
  assert.throws(() => setTicketSettings(ledger, { ...fields, safeAccountId: card.id }), /Safe keeping/);
  assert.throws(() => setTicketSettings(ledger, { ...fields, returnAccountId: fields.safeAccountId }), /different account/);
  assert.throws(() => setTicketSettings(ledger, { ...fields, startDate: '' }), /start date/);
  const off = setTicketSettings(ledger, { ...fields, enabled: false, envelopeId: null });
  assert.equal(ticketSettings(off), null);
  assert.ok(ticketSettings(setTicketSettings(ledger, fields)));
});
await test('the settings live in scheduledItems (one record) and survive export/import', () => {
  const { ledger, fields } = setup();
  const again = setTicketSettings(ledger, { ...fields, startDate: '2026-10-07' });
  assert.equal(again.scheduledItems.filter((r) => r.recordType === 'ticketPurchases').length, 1);
  const back = parseImport(JSON.stringify(buildExport(again))).ledger;
  assert.equal(ticketSettings(back).startDate, '2026-10-07');
});
await test('a deleted envelope or account turns them off with a reason, not an error', () => {
  const { ledger, monzo } = setup();
  const noEnv = { ...ledger, accounts: ledger.accounts.map((a) => (a.id === monzo.id ? { ...a, envelopes: { enabled: true, list: [{ id: 'M', name: 'Maintenance', openingBalance: 0, hidden: false }] } } : a)) };
  assert.equal(ticketSettings(noEnv), null);
  assert.match(ticketSettingsProblem(noEnv), /envelope/);
});

console.log('projected tickets');
await test('from the start date: the bought one at its real date, the rest on their forecast dates', () => {
  const { ledger } = setup();
  const ps = ticketProj(ledger, '2026-10-06');
  assert.deepEqual(ps.map((p) => [p.ticket.id, p.date, p.bought]), [
    ['p-2026-10-07', '2026-10-06', true], ['f-2026-10-21', '2026-10-20', false], ['f-2026-11-04', '2026-11-03', false],
    ['f-2026-11-18', '2026-11-17', false], ['f-2026-12-02', '2026-12-01', false],
  ]);
});
await test('nothing without settings, without a ticket list, or past the horizon', () => {
  assert.equal(ticketProj(setup({ settings: false }).ledger, '2026-10-06').length, 0);
  const { ledger } = setup();
  const e = estimatesOf();
  assert.equal(projections(ledger, '2027-01-31', HOL, { tracker: { ...e, tickets: null }, today: '2026-10-06' }).filter((p) => p.kind === 'ticket').length, 0);
  assert.equal(ticketProj(ledger, '2026-10-06', '2026-10-31').length, 2);
});
await test('each projected ticket = a card spend + Transport → Safe keeping, in the view', () => {
  const { ledger, card, monzo, safe } = setup();
  const view = withProjections(ledger, '2026-10-31', HOL, src('2026-10-06'));
  const legs = view.transactions.filter((t) => t.projection?.kind === 'ticket' && t.projection.ticket.id === 'p-2026-10-07');
  assert.deepEqual(legs.map((t) => [t.accountId, t.direction, t.amount]), [[card.id, 'debit', PRICE], [monzo.id, 'debit', PRICE], [safe.id, 'credit', PRICE]]);
  assert.deepEqual(legs[1].envelopeSplits, [{ envelopeId: 'T', amount: PRICE }]);
  assert.equal(legs[1].transferId, legs[2].transferId);
  // end of October: Transport down two tickets, Safe keeping up two, card owes two
  const t = envelopeBalances(view, view.accounts.find((a) => a.id === monzo.id), '2026-10-31');
  assert.equal(t.byId.T, 80000 - 2 * PRICE);
  assert.equal(balanceAsOf(view, safe, '2026-10-31'), 2 * PRICE);
  assert.equal(balanceAsOf(view, card, '2026-10-31'), 2 * PRICE);
});
await test('the projected card payment includes projected tickets', () => {
  const { ledger, card, current } = setup();
  const l = addRecurring(ledger, { description: 'Barclaycard', kind: 'transfer', accountId: current.id, toAccountId: card.id, amount: 0, payStatement: true, everyMonths: 1, day: 1, startDate: '2026-10-01', endDate: null, shift: 'after' }).ledger;
  const pays = projections(l, '2026-12-31', HOL, src('2026-10-06')).filter((p) => p.statement);
  // Oct statement (19 Oct) has the 6 Oct ticket; Nov statement (18 Nov) has 20 Oct, 3 Nov, 17 Nov
  assert.deepEqual(pays.map((p) => [p.date, p.amount]), [['2026-11-13', PRICE], ['2026-12-14', 3 * PRICE]]);
  assert.equal(statementFor(withProjections(l, '2026-12-31', HOL, src('2026-10-06')), card, '2026-10', HOL).owed, PRICE);
});
await test('when the tracker’s plan moves, the projected tickets simply move', () => {
  const { ledger } = setup();
  const moved = TICKETS.map((t) => (t.status === 'projected' ? { ...t, id: t.id.replace(/\d\d$/, (d) => String(Number(d) + 1).padStart(2, '0')), validFrom: t.validFrom.replace(/\d\d$/, (d) => String(Number(d) + 1).padStart(2, '0')), purchaseDate: t.validFrom } : t));
  const ps = ticketProj(ledger, '2026-10-06', '2026-11-30', moved);
  assert.deepEqual(ps.map((p) => p.date), ['2026-10-06', '2026-10-21', '2026-11-04', '2026-11-18']);
});
await test('overdue: a forecast purchase date that has passed shows on TODAY', () => {
  const { ledger, card } = setup();
  const ps = ticketProj(ledger, '2026-10-22');
  const late = ps.find((p) => p.ticket.id === 'f-2026-10-21');
  assert.equal(late.overdue, true);
  assert.equal(late.date, '2026-10-22');
  // so it lands on the November statement, not the October one already produced on 19 Oct
  const view = withProjections(ledger, '2026-12-31', HOL, src('2026-10-22'));
  assert.equal(statementFor(view, card, '2026-10', HOL).owed, PRICE);
  // a bought one is never moved
  assert.equal(ps.find((p) => p.ticket.id === 'p-2026-10-07').date, '2026-10-06');
});

console.log('confirming a bought ticket');
await test('confirm → the card spend and its ring-fence are real entries; the projection goes', () => {
  const { ledger, card, monzo, safe } = setup();
  const s = ticketSettings(ledger);
  const t = estimatesOf().tickets[1];
  const l = confirmTicket(ledger, s, t, { date: '2026-10-06', amount: PRICE });
  const spend = l.transactions.find((x) => x.id === ticketTxId(t.id));
  assert.equal(spend.accountId, card.id);
  assert.equal(spend.ticketId, 'p-2026-10-07');
  const legs = ringFenceLegs(l, spend.id);
  assert.deepEqual(legs.map((x) => [x.accountId, x.direction]).sort(), [[monzo.id, 'debit'], [safe.id, 'credit']].sort());
  assert.ok(l.transfers.some((x) => x.id === legs[0].transferId));
  assert.ok(!ticketProj(l, '2026-10-06').some((p) => p.ticket.id === t.id));
  assert.deepEqual([...confirmedTicketIds(l)], ['p-2026-10-07']);
  assert.throws(() => confirmTicket(l, s, t, { date: '2026-10-06', amount: PRICE }), /Already/);
  // today's balances (confirmed only) now show it
  assert.equal(balanceAsOf(l, safe, '2026-10-06'), PRICE);
  assert.equal(balanceAsOf(l, card, '2026-10-06'), PRICE);
});
await test('a forecast ticket can’t be confirmed', () => {
  const { ledger } = setup();
  assert.throws(() => confirmTicket(ledger, ticketSettings(ledger), estimatesOf().tickets[2], { date: '2026-10-20', amount: PRICE }), /tracker first/);
});
await test('the statement choice is kept on the card spend', () => {
  const { ledger } = setup();
  const l = confirmTicket(ledger, ticketSettings(ledger), estimatesOf().tickets[1], { date: '2026-10-19', amount: PRICE, statementMonth: '2026-11' });
  assert.equal(l.transactions.find((x) => x.id === 'tk:p-2026-10-07').statementMonth, '2026-11');
});
await test('deleting the confirmed spend (plus its ring-fence) puts the "bought" row back', () => {
  const { ledger } = setup();
  let l = confirmTicket(ledger, ticketSettings(ledger), estimatesOf().tickets[1], { date: '2026-10-06', amount: PRICE });
  l = syncRingFence(deleteTransaction(l, 'tk:p-2026-10-07'), 'tk:p-2026-10-07');
  assert.equal(l.transactions.length, 0);
  assert.ok(ticketProj(l, '2026-10-06').some((p) => p.ticket.id === 'p-2026-10-07' && p.bought));
});
await test('two devices confirming the same ticket merge to one', () => {
  const { ledger } = setup();
  const s = ticketSettings(ledger);
  const t = estimatesOf().tickets[1];
  const a = confirmTicket(ledger, s, t, { date: '2026-10-06', amount: PRICE });
  const b = confirmTicket(ledger, s, t, { date: '2026-10-06', amount: PRICE });
  const { merged } = prepareMerge({ base: ledger, local: a, remote: b });
  assert.equal(merged.transactions.length, 3);
});
await test('"No longer in tracker": a confirmed ticket whose id left the file (within 90 days)', () => {
  const { ledger } = setup();
  const l = confirmTicket(ledger, ticketSettings(ledger), estimatesOf().tickets[1], { date: '2026-10-06', amount: PRICE });
  assert.equal(ticketsMissingFromTracker(l, estimatesOf(), '2026-10-07').size, 0);
  const without = estimatesOf(TICKETS.filter((t) => t.id !== 'p-2026-10-07').concat([tk('bought', '2026-10-08', '2026-10-21', '2026-10-06')]));
  assert.deepEqual([...ticketsMissingFromTracker(l, without, '2026-10-07')], ['tk:p-2026-10-07']);
  assert.equal(ticketsMissingFromTracker(l, without, '2027-01-10').size, 0, 'past the 90-day window: dropped from the file normally');
  assert.equal(ticketsMissingFromTracker(l, { ...without, tickets: null }, '2026-10-07').size, 0, 'no list → never flagged');
});

console.log('ring-fencing any card spend');
await test('add, follow an edit, and remove', () => {
  const { ledger, card } = setup();
  const s = ticketSettings(ledger);
  let l = addTransaction(ledger, { accountId: card.id, date: '2026-10-09', amount: 639, direction: 'debit', description: 'Parking' });
  const id = l.transactions.at(-1).id;
  l = addRingFence(l, s, id);
  assert.equal(ringFenceLegs(l, id).length, 2);
  assert.equal(addRingFence(l, s, id), l, 'twice → no change');
  l = syncRingFence(updateTransaction(l, id, { amount: 1278, date: '2026-10-10' }), id);
  assert.deepEqual(ringFenceLegs(l, id).map((t) => [t.date, t.amount]), [['2026-10-10', 1278], ['2026-10-10', 1278]]);
  assert.deepEqual(ringFenceLegs(l, id).find((t) => t.envelopeSplits).envelopeSplits, [{ envelopeId: 'T', amount: 1278 }]);
  l = removeRingFence(l, id);
  assert.equal(ringFenceLegs(l, id).length, 0);
  assert.equal(l.transactions.length, 1);
  assert.equal(l.transfers.length, 0);
});
await test('only a spend on the chosen card can be ring-fenced', () => {
  const { ledger, current, card } = setup();
  const s = ticketSettings(ledger);
  let l = addTransaction(ledger, { accountId: current.id, date: '2026-10-09', amount: 639, direction: 'debit', description: 'x' });
  assert.throws(() => addRingFence(l, s, l.transactions.at(-1).id), /spend on the card/);
  l = addTransaction(ledger, { accountId: card.id, date: '2026-10-09', amount: 639, direction: 'credit', description: 'refund' });
  assert.throws(() => addRingFence(l, s, l.transactions.at(-1).id), /spend on the card/);
});

console.log('money back before the card payment');
await test('one transfer per statement, the calendar day before the payment, adding up everything ring-fenced', () => {
  const { ledger, card, safe, current } = setup();
  let l = addTransaction(ledger, { accountId: card.id, date: '2026-10-09', amount: 639, direction: 'debit', description: 'Parking' });
  l = addRingFence(l, ticketSettings(l), l.transactions.at(-1).id);
  const rs = returnProj(l, '2026-10-06');
  // Oct statement 19 Oct → payment Fri 13 Nov → back Thu 12 Nov: ticket + parking
  // Nov statement 18 Nov → payment 13 Dec is a Sunday → Mon 14 Dec → back Sun 13 Dec
  assert.deepEqual(rs.map((p) => [p.statementMonth, p.date, p.amount]), [['2026-10', '2026-11-12', PRICE + 639], ['2026-11', '2026-12-13', 3 * PRICE], ['2026-12', '2027-01-10', PRICE]]);
  assert.equal(rs[0].accountId, safe.id);
  assert.equal(rs[0].toAccountId, current.id);
  // only spends that are ring-fenced count
  const plain = addTransaction(ledger, { accountId: card.id, date: '2026-10-09', amount: 999, direction: 'debit', description: 'Shopping' });
  assert.equal(returnProj(plain, '2026-10-06')[0].amount, PRICE);
});
await test('a spend moved to the next statement moves its money too', () => {
  const { ledger } = setup();
  const l = confirmTicket(ledger, ticketSettings(ledger), estimatesOf().tickets[1], { date: '2026-10-06', amount: PRICE, statementMonth: '2026-11' });
  const rs = returnProj(l, '2026-10-06', '2026-12-31');
  assert.deepEqual(rs.map((p) => [p.statementMonth, p.amount]), [['2026-11', 4 * PRICE]]);
});
await test('confirming the money back replaces that month’s projection; balances net to nothing on the current account', () => {
  const { ledger, current, card, safe } = setup();
  const s = ticketSettings(ledger);
  let l = confirmTicket(ledger, s, estimatesOf().tickets[1], { date: '2026-10-06', amount: PRICE });
  l = confirmReturn(l, s, '2026-10', { date: '2026-11-12', amount: PRICE, description: 'Back for Barclaycard' });
  assert.ok(!returnProj(l, '2026-10-06').some((p) => p.statementMonth === '2026-10'));
  assert.ok(l.transactions.every((t) => t.id !== 'tkret:2026-10:out' || t.ticketReturn === '2026-10'));
  assert.throws(() => confirmReturn(l, s, '2026-10', { date: '2026-11-12', amount: PRICE }), /Already/);
  l = addRecurring(l, { description: 'Barclaycard', kind: 'transfer', accountId: current.id, toAccountId: card.id, amount: 0, payStatement: true, everyMonths: 1, day: 1, startDate: '2026-10-01', endDate: null, shift: 'after' }).ledger;
  const view = withProjections(l, '2026-11-13', HOL, src('2026-10-06', TICKETS.slice(0, 2)));
  assert.equal(balanceAsOf(view, current, '2026-11-13'), 200000, 'back in, then out to Barclaycard');
  assert.equal(balanceAsOf(view, safe, '2026-11-13'), 0);
  assert.equal(balanceAsOf(view, card, '2026-11-13') + 0, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
