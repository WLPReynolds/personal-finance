// v0.12 envelopes (Monzo pots).
// Run with: node src/lib/__tests__/envelope-tests.mjs
import assert from 'node:assert/strict';
import {
  envelopeConfig, envelopeList, cleanEnvelopeConfig, validateSplits, fitSplits, splitEvenly,
  envelopeBalances, envelopeHistory, allocationOf, unallocatedEntries, openingUnallocated, isEnvelopeMove,
} from '../envelopes.js';
import {
  emptyLedger, addAccount, updateAccount, addTransaction, updateTransaction, deleteTransaction, setEnvelopeSplits,
  addEnvelopeMove, updateEnvelopeMove, balanceAsOf, counterpartOf,
} from '../ops.js';
import { addRecurring, updateRecurring, withProjections, confirmOccurrence, setOccurrence, envelopeLegAccountId } from '../schedule.js';
import { BUILT_IN_BANK_HOLIDAYS } from '../workdays.js';
import { prepareMerge } from '../sync-core.js';
import { buildExport, parseImport } from '../transfer-file.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL - ${name}`);
    console.log(`    ${err.stack.split('\n').slice(0, 3).join('\n    ')}`);
  }
}
const HOL = new Set(BUILT_IN_BANK_HOLIDAYS);

/** Current account + Monzo pots with Maintenance/Health/Transport/Home Insurance, £1,000 opening of which £100 unallocated. */
function setup() {
  let r = addAccount(emptyLedger(), { name: 'Current Account', type: 'current', institution: 'other', openingBalance: 200000, openingDate: '2026-10-01' });
  const current = r.account;
  r = addAccount(r.ledger, {
    name: 'Monzo pots', type: 'savings', institution: 'monzo', openingBalance: 100000, openingDate: '2026-10-01',
    envelopes: { enabled: true, list: [
      { id: 'M', name: 'Maintenance', openingBalance: 20000 },
      { id: 'H', name: 'Health', openingBalance: 20000 },
      { id: 'T', name: 'Transport', openingBalance: 50000 },
      { id: 'I', name: 'Home Insurance', openingBalance: 0 },
    ] },
  });
  return { ledger: r.ledger, current, monzo: r.account };
}
const acc = (ledger, id) => ledger.accounts.find((a) => a.id === id);
const spend = (accountId, amount, extra = {}) => ({ accountId, date: '2026-10-05', amount, direction: 'debit', description: 'Parking', ...extra });

console.log('settings');
test('envelope account is set up with ids, order and an Unallocated remainder', () => {
  const { monzo } = setup();
  assert.ok(envelopeConfig(monzo));
  assert.deepEqual(envelopeList(monzo).map((e) => e.name), ['Maintenance', 'Health', 'Transport', 'Home Insurance']);
  assert.equal(openingUnallocated(monzo), 10000);
});
test('names must be filled in, different, and not "Unallocated"', () => {
  assert.throws(() => cleanEnvelopeConfig({ list: [{ name: ' ' }] }), /needs a name/);
  assert.throws(() => cleanEnvelopeConfig({ list: [{ name: 'Health' }, { name: 'health' }] }), /Two envelopes/);
  assert.throws(() => cleanEnvelopeConfig({ list: [{ name: 'Unallocated' }] }), /kept for money/);
});
test('a credit card cannot use envelopes', () => {
  assert.throws(() => addAccount(emptyLedger(), { name: 'Card', type: 'credit', institution: 'other', openingBalance: 0, openingDate: '2026-10-01', envelopes: { list: [{ name: 'X' }] } }), /credit card/);
});
test('renaming an envelope keeps its entries (ids, not names)', () => {
  let { ledger, monzo } = setup();
  ledger = addTransaction(ledger, spend(monzo.id, 700, { envelopeSplits: [{ envelopeId: 'T', amount: 700 }] }));
  const list = acc(ledger, monzo.id).envelopes.list.map((e) => (e.id === 'T' ? { ...e, name: 'Train & parking' } : e));
  ledger = updateAccount(ledger, monzo.id, { envelopes: { enabled: true, list } });
  assert.equal(envelopeBalances(ledger, acc(ledger, monzo.id)).byId.T, 49300);
  assert.equal(acc(ledger, monzo.id).envelopes.list[2].name, 'Train & parking');
});
test('an envelope with entries can be hidden but not removed', () => {
  let { ledger, monzo } = setup();
  ledger = addTransaction(ledger, spend(monzo.id, 700, { envelopeSplits: [{ envelopeId: 'T', amount: 700 }] }));
  const without = acc(ledger, monzo.id).envelopes.list.filter((e) => e.id !== 'T');
  assert.throws(() => updateAccount(ledger, monzo.id, { envelopes: { enabled: true, list: without } }), /hide it instead/);
  const hidden = acc(ledger, monzo.id).envelopes.list.map((e) => (e.id === 'T' ? { ...e, hidden: true } : e));
  ledger = updateAccount(ledger, monzo.id, { envelopes: { enabled: true, list: hidden } });
  assert.deepEqual(envelopeList(acc(ledger, monzo.id)).map((e) => e.id), ['M', 'H', 'I']);
  assert.equal(envelopeBalances(ledger, acc(ledger, monzo.id)).byId.T, 49300); // history kept
  // an unused one can be removed
  const noIns = acc(ledger, monzo.id).envelopes.list.filter((e) => e.id !== 'I');
  ledger = updateAccount(ledger, monzo.id, { envelopes: { enabled: true, list: noIns } });
  assert.equal(acc(ledger, monzo.id).envelopes.list.length, 3);
});

console.log('splits');
test('splits must add up to the amount and name real envelopes', () => {
  const { monzo } = setup();
  assert.equal(validateSplits(monzo, 2582, null), null);
  assert.deepEqual(validateSplits(monzo, 2582, [{ envelopeId: 'M', amount: 1416 }, { envelopeId: 'H', amount: 1166 }, { envelopeId: 'T', amount: 0 }]),
    [{ envelopeId: 'M', amount: 1416 }, { envelopeId: 'H', amount: 1166 }]); // zero boxes dropped
  assert.throws(() => validateSplits(monzo, 2582, [{ envelopeId: 'M', amount: 1416 }]), /add up/);
  assert.throws(() => validateSplits(monzo, 100, [{ envelopeId: 'nope', amount: 100 }]), /Pick an envelope/);
  assert.throws(() => validateSplits(monzo, 200, [{ envelopeId: 'M', amount: 100 }, { envelopeId: 'M', amount: 100 }]), /twice/);
});
test('interest split evenly: spare pennies to the first envelopes', () => {
  assert.deepEqual(splitEvenly(195, ['M', 'H', 'T', 'I']).map((s) => s.amount), [49, 49, 49, 48]);
  assert.deepEqual(splitEvenly(244, ['M', 'H', 'T', 'I']).map((s) => s.amount), [61, 61, 61, 61]);
  assert.deepEqual(splitEvenly(193, ['M', 'H', 'T']).map((s) => s.amount), [65, 64, 64]);
  assert.deepEqual(splitEvenly(2, ['M', 'H', 'T', 'I']).map((s) => s.amount), [1, 1, 0, 0]);
  for (const n of [1, 7, 99, 1001]) assert.equal(splitEvenly(n, ['a', 'b', 'c', 'd']).reduce((s, x) => s + x.amount, 0), n);
});
test('fitSplits: one envelope follows a new amount; a split that no longer adds up becomes Unallocated', () => {
  assert.deepEqual(fitSplits([{ envelopeId: 'T', amount: 700 }], 650), [{ envelopeId: 'T', amount: 650 }]);
  assert.equal(fitSplits([{ envelopeId: 'M', amount: 1416 }, { envelopeId: 'H', amount: 1166 }], 3000), null);
  assert.equal(fitSplits(null, 100), null);
});

console.log('balances');
test('envelopes always add up to the account, old entries count as Unallocated', () => {
  let { ledger, monzo } = setup();
  ledger = addTransaction(ledger, spend(monzo.id, 15360, { description: 'Train fare', envelopeSplits: [{ envelopeId: 'T', amount: 15360 }] }));
  ledger = addTransaction(ledger, spend(monzo.id, 1500)); // not assigned (like the October entries)
  ledger = addTransaction(ledger, { accountId: monzo.id, date: '2026-10-06', amount: 195, direction: 'credit', description: 'Interest',
    envelopeSplits: splitEvenly(195, ['M', 'H', 'T', 'I']) });
  const m = acc(ledger, monzo.id);
  const b = envelopeBalances(ledger, m);
  assert.deepEqual(b.byId, { M: 20049, H: 20049, T: 34689, I: 48 });
  assert.equal(b.unallocated, 10000 - 1500);
  assert.equal(b.total, balanceAsOf(ledger, m, '2026-12-31'));
  assert.equal(unallocatedEntries(ledger, m).length, 1);
  assert.deepEqual(allocationOf(ledger.transactions[0], m), { type: 'single', envelopeId: 'T' });
  assert.deepEqual(allocationOf(ledger.transactions[2], m), { type: 'split', count: 4 });
  assert.deepEqual(allocationOf(ledger.transactions[1], m), { type: 'unallocated' });
});
test('as-of date and skipped projections', () => {
  let { ledger, monzo } = setup();
  ledger = addTransaction(ledger, spend(monzo.id, 700, { date: '2026-11-02', envelopeSplits: [{ envelopeId: 'T', amount: 700 }] }));
  const m = acc(ledger, monzo.id);
  assert.equal(envelopeBalances(ledger, m, '2026-10-31').byId.T, 50000);
  assert.equal(envelopeBalances(ledger, m, '2026-11-30').byId.T, 49300);
  const skipped = { ...ledger, transactions: ledger.transactions.map((t) => ({ ...t, skipped: true })) };
  assert.equal(envelopeBalances(skipped, m).byId.T, 50000);
});
test('a split pointing at a missing envelope falls to Unallocated (totals still match)', () => {
  let { ledger, monzo } = setup();
  ledger = { ...ledger, transactions: [...ledger.transactions, { id: 'x', accountId: monzo.id, date: '2026-10-02', amount: 500, direction: 'debit', kind: 'transaction', envelopeSplits: [{ envelopeId: 'gone', amount: 500 }] }] };
  const b = envelopeBalances(ledger, acc(ledger, monzo.id));
  assert.equal(b.unallocated, 9500);
  assert.equal(b.total, 99500);
});
test('envelope history: running balance per envelope, like a pots-sheet column', () => {
  let { ledger, monzo } = setup();
  ledger = addTransaction(ledger, spend(monzo.id, 700, { date: '2026-10-03', envelopeSplits: [{ envelopeId: 'T', amount: 700 }] }));
  ledger = addTransaction(ledger, spend(monzo.id, 500, { date: '2026-10-02', envelopeSplits: [{ envelopeId: 'H', amount: 500 }] }));
  ledger = addTransaction(ledger, spend(monzo.id, 15360, { date: '2026-10-04', envelopeSplits: [{ envelopeId: 'T', amount: 15360 }] }));
  const h = envelopeHistory(ledger, acc(ledger, monzo.id), 'T');
  assert.equal(h.opening, 50000);
  assert.deepEqual(h.rows.map((r) => [r.transaction.date, r.change, r.balance]), [['2026-10-03', -700, 49300], ['2026-10-04', -15360, 33940]]);
  assert.equal(envelopeHistory(ledger, acc(ledger, monzo.id), null).rows.length, 0);
});

console.log('moves between envelopes');
test('a move changes two envelopes and not the account', () => {
  let { ledger, monzo } = setup();
  ledger = addEnvelopeMove(ledger, { accountId: monzo.id, date: '2026-10-07', amount: 17150, fromEnvelopeId: 'T', toEnvelopeId: 'H', description: 'Glasses — not enough in Health' });
  const m = acc(ledger, monzo.id);
  const t = ledger.transactions[0];
  assert.ok(isEnvelopeMove(t));
  assert.equal(t.kind, 'note');
  assert.equal(t.amount, 0);
  const b = envelopeBalances(ledger, m);
  assert.equal(b.byId.T, 50000 - 17150);
  assert.equal(b.byId.H, 20000 + 17150);
  assert.equal(b.total, 100000);
  assert.equal(balanceAsOf(ledger, m, '2026-12-31'), 100000);
  assert.deepEqual(allocationOf(t, m), { type: 'move', from: 'T', to: 'H', amount: 17150 });
});
test('a move from Unallocated, editing and deleting a move', () => {
  let { ledger, monzo } = setup();
  ledger = addEnvelopeMove(ledger, { accountId: monzo.id, date: '2026-10-07', amount: 10000, fromEnvelopeId: null, toEnvelopeId: 'I' });
  let b = envelopeBalances(ledger, acc(ledger, monzo.id));
  assert.equal(b.unallocated, 0);
  assert.equal(b.byId.I, 10000);
  const id = ledger.transactions[0].id;
  ledger = updateEnvelopeMove(ledger, id, { date: '2026-10-08', amount: 4000, fromEnvelopeId: null, toEnvelopeId: 'M' });
  b = envelopeBalances(ledger, acc(ledger, monzo.id));
  assert.equal(b.byId.M, 24000);
  assert.equal(b.byId.I, 0);
  assert.throws(() => updateTransaction(ledger, id, { description: 'x' }), /own dialog/);
  assert.throws(() => addEnvelopeMove(ledger, { accountId: monzo.id, date: '2026-10-07', amount: 1, fromEnvelopeId: 'M', toEnvelopeId: 'M' }), /two different/);
  ledger = deleteTransaction(ledger, id);
  assert.equal(envelopeBalances(ledger, acc(ledger, monzo.id)).unallocated, 10000);
});

console.log('transfers and edits');
test('a transfer from the current account puts the Monzo leg in envelopes', () => {
  let { ledger, current, monzo } = setup();
  ledger = addTransaction(ledger, { accountId: current.id, date: '2026-10-28', amount: 2582, direction: 'debit', description: 'To pots',
    counterpartAccountId: monzo.id, counterpartEnvelopeSplits: [{ envelopeId: 'M', amount: 1416 }, { envelopeId: 'H', amount: 1166 }] });
  const cur = ledger.transactions.find((t) => t.accountId === current.id);
  const mon = ledger.transactions.find((t) => t.accountId === monzo.id);
  assert.equal(cur.envelopeSplits, null);
  assert.equal(mon.envelopeSplits.length, 2);
  // giving envelopes to the current account's own leg is refused
  assert.throws(() => addTransaction(ledger, { ...spend(current.id, 100), envelopeSplits: [{ envelopeId: 'M', amount: 100 }] }), /doesn’t use envelopes/);
});
test('editing the other leg’s amount: one envelope follows, a split becomes Unallocated', () => {
  let { ledger, current, monzo } = setup();
  ledger = addTransaction(ledger, { accountId: current.id, date: '2026-10-28', amount: 46200, direction: 'debit', description: 'Transport top-up',
    counterpartAccountId: monzo.id, counterpartEnvelopeSplits: [{ envelopeId: 'T', amount: 46200 }] });
  ledger = addTransaction(ledger, { accountId: current.id, date: '2026-10-28', amount: 2582, direction: 'debit', description: 'To pots',
    counterpartAccountId: monzo.id, counterpartEnvelopeSplits: [{ envelopeId: 'M', amount: 1416 }, { envelopeId: 'H', amount: 1166 }] });
  const [topUp, toPots] = ledger.transactions.filter((t) => t.accountId === current.id);
  ledger = updateTransaction(ledger, topUp.id, { amount: 30890 });
  ledger = updateTransaction(ledger, toPots.id, { amount: 3000 });
  const legs = ledger.transactions.filter((t) => t.accountId === monzo.id);
  assert.deepEqual(legs[0].envelopeSplits, [{ envelopeId: 'T', amount: 30890 }]);
  assert.equal(legs[1].envelopeSplits, null);
  const b = envelopeBalances(ledger, acc(ledger, monzo.id));
  assert.equal(b.total, balanceAsOf(ledger, acc(ledger, monzo.id), '2026-12-31'));
});
test('editing an entry on the envelope account: new splits checked, unchanged ones kept', () => {
  let { ledger, monzo } = setup();
  ledger = addTransaction(ledger, spend(monzo.id, 1500));
  const id = ledger.transactions[0].id;
  ledger = updateTransaction(ledger, id, { envelopeSplits: [{ envelopeId: 'T', amount: 1500 }] });
  assert.deepEqual(ledger.transactions[0].envelopeSplits, [{ envelopeId: 'T', amount: 1500 }]);
  ledger = updateTransaction(ledger, id, { description: 'Parking at Crewe' });
  assert.deepEqual(ledger.transactions[0].envelopeSplits, [{ envelopeId: 'T', amount: 1500 }]);
  assert.throws(() => updateTransaction(ledger, id, { envelopeSplits: [{ envelopeId: 'T', amount: 100 }] }), /add up/);
  ledger = updateTransaction(ledger, id, { kind: 'note', description: 'now a note' });
  assert.equal(ledger.transactions[0].envelopeSplits, null);
});
test('setEnvelopeSplits assigns one entry (and refuses notes)', () => {
  let { ledger, current, monzo } = setup();
  ledger = addTransaction(ledger, { accountId: current.id, date: '2026-10-28', amount: 2582, direction: 'debit', description: 'To pots', counterpartAccountId: monzo.id });
  const mon = ledger.transactions.find((t) => t.accountId === monzo.id);
  ledger = setEnvelopeSplits(ledger, mon.id, [{ envelopeId: 'M', amount: 1416 }, { envelopeId: 'H', amount: 1166 }]);
  assert.equal(ledger.transactions.find((t) => t.id === mon.id).envelopeSplits.length, 2);
  ledger = setEnvelopeSplits(ledger, mon.id, null);
  assert.equal(ledger.transactions.find((t) => t.id === mon.id).envelopeSplits, null);
  ledger = addTransaction(ledger, { accountId: monzo.id, date: '2026-10-02', kind: 'note', description: 'In Greece', amount: 0, direction: 'debit' });
  assert.throws(() => setEnvelopeSplits(ledger, ledger.transactions.at(-1).id, [{ envelopeId: 'M', amount: 0 }]), /note/);
});

console.log('recurring items');
test('a recurring transfer into the pots: projections and confirmed entries land in the envelopes', () => {
  let { ledger, current, monzo } = setup();
  const r = addRecurring(ledger, { description: 'To pots', kind: 'transfer', accountId: current.id, toAccountId: monzo.id, amount: 2582,
    everyMonths: 1, day: 28, startDate: '2026-10-01', endDate: null, shift: 'none',
    envelopeSplits: [{ envelopeId: 'M', amount: 1416 }, { envelopeId: 'H', amount: 1166 }] });
  ledger = r.ledger;
  assert.equal(envelopeLegAccountId(r.item, ledger.accounts), monzo.id);
  const view = withProjections(ledger, '2026-11-30', HOL);
  const legs = view.transactions.filter((t) => t.isProjected && t.accountId === monzo.id);
  assert.equal(legs.length, 2);
  assert.equal(legs[0].envelopeSplits.length, 2);
  assert.equal(view.transactions.find((t) => t.isProjected && t.accountId === current.id).envelopeSplits, null);
  const eom = envelopeBalances(view, acc(view, monzo.id), '2026-11-30');
  assert.equal(eom.byId.M, 20000 + 2 * 1416);
  // a one-off amount for one month can't be split the same way: Unallocated
  ledger = setOccurrence(ledger, r.item.id, '2026-11', { amount: 3000 });
  const v2 = withProjections(ledger, '2026-11-30', HOL);
  assert.equal(v2.transactions.find((t) => t.isProjected && t.accountId === monzo.id && t.scheduledPeriod === '2026-11').envelopeSplits, null);
  ledger = confirmOccurrence(ledger, r.item.id, '2026-10', { date: '2026-10-28', amount: 2582 });
  const conf = ledger.transactions.find((t) => t.accountId === monzo.id && t.scheduledPeriod === '2026-10');
  assert.equal(conf.envelopeSplits.length, 2);
  assert.equal(ledger.transactions.find((t) => t.accountId === current.id && t.scheduledPeriod === '2026-10').envelopeSplits, null);
});
test('one envelope follows any amount (e.g. the ticket tracker’s figure)', () => {
  let { ledger, current, monzo } = setup();
  const r = addRecurring(ledger, { description: 'Train fare/Parking', kind: 'transfer', accountId: current.id, toAccountId: monzo.id, amount: 46200,
    everyMonths: 1, day: 28, startDate: '2026-10-01', endDate: null, shift: 'before', envelopeSplits: [{ envelopeId: 'T', amount: 1 }] });
  ledger = r.ledger;
  assert.deepEqual(r.item.envelopeSplits, [{ envelopeId: 'T', amount: 46200 }]); // stored tidy
  ledger = confirmOccurrence(ledger, r.item.id, '2026-10', { date: '2026-10-28', amount: 44139 });
  assert.deepEqual(ledger.transactions.find((t) => t.accountId === monzo.id).envelopeSplits, [{ envelopeId: 'T', amount: 44139 }]);
});
test('recurring item checks', () => {
  const { ledger, current, monzo } = setup();
  const base = { description: 'x', kind: 'transfer', accountId: current.id, toAccountId: monzo.id, amount: 2582, everyMonths: 1, day: 28, startDate: '2026-10-01', endDate: null, shift: 'none' };
  assert.throws(() => addRecurring(ledger, { ...base, envelopeSplits: [{ envelopeId: 'M', amount: 1000 }, { envelopeId: 'H', amount: 1000 }] }), /add up/);
  assert.throws(() => addRecurring(ledger, { ...base, amountFrom: 'ticket-tracker', envelopeSplits: [{ envelopeId: 'M', amount: 1416 }, { envelopeId: 'H', amount: 1166 }] }), /one envelope/);
  assert.throws(() => addRecurring(ledger, { ...base, kind: 'out', toAccountId: null, envelopeSplits: [{ envelopeId: 'M', amount: 2582 }] }), /Neither account/);
  // money out OF the pots account
  const r = addRecurring(ledger, { ...base, kind: 'out', accountId: monzo.id, toAccountId: null, amount: 19403, envelopeSplits: [{ envelopeId: 'I', amount: 19403 }] });
  const v = withProjections(r.ledger, '2026-10-31', HOL);
  assert.equal(envelopeBalances(v, acc(v, monzo.id)).byId.I, -19403);
  const u = updateRecurring(r.ledger, r.item.id, { amount: 20000 });
  assert.deepEqual(u.scheduledItems.find((i) => i.id === r.item.id).envelopeSplits, [{ envelopeId: 'I', amount: 20000 }]);
});

console.log('sync and export');
test('splits and moves survive export/import and a two-device merge', () => {
  let { ledger, monzo } = setup();
  ledger = addTransaction(ledger, spend(monzo.id, 1500));
  ledger = addTransaction(ledger, spend(monzo.id, 700));
  const base = ledger;
  const [a, b] = base.transactions;
  const local = setEnvelopeSplits(base, a.id, [{ envelopeId: 'T', amount: 1500 }]);
  const remote = addEnvelopeMove(setEnvelopeSplits(base, b.id, [{ envelopeId: 'M', amount: 700 }]),
    { accountId: monzo.id, date: '2026-10-09', amount: 500, fromEnvelopeId: 'T', toEnvelopeId: 'H' });
  const prep = prepareMerge({ base, local, remote });
  assert.equal(prep.groups.length, 0);
  const merged = prep.merged;
  const m = acc(merged, monzo.id);
  const bal = envelopeBalances(merged, m);
  assert.equal(bal.byId.T, 50000 - 1500 - 500);
  assert.equal(bal.byId.M, 20000 - 700);
  assert.equal(bal.byId.H, 20500);
  const back = parseImport(JSON.stringify(buildExport(merged))).ledger;
  assert.deepEqual(envelopeBalances(back, acc(back, monzo.id)), bal);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
