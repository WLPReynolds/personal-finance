// Reconciling against the bank / card statement (v0.8).
// Run with: node src/lib/__tests__/reconcile-tests.mjs
import assert from 'node:assert/strict';
import { BUILT_IN_BANK_HOLIDAYS } from '../workdays.js';
import {
  isReconciled, isReconcilable, setReconciled, reconcileScope, reconcileDifference, defaultPeriod, untickedCount,
} from '../reconcile.js';
import { emptyLedger, addAccount, addTransaction, updateTransaction, deleteTransaction, setStatementMonth, counterpartOf } from '../ops.js';
import { addRecurring, withProjections } from '../schedule.js';
import { statementFor } from '../statements.js';
import { buildExport, parseImport } from '../transfer-file.js';
import { prepareMerge } from '../sync-core.js';

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

/**
 * Current Account £3,000 and Barclaycard £500 owed (statements 13 / 25), opening 1 Oct 2026.
 * Oct statement = Mon 19 Oct 2026. Entries:
 *   card 10 Oct spend £50, 19 Oct spend £20, 19 Oct £10 moved to the Nov statement,
 *   12 Oct payment £500 (transfer from Current), current 15 Oct salary £4,000.
 */
function setup() {
  let r = addAccount(emptyLedger(), { name: 'Current Account', type: 'current', institution: 'other', openingBalance: 300000, openingDate: '2026-10-01' });
  const current = r.account;
  r = addAccount(r.ledger, { name: 'Barclaycard', type: 'credit', institution: 'barclaycard', openingBalance: 50000, openingDate: '2026-10-01', creditCard: { statementWorkingDay: 13, paymentDaysAfter: 25 } });
  const card = r.account;
  let l = r.ledger;
  l = addTransaction(l, { accountId: card.id, date: '2026-10-10', amount: 5000, direction: 'debit', description: 'Groceries' });
  l = addTransaction(l, { accountId: card.id, date: '2026-10-19', amount: 2000, direction: 'debit', description: 'Fuel' });
  l = addTransaction(l, { accountId: card.id, date: '2026-10-19', amount: 1000, direction: 'debit', description: 'Amazon', statementMonth: '2026-11' });
  l = addTransaction(l, { accountId: current.id, date: '2026-10-12', amount: 50000, direction: 'debit', description: 'Barclaycard payment', counterpartAccountId: card.id });
  l = addTransaction(l, { accountId: current.id, date: '2026-10-15', amount: 400000, direction: 'credit', description: 'Salary' });
  const id = (desc, acc = card) => l.transactions.find((t) => t.description === desc && t.accountId === acc.id).id;
  return { ledger: l, current, card, id };
}
const descs = (scope) => scope.entries.map((e) => e.tx.description);

console.log('scope');
test('card statement: this statement’s entries, oldest first, app figure = statement owed', () => {
  const { ledger, card } = setup();
  const s = reconcileScope(ledger, card, { month: '2026-10' }, HOL);
  assert.equal(s.kind, 'statement');
  assert.equal(s.closingDate, '2026-10-19');
  assert.deepEqual(descs(s), ['Groceries', 'Barclaycard payment', 'Fuel']); // Amazon is on the Nov statement
  assert.equal(s.appBalance, 50000 + 5000 - 50000 + 2000); // £70 owed
  assert.equal(s.appBalance, statementFor(ledger, card, '2026-10', HOL).owed);
  assert.equal(s.tickedBalance, 50000); // nothing ticked: just the opening amount owed
  assert.equal(s.tickedCount, 0);
  assert.equal(s.totalCount, 3);
});
test('ticking every line brings the difference to £0.00', () => {
  const { ledger: l0, card } = setup();
  let ledger = l0;
  const s0 = reconcileScope(ledger, card, { month: '2026-10' }, HOL);
  assert.equal(reconcileDifference(s0, 7000), 7000 - 50000);
  for (const e of s0.entries) ledger = setReconciled(ledger, e.tx.id, true);
  const s = reconcileScope(ledger, card, { month: '2026-10' }, HOL);
  assert.equal(s.tickedBalance, 7000);
  assert.equal(reconcileDifference(s, 7000), 0);
  assert.equal(s.tickedCount, 3);
});
test('a wrong amount shows as a difference (bank says £72, app has £70)', () => {
  const { ledger: l0, card } = setup();
  let ledger = l0;
  for (const e of reconcileScope(ledger, card, { month: '2026-10' }, HOL).entries) ledger = setReconciled(ledger, e.tx.id, true);
  assert.equal(reconcileDifference(reconcileScope(ledger, card, { month: '2026-10' }, HOL), 7200), 200);
});
test('earlier unticked entries are carried into the next statement; ticked ones are not', () => {
  const { ledger: l0, card, id } = setup();
  let s = reconcileScope(l0, card, { month: '2026-11' }, HOL);
  assert.deepEqual(descs(s), ['Groceries', 'Barclaycard payment', 'Fuel', 'Amazon']);
  assert.deepEqual(s.entries.map((e) => e.inPeriod), [false, false, false, true]);
  assert.equal(s.earlierUnticked, 3);
  let ledger = setReconciled(l0, id('Groceries'), true);
  ledger = setReconciled(ledger, id('Fuel'), true);
  s = reconcileScope(ledger, card, { month: '2026-11' }, HOL);
  assert.deepEqual(descs(s), ['Barclaycard payment', 'Amazon']);
  assert.equal(s.earlierUnticked, 1);
  // ticked earlier entries still count towards the ticked balance
  assert.equal(s.tickedBalance, 50000 + 5000 + 2000);
});
test('other accounts: up to a closing date, period = a month back', () => {
  const { ledger, current } = setup();
  const s = reconcileScope(ledger, current, { toDate: '2026-10-31' }, HOL);
  assert.equal(s.kind, 'date');
  assert.equal(s.fromDate, '2026-10-01');
  assert.deepEqual(descs(s), ['Barclaycard payment', 'Salary']);
  assert.equal(s.appBalance, 300000 - 50000 + 400000);
  const s2 = reconcileScope(ledger, current, { toDate: '2026-10-14' }, HOL);
  assert.deepEqual(descs(s2), ['Barclaycard payment']); // salary is after the closing date
  assert.equal(s2.appBalance, 250000);
});
test('closing-date period start clamps to short months', () => {
  const { ledger, current } = setup();
  assert.equal(reconcileScope(ledger, current, { toDate: '2027-03-31' }, HOL).fromDate, '2027-03-01'); // 28 Feb + 1
  assert.equal(reconcileScope(ledger, current, { toDate: '2026-10-06' }, HOL).fromDate, '2026-09-07');
  assert.equal(reconcileScope(ledger, current, { toDate: '2027-01-15' }, HOL).fromDate, '2026-12-16');
  assert.throws(() => reconcileScope(ledger, current, { toDate: '' }, HOL), /closing date/);
});
test('a card without statement dates reconciles by closing date', () => {
  const { ledger: l0 } = setup();
  const r = addAccount(l0, { name: 'Nationwide', type: 'credit', institution: 'nationwide', openingBalance: 10000, openingDate: '2026-10-01' });
  const l = addTransaction(r.ledger, { accountId: r.account.id, date: '2026-10-03', amount: 2500, direction: 'debit', description: 'Shoes' });
  const s = reconcileScope(l, r.account, { toDate: '2026-10-31' }, HOL);
  assert.equal(s.kind, 'date');
  assert.equal(s.appBalance, 12500); // owed
  assert.equal(s.tickedBalance, 10000);
});

console.log('ticks');
test('notes, projected and skipped entries can’t be reconciled; projected ones never appear', () => {
  const { ledger: l0, current, card } = setup();
  let ledger = addTransaction(l0, { accountId: card.id, date: '2026-10-11', kind: 'note', description: 'In Greece', amount: 0, direction: 'debit' });
  const note = ledger.transactions.find((t) => t.kind === 'note');
  assert.equal(isReconcilable(note), false);
  assert.throws(() => setReconciled(ledger, note.id, true), /Only money entries/);
  ledger = addRecurring(ledger, { description: 'Netflix', kind: 'out', accountId: current.id, toAccountId: null, amount: 599, everyMonths: 1, day: 20, startDate: '2026-10-01', endDate: null, shift: 'none' }).ledger;
  const view = withProjections(ledger, '2026-10-31', HOL);
  const s = reconcileScope(view, current, { toDate: '2026-10-31' }, HOL);
  assert.ok(!descs(s).includes('Netflix'));
  assert.ok(!reconcileScope(ledger, card, { month: '2026-10' }, HOL).entries.some((e) => e.tx.kind === 'note'));
});
test('a transfer’s legs are ticked separately', () => {
  const { ledger: l0, card, id } = setup();
  const ledger = setReconciled(l0, id('Barclaycard payment'), true);
  const leg = ledger.transactions.find((t) => t.id === id('Barclaycard payment'));
  assert.equal(isReconciled(leg), true);
  assert.equal(isReconciled(counterpartOf(ledger, leg)), false);
  assert.equal(leg.accountId, card.id);
});
test('untick, and unknown id', () => {
  const { ledger: l0, id } = setup();
  let ledger = setReconciled(l0, id('Fuel'), true);
  ledger = setReconciled(ledger, id('Fuel'), false);
  assert.equal(isReconciled(ledger.transactions.find((t) => t.id === id('Fuel'))), false);
  assert.throws(() => setReconciled(ledger, 'nope', true), /not found/);
});
test('untickedCount for a header badge', () => {
  const { ledger: l0, card, id } = setup();
  assert.equal(untickedCount(l0, card, '2026-10-31'), 4);
  assert.equal(untickedCount(setReconciled(l0, id('Fuel'), true), card, '2026-10-31'), 3);
  assert.equal(untickedCount(l0, card, '2026-10-11'), 1);
});

console.log('editing a reconciled entry');
test('changing the amount or date clears the tick; a new description doesn’t', () => {
  const { ledger: l0, id } = setup();
  const ledger = setReconciled(l0, id('Fuel'), true);
  const get = (l) => l.transactions.find((t) => t.id === id('Fuel'));
  assert.equal(isReconciled(get(updateTransaction(ledger, id('Fuel'), { description: 'Fuel (Tesco)' }))), true);
  assert.equal(isReconciled(get(updateTransaction(ledger, id('Fuel'), { amount: 2100 }))), false);
  assert.equal(isReconciled(get(updateTransaction(ledger, id('Fuel'), { date: '2026-10-18' }))), false);
  assert.equal(isReconciled(get(updateTransaction(ledger, id('Fuel'), { direction: 'credit' }))), false);
  assert.equal(isReconciled(get(updateTransaction(ledger, id('Fuel'), { statementMonth: '2026-11' }))), false);
  assert.equal(isReconciled(get(updateTransaction(ledger, id('Fuel'), { statementMonth: null }))), true); // absent = null: no change
  // saving with nothing changed keeps it
  const t = get(ledger);
  assert.equal(isReconciled(get(updateTransaction(ledger, t.id, { amount: t.amount, date: t.date, direction: t.direction, description: t.description }))), true);
});
test('changing a transfer’s amount clears both legs; a description change keeps both', () => {
  const { ledger: l0, current, id } = setup();
  let ledger = setReconciled(l0, id('Barclaycard payment'), true);
  ledger = setReconciled(ledger, id('Barclaycard payment', current), true);
  const both = (l) => l.transactions.filter((t) => t.description.startsWith('Barclaycard payment')).map(isReconciled);
  assert.deepEqual(both(updateTransaction(ledger, id('Barclaycard payment', current), { description: 'Barclaycard payment Oct' })), [true, true]);
  assert.deepEqual(both(updateTransaction(ledger, id('Barclaycard payment', current), { amount: 45000 })), [false, false]);
});
test('moving a reconciled entry to another statement clears its tick', () => {
  const { ledger: l0, id } = setup();
  const ledger = setReconciled(l0, id('Fuel'), true);
  const get = (l) => l.transactions.find((t) => t.id === id('Fuel'));
  assert.equal(isReconciled(get(setStatementMonth(ledger, id('Fuel'), null))), true); // unchanged (already by date)
  assert.equal(isReconciled(get(setStatementMonth(ledger, id('Fuel'), '2026-11'))), false);
});
test('deleting a reconciled entry just deletes it', () => {
  const { ledger: l0, card, id } = setup();
  const ledger = deleteTransaction(setReconciled(l0, id('Fuel'), true), id('Fuel'));
  assert.equal(reconcileScope(ledger, card, { month: '2026-10' }, HOL).totalCount, 2);
});

console.log('period to open on');
test('statement card: latest statement produced by today, never before the first', () => {
  const { card, current } = setup();
  assert.deepEqual(defaultPeriod(card, '2026-10-06', HOL), { month: '2026-10' }); // Sep's was before records: first is Oct
  assert.deepEqual(defaultPeriod(card, '2026-10-19', HOL), { month: '2026-10' });
  assert.deepEqual(defaultPeriod(card, '2026-11-17', HOL), { month: '2026-10' }); // Nov's is 18 Nov
  assert.deepEqual(defaultPeriod(card, '2026-11-18', HOL), { month: '2026-11' });
  assert.deepEqual(defaultPeriod(current, '2026-10-06', HOL), { toDate: '2026-10-06' });
});

console.log('sync and files');
test('ticks survive export → import', () => {
  const { ledger: l0, id } = setup();
  const ledger = setReconciled(l0, id('Fuel'), true);
  const back = parseImport(JSON.stringify(buildExport(ledger))).ledger;
  assert.equal(isReconciled(back.transactions.find((t) => t.id === id('Fuel'))), true);
});
test('a tick on one device and an edit to another entry on the other merge cleanly', () => {
  const { ledger: base, id } = setup();
  const local = setReconciled(base, id('Fuel'), true);
  const remote = updateTransaction(base, id('Groceries'), { description: 'Groceries (Aldi)' });
  const { merged, groups } = prepareMerge({ base, local, remote });
  assert.equal(groups.length, 0);
  assert.equal(isReconciled(merged.transactions.find((t) => t.id === id('Fuel'))), true);
  assert.equal(merged.transactions.find((t) => t.id === id('Groceries')).description, 'Groceries (Aldi)');
});
test('both devices ticking the same entry is not a clash', () => {
  const { ledger: base, id } = setup();
  const a = setReconciled(base, id('Fuel'), true);
  const b = setReconciled(base, id('Fuel'), true);
  const { groups } = prepareMerge({ base, local: a, remote: b });
  assert.equal(groups.length, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
