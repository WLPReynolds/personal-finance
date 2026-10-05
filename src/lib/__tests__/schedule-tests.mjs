// Recurring items, projections and working days.
// Run with: node src/lib/__tests__/schedule-tests.mjs
import assert from 'node:assert/strict';
import {
  BUILT_IN_BANK_HOLIDAYS, isWorkingDay, shiftToWorkingDay, nthWorkingDay,
  parseGovUkBankHolidays, combineHolidayLists, lastKnownYear,
} from '../workdays.js';
import {
  addRecurring, updateRecurring, deleteRecurring, setOccurrence, confirmOccurrence,
  projections, withProjections, seriesDates, upcomingDates, horizonEnd, describeRule,
  recurringItems, occurrenceExceptions, itemNumbering, numberLabel,
} from '../schedule.js';
import { emptyLedger, addAccount, addTransaction, deleteTransaction, updateTransaction, balanceAsOf, accountRunning } from '../ops.js';
import { buildGridRows } from '../grid.js';
import { prepareMerge, fingerprint } from '../sync-core.js';
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

function setup() {
  let r = addAccount(emptyLedger(), { name: 'Current Account', type: 'current', institution: 'other', openingBalance: 100000, openingDate: '2026-10-01' });
  const current = r.account;
  r = addAccount(r.ledger, { name: 'Barclaycard', type: 'credit', institution: 'barclaycard', openingBalance: 50000, openingDate: '2026-10-01' });
  return { ledger: r.ledger, current, barclaycard: r.account };
}
const base = (accountId, extra = {}) => ({
  description: 'Netflix', kind: 'out', accountId, toAccountId: null, amount: 599,
  everyMonths: 1, day: 7, startDate: '2026-10-01', endDate: null, shift: 'none', ...extra,
});
const dates = (item, to) => seriesDates(item, to, HOL).map((o) => o.date);

console.log('working days');
test('weekends and bank holidays are not working days', () => {
  assert.equal(isWorkingDay('2026-10-05', HOL), true); // Monday
  assert.equal(isWorkingDay('2026-10-04', HOL), false); // Sunday
  assert.equal(isWorkingDay('2026-12-28', HOL), false); // Boxing Day substitute
  assert.equal(isWorkingDay('2026-08-31', HOL), false); // summer bank holiday
});
test('Barclaycard 13th working day matches the real 2026 statements (Jan–May, Jul)', () => {
  const real = { 1: '2026-01-20', 2: '2026-02-18', 3: '2026-03-18', 4: '2026-04-21', 5: '2026-05-20', 7: '2026-07-17' };
  for (const [m, d] of Object.entries(real)) assert.equal(nthWorkingDay(2026, Number(m), 13, HOL), d, `month ${m}`);
});
test('shift rules', () => {
  assert.equal(shiftToWorkingDay('2026-11-28', 'before', HOL), '2026-11-27'); // Sat -> Fri
  assert.equal(shiftToWorkingDay('2026-12-28', 'before', HOL), '2026-12-24'); // BH Mon, Sun, Sat, Fri BH -> Thu
  assert.equal(shiftToWorkingDay('2026-11-01', 'none', HOL), '2026-11-01'); // Sunday, left alone
  assert.equal(shiftToWorkingDay('2026-12-25', 'after', HOL), '2026-12-29'); // Fri BH -> Tue
  assert.equal(shiftToWorkingDay('2026-10-07', 'after', HOL), '2026-10-07'); // already working
});
test('gov.uk list parsing, and combining with the built-in list', () => {
  const parsed = parseGovUkBankHolidays({ 'england-and-wales': { events: [{ date: '2026-12-25' }, { date: '2026-01-01' }, { date: 'junk' }] }, scotland: { events: [{ date: '2026-01-02' }] } });
  assert.deepEqual(parsed, ['2026-01-01', '2026-12-25']);
  assert.throws(() => parseGovUkBankHolidays({}), /Unexpected/);
  const combined = combineHolidayLists(parsed);
  assert.ok(combined.includes('2025-12-26') && combined.includes('2027-12-28')); // other years from built-in
  assert.ok(!combined.includes('2026-05-04')); // the fetched list is the authority for its own years
  assert.equal(lastKnownYear(combined), 2027);
});

console.log('series dates');
test('salary: 28th, working day before (Wayne’s rule), incl. Christmas 2026', () => {
  const salary = base('a', { description: 'Salary', kind: 'in', day: 28, shift: 'before', startDate: '2026-10-01', amount: 400000 });
  assert.deepEqual(dates(salary, '2027-02-28'), ['2026-10-28', '2026-11-27', '2026-12-24', '2027-01-28', '2027-02-26']);
});
test('"don’t move" keeps the 1st on a Sunday', () => {
  const bills = base('a', { day: 1, startDate: '2026-11-01' });
  assert.deepEqual(dates(bills, '2026-12-31'), ['2026-11-01', '2026-12-01']);
});
test('direct debit on a weekend moves to the next working day', () => {
  const dd = base('a', { day: 15, shift: 'after', startDate: '2026-11-01' });
  assert.deepEqual(dates(dd, '2027-01-31'), ['2026-11-16', '2026-12-15', '2027-01-15']);
});
test('day 31 uses the last day of shorter months', () => {
  const x = base('a', { day: 31, startDate: '2026-10-01' });
  assert.deepEqual(dates(x, '2027-02-28'), ['2026-10-31', '2026-11-30', '2026-12-31', '2027-01-31', '2027-02-28']);
});
test('every 6 months and yearly count from the start date’s month', () => {
  const tv = base('a', { everyMonths: 6, day: 25, startDate: '2026-08-01' });
  assert.deepEqual(dates(tv, '2027-12-31'), ['2026-08-25', '2027-02-25', '2027-08-25']);
  const strava = base('a', { everyMonths: 12, day: 31, startDate: '2027-05-01' });
  assert.deepEqual(dates(strava, '2029-12-31'), ['2027-05-31', '2028-05-31', '2029-05-31']);
  assert.equal(describeRule(strava), 'Yearly on 31 May');
});
test('start date and end date (inclusive) bound the series', () => {
  const k = base('a', { day: 7, startDate: '2026-10-10', endDate: '2027-01-07' });
  assert.deepEqual(dates(k, '2027-06-30'), ['2026-11-07', '2026-12-07', '2027-01-07']);
});
test('a "working day before" shift can pull next month’s entry into range', () => {
  const x = base('a', { day: 1, shift: 'before', startDate: '2026-10-01' });
  assert.deepEqual(dates(x, '2026-10-31'), ['2026-10-01', '2026-10-30']); // Sun 1 Nov -> Fri 30 Oct
});
test('upcomingDates and horizonEnd', () => {
  const salary = base('a', { day: 28, shift: 'before', startDate: '2026-01-01' });
  assert.deepEqual(upcomingDates(salary, '2026-11-01', 2, HOL), ['2026-11-27', '2026-12-24']);
  assert.deepEqual(upcomingDates({ ...salary, endDate: '2026-10-31' }, '2026-11-01', 2, HOL), []);
  assert.equal(horizonEnd('2026-10-05', 3), '2027-01-31');
  assert.equal(horizonEnd('2026-10-05', 12), '2027-10-31');
});

console.log('projections and edits');
test('validation', () => {
  const { ledger, current } = setup();
  assert.throws(() => addRecurring(ledger, base(current.id, { description: ' ' })), /description/);
  assert.throws(() => addRecurring(ledger, base(current.id, { amount: 0 })), /Amount/);
  assert.throws(() => addRecurring(ledger, base(current.id, { kind: 'transfer', toAccountId: current.id })), /two different/);
  assert.throws(() => addRecurring(ledger, base(current.id, { endDate: '2026-01-01' })), /before the start/);
  assert.throws(() => addRecurring(ledger, base(current.id, { day: 32 })), /1 to 31/);
});
test('projections appear up to the horizon, overdue ones included', () => {
  let { ledger, current } = setup();
  ledger = addRecurring(ledger, base(current.id)).ledger;
  const p = projections(ledger, '2027-01-31', HOL);
  assert.deepEqual(p.map((x) => x.date), ['2026-10-07', '2026-11-07', '2026-12-07', '2027-01-07']);
});
test('end-of-month balance includes projections; today’s real balance doesn’t', () => {
  let { ledger, current } = setup();
  ledger = addRecurring(ledger, base(current.id, { description: 'Salary', kind: 'in', amount: 400000, day: 28 })).ledger;
  ledger = addRecurring(ledger, base(current.id)).ledger;
  const view = withProjections(ledger, '2026-12-31', HOL);
  assert.equal(balanceAsOf(ledger, current, '2026-10-31'), 100000);
  assert.equal(balanceAsOf(view, current, '2026-10-31'), 100000 + 400000 - 599);
  assert.equal(balanceAsOf(view, current, '2026-11-30'), 100000 + 2 * (400000 - 599));
});
test('skip: shown, but adds nothing; un-skip restores it', () => {
  let { ledger, current } = setup();
  const { ledger: l1, item } = addRecurring(ledger, base(current.id));
  ledger = setOccurrence(l1, item.id, '2026-11', { skipped: true });
  const view = withProjections(ledger, '2026-11-30', HOL);
  const nov = view.transactions.find((t) => t.isProjected && t.scheduledPeriod === '2026-11');
  assert.equal(nov.skipped, true);
  assert.equal(balanceAsOf(view, current, '2026-11-30'), 100000 - 599); // only October counts
  const running = accountRunning(view, current);
  assert.equal(running[running.length - 1].runningBalance, 100000 - 599);
  ledger = setOccurrence(ledger, item.id, '2026-11', { skipped: false });
  assert.equal(occurrenceExceptions(ledger).length, 0); // back to plain: no record kept
});
test('change one month only (e.g. December salary paid early)', () => {
  let { ledger, current } = setup();
  const { ledger: l1, item } = addRecurring(ledger, base(current.id, { description: 'Salary', kind: 'in', amount: 400000, day: 28, shift: 'before' }));
  ledger = setOccurrence(l1, item.id, '2026-12', { date: '2026-12-18', amount: 410000 });
  const dec = projections(ledger, '2026-12-31', HOL).find((p) => p.period === '2026-12');
  assert.equal(dec.date, '2026-12-18');
  assert.equal(dec.amount, 410000);
  assert.equal(dec.seriesDate, '2026-12-24');
  assert.equal(dec.changed, true);
  const nov = projections(ledger, '2026-12-31', HOL).find((p) => p.period === '2026-11');
  assert.equal(nov.amount, 400000);
});
test('edit series changes every unconfirmed month, not confirmed ones', () => {
  let { ledger, current } = setup();
  const { ledger: l1, item } = addRecurring(ledger, base(current.id));
  ledger = confirmOccurrence(l1, item.id, '2026-10', { date: '2026-10-07', amount: 599 });
  ledger = updateRecurring(ledger, item.id, { amount: 699, day: 9 });
  const p = projections(ledger, '2026-12-31', HOL);
  assert.deepEqual(p.map((x) => [x.date, x.amount]), [['2026-11-09', 699], ['2026-12-09', 699]]); // Oct stays confirmed despite the day change
  assert.equal(ledger.transactions.find((t) => t.scheduledPeriod === '2026-10').amount, 599);
});
test('confirm a card payment: two linked legs, real balance moves, projection gone', () => {
  let { ledger, current, barclaycard } = setup();
  const { ledger: l1, item } = addRecurring(ledger, base(current.id, { description: 'Barclaycard direct debit', kind: 'transfer', toAccountId: barclaycard.id, amount: 50000, day: 15, shift: 'after' }));
  ledger = confirmOccurrence(l1, item.id, '2026-10', { date: '2026-10-15', amount: 48765 });
  const legs = ledger.transactions.filter((t) => t.scheduledItemId === item.id);
  assert.equal(legs.length, 2);
  assert.deepEqual(legs.map((t) => [t.accountId, t.direction]), [[current.id, 'debit'], [barclaycard.id, 'credit']]);
  assert.equal(ledger.transfers.length, 1);
  assert.equal(balanceAsOf(ledger, barclaycard, '2026-10-31'), 50000 - 48765);
  assert.equal(balanceAsOf(ledger, current, '2026-10-31'), 100000 - 48765);
  assert.ok(!projections(ledger, '2026-10-31', HOL).some((p) => p.period === '2026-10'));
  assert.throws(() => confirmOccurrence(ledger, item.id, '2026-10', { date: '2026-10-15', amount: 1 }), /Already/);
  // editing a confirmed leg still mirrors the other leg (ordinary transfer behaviour)
  const edited = updateTransaction(ledger, legs[0].id, { amount: 48000 });
  assert.equal(edited.transactions.find((t) => t.id === legs[1].id).amount, 48000);
  assert.equal(edited.transactions.find((t) => t.id === legs[1].id).scheduledPeriod, '2026-10');
  // deleting it (either leg) un-confirms: the projection comes back
  ledger = deleteTransaction(ledger, legs[1].id);
  assert.equal(ledger.transactions.length, 0);
  assert.ok(projections(ledger, '2026-10-31', HOL).some((p) => p.period === '2026-10'));
});
test('delete an item: its skips go, its confirmed entries stay', () => {
  let { ledger, current } = setup();
  const { ledger: l1, item } = addRecurring(ledger, base(current.id));
  ledger = confirmOccurrence(l1, item.id, '2026-10', { date: '2026-10-07', amount: 599 });
  ledger = setOccurrence(ledger, item.id, '2026-11', { skipped: true });
  ledger = deleteRecurring(ledger, item.id);
  assert.equal(ledger.scheduledItems.length, 0);
  assert.equal(ledger.transactions.length, 1);
  assert.equal(projections(ledger, '2027-12-31', HOL).length, 0);
});
test('grid: projected transfer is one row; skipped row leaves the balance alone', () => {
  let { ledger, current, barclaycard } = setup();
  const r1 = addRecurring(ledger, base(current.id, { description: 'Card payment', kind: 'transfer', toAccountId: barclaycard.id, amount: 10000, day: 15 }));
  const r2 = addRecurring(r1.ledger, base(current.id, { day: 20 }));
  ledger = setOccurrence(r2.ledger, r2.item.id, '2026-10', { skipped: true });
  const rows = buildGridRows(withProjections(ledger, '2026-10-31', HOL), ledger.accounts);
  assert.equal(rows.length, 2);
  assert.ok(rows[0].projection && rows[0].isTransfer);
  assert.equal(rows[0].balances[current.id], 90000);
  assert.equal(rows[0].balances[barclaycard.id], 40000);
  assert.equal(rows[1].skipped, true);
  assert.equal(rows[1].balances[current.id], 90000);
});
test('a ledger from v0.4 (no recurring items) works unchanged', () => {
  let { ledger, current } = setup();
  ledger = addTransaction(ledger, { accountId: current.id, date: '2026-10-02', amount: 1500, direction: 'debit', description: 'Lottery' });
  const view = withProjections(ledger, '2027-01-31', HOL);
  assert.equal(view.transactions.length, 1);
  assert.equal(fingerprint(view), fingerprint(ledger));
});

console.log('sync and backup');
test('two devices confirm the same month identically → one entry, no clash', () => {
  const s = setup();
  const { ledger: start, item } = addRecurring(s.ledger, base(s.current.id));
  const a = confirmOccurrence(start, item.id, '2026-10', { date: '2026-10-07', amount: 599 });
  const b = confirmOccurrence(start, item.id, '2026-10', { date: '2026-10-07', amount: 599 });
  const { merged, groups } = prepareMerge({ base: start, local: a, remote: b });
  assert.equal(groups.length, 0);
  assert.equal(merged.transactions.length, 1);
});
test('two devices confirm the same card payment differently → one clash for both legs', () => {
  const s = setup();
  const { ledger: start, item } = addRecurring(s.ledger, base(s.current.id, { kind: 'transfer', toAccountId: s.barclaycard.id, amount: 50000 }));
  const a = confirmOccurrence(start, item.id, '2026-10', { date: '2026-10-07', amount: 50000 });
  const b = confirmOccurrence(start, item.id, '2026-10', { date: '2026-10-07', amount: 45000 });
  const { merged, groups } = prepareMerge({ base: start, local: a, remote: b });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].conflicts.length, 2);
  assert.equal(merged.transactions.length, 2);
  assert.equal(merged.transfers.length, 1);
});
test('skip on one device, series edit on the other → both kept', () => {
  const s = setup();
  const { ledger: start, item } = addRecurring(s.ledger, base(s.current.id));
  const a = setOccurrence(start, item.id, '2026-11', { skipped: true });
  const b = updateRecurring(start, item.id, { amount: 699 });
  const { merged, groups } = prepareMerge({ base: start, local: a, remote: b });
  assert.equal(groups.length, 0);
  assert.equal(recurringItems(merged)[0].amount, 699);
  assert.equal(occurrenceExceptions(merged)[0].skipped, true);
});
test('export → import keeps recurring items and exceptions', () => {
  const s = setup();
  const { ledger: l1, item } = addRecurring(s.ledger, base(s.current.id));
  const ledger = setOccurrence(l1, item.id, '2026-11', { skipped: true });
  const back = parseImport(JSON.stringify(buildExport(ledger, 'test'))).ledger;
  assert.equal(back.scheduledItems.length, 2);
  assert.deepEqual(projections(back, '2026-12-31', HOL), projections(ledger, '2026-12-31', HOL));
});

console.log('final payment & numbering (v0.6)');
// A loan: 12 monthly payments 1 Nov 2026 – 1 Oct 2027, last one smaller.
const loan = (accountId, extra = {}) => base(accountId, {
  description: 'Car loan', amount: 25000, day: 1, startDate: '2026-11-01', endDate: '2027-10-01', ...extra,
});
const proj = (ledger) => projections(ledger, '2027-12-31', HOL);
test('last payment uses finalAmount; the rest the usual amount', () => {
  const s = setup();
  const { ledger } = addRecurring(s.ledger, loan(s.current.id, { finalAmount: 12345 }));
  const p = proj(ledger);
  assert.equal(p.length, 12);
  assert.deepEqual(p.slice(0, 11).map((x) => x.amount), Array(11).fill(25000));
  assert.equal(p[11].amount, 12345);
  assert.equal(p[11].period, '2027-10');
});
test('final amount needs an end date', () => {
  const s = setup();
  assert.throws(() => addRecurring(s.ledger, base(s.current.id, { finalAmount: 100 })), /end date/);
  assert.throws(() => addRecurring(s.ledger, loan(s.current.id, { finalAmount: 0 })), /Last payment/);
});
test('(x of y) counts from 1 by default', () => {
  const s = setup();
  const { ledger } = addRecurring(s.ledger, loan(s.current.id));
  const p = proj(ledger);
  assert.deepEqual(p[0].number, { n: 1, of: 12 });
  assert.deepEqual(p[11].number, { n: 12, of: 12 });
  assert.equal(numberLabel(p[0].number), '(1 of 12)');
});
test('first payment number offsets the count (payment 1 made outside the series)', () => {
  const s = setup();
  const { ledger } = addRecurring(s.ledger, loan(s.current.id, { firstNumber: 2 }));
  const p = proj(ledger);
  assert.deepEqual(p[0].number, { n: 2, of: 13 });
  assert.deepEqual(p[11].number, { n: 13, of: 13 });
});
test('open-ended items are not numbered', () => {
  const s = setup();
  const { ledger } = addRecurring(s.ledger, base(s.current.id));
  assert.equal(proj(ledger)[0].number, null);
});
test('a skip closes the numbers up, the total drops, and the last payment moves back', () => {
  const s = setup();
  const { ledger: l1, item } = addRecurring(s.ledger, loan(s.current.id, { finalAmount: 12345 }));
  const ledger = setOccurrence(setOccurrence(l1, item.id, '2027-02', { skipped: true }), item.id, '2027-10', { skipped: true });
  const p = proj(ledger).filter((x) => !x.skipped);
  assert.equal(p.length, 10);
  assert.deepEqual(p.map((x) => x.number.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(p[3].period, '2027-03'); // after the skipped February
  assert.equal(p[9].number.of, 10);
  assert.equal(p[9].period, '2027-09');
  assert.equal(p[9].amount, 12345); // final amount follows the last payment actually due
  assert.equal(proj(ledger).find((x) => x.period === '2027-02').number, null);
});
test('confirmed entries keep their number, live, in the view ledger and the grid', () => {
  const s = setup();
  const { ledger: l1, item } = addRecurring(s.ledger, loan(s.current.id, { firstNumber: 2 }));
  const l2 = confirmOccurrence(l1, item.id, '2026-11', { date: '2026-11-02', amount: 25000 });
  const view = withProjections(l2, '2027-01-31', HOL);
  const confirmed = view.transactions.find((t) => t.scheduledPeriod === '2026-11' && !t.isProjected);
  assert.deepEqual(confirmed.seriesNo, { n: 2, of: 13 });
  assert.equal(l2.transactions.find((t) => t.id === confirmed.id).seriesNo, undefined); // never stored
  const rows = buildGridRows(view, view.accounts);
  assert.deepEqual(rows.map((r) => r.seriesNo && r.seriesNo.n), [2, 3, 4]);
  // fix the numbering later → the confirmed one follows
  const l3 = updateRecurring(l2, item.id, { firstNumber: 5 });
  assert.deepEqual(withProjections(l3, '2026-11-30', HOL).transactions.find((t) => t.id === confirmed.id).seriesNo, { n: 5, of: 16 });
});
test('final amount on a transfer series (card payoff) hits both legs', () => {
  const s = setup();
  const { ledger } = addRecurring(s.ledger, loan(s.current.id, { kind: 'transfer', toAccountId: s.barclaycard.id, finalAmount: 999 }));
  const view = withProjections(ledger, '2027-12-31', HOL);
  const last = view.transactions.filter((t) => t.scheduledPeriod === '2027-10');
  assert.deepEqual(last.map((t) => t.amount), [999, 999]);
});
test('a one-off change still beats the final amount; seriesAmount is the final one', () => {
  const s = setup();
  const { ledger: l1, item } = addRecurring(s.ledger, loan(s.current.id, { finalAmount: 12345 }));
  const ledger = setOccurrence(l1, item.id, '2027-10', { amount: 500 });
  const last = proj(ledger)[11];
  assert.equal(last.amount, 500);
  assert.equal(last.seriesAmount, 12345);
});
test('items saved before v0.6 (no finalAmount/firstNumber) still work and can be edited', () => {
  const s = setup();
  const { ledger: l1, item } = addRecurring(s.ledger, loan(s.current.id));
  const old = { ...l1, scheduledItems: l1.scheduledItems.map(({ finalAmount, firstNumber, ...r }) => r) };
  assert.deepEqual(proj(old)[0].number, { n: 1, of: 12 });
  const edited = updateRecurring(old, item.id, { amount: 26000 });
  assert.equal(recurringItems(edited)[0].firstNumber, 1);
  assert.equal(recurringItems(edited)[0].finalAmount, null);
});
test('itemNumbering for a draft (editor preview)', () => {
  const s = setup();
  const n = itemNumbering(s.ledger, { ...loan(s.current.id), id: '', firstNumber: 3 });
  assert.equal(n.size, 12);
  assert.deepEqual(n.get('2027-10'), { n: 14, of: 14 });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
