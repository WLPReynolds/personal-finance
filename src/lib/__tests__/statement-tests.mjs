// Credit card statements and statement payments (v0.7).
// Run with: node src/lib/__tests__/statement-tests.mjs
import assert from 'node:assert/strict';
import { BUILT_IN_BANK_HOLIDAYS } from '../workdays.js';
import {
  statementDate, paymentDueDate, statementMonthByDate, effectiveStatementMonth, statementFor,
  statementMonths, firstStatementMonth, boundaryChoice, withStatements, statementConfig,
} from '../statements.js';
import {
  addRecurring, updateRecurring, setOccurrence, confirmOccurrence, projections, withProjections,
  upcomingDates, describeRule,
} from '../schedule.js';
import {
  emptyLedger, addAccount, updateAccount, addTransaction, updateTransaction, setStatementMonth, accountRunning,
} from '../ops.js';
import { buildGridRows } from '../grid.js';
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
const BARCLAYCARD = { statementWorkingDay: 13, paymentDaysAfter: 25 };

/** Current Account + Barclaycard (statements on), opening 1 Oct 2026, £500 owed. */
function setup({ owed = 50000, cc = BARCLAYCARD, opening = '2026-10-01' } = {}) {
  let r = addAccount(emptyLedger(), { name: 'Current Account', type: 'current', institution: 'other', openingBalance: 300000, openingDate: opening });
  const current = r.account;
  r = addAccount(r.ledger, { name: 'Barclaycard', type: 'credit', institution: 'barclaycard', openingBalance: owed, openingDate: opening, creditCard: cc });
  return { ledger: r.ledger, current, card: r.account };
}
const spend = (ledger, card, date, amount, extra = {}) =>
  addTransaction(ledger, { accountId: card.id, date, amount, direction: 'debit', description: `Spend ${date}`, ...extra });
const ddItem = (current, card, extra = {}) => ({
  description: 'Barclaycard direct debit', kind: 'transfer', accountId: current.id, toAccountId: card.id,
  amount: 60000, everyMonths: 1, day: 12, startDate: '2026-10-01', endDate: null, shift: 'after', payStatement: true, ...extra,
});

console.log('statement and payment dates');
test('13th working day + 25 days, next working day — matches Wayne’s four real statements', () => {
  const { card } = setup();
  const real = [
    ['2026-06', '2026-06-17', '2026-07-13'], // 12 Jul is a Sunday
    ['2026-07', '2026-07-17', '2026-08-11'],
    ['2026-08', '2026-08-19', '2026-09-14'], // 13 Sep is a Sunday
    ['2026-09', '2026-09-17', '2026-10-12'],
  ];
  for (const [m, s, due] of real) {
    assert.equal(statementDate(card, m, HOL), s, `statement ${m}`);
    assert.equal(paymentDueDate(card, m, HOL), due, `due ${m}`);
  }
  assert.equal(statementDate(card, '2026-10', HOL), '2026-10-19');
  assert.equal(paymentDueDate(card, '2026-10', HOL), '2026-11-13');
});
test('payment days default to 25 when not set; no statement day = no statements', () => {
  const { card } = setup({ cc: { statementWorkingDay: 13 } });
  assert.equal(paymentDueDate(card, '2026-09', HOL), '2026-10-12');
  const { card: plain } = setup({ cc: null });
  assert.equal(statementConfig(plain), null);
  assert.equal(statementDate(plain, '2026-10', HOL), null);
});
test('an entry on the statement date is on that statement; the day after is on the next', () => {
  const { card } = setup();
  assert.equal(statementMonthByDate(card, '2026-10-19', HOL), '2026-10');
  assert.equal(statementMonthByDate(card, '2026-10-20', HOL), '2026-11');
  assert.equal(statementMonthByDate(card, '2026-10-01', HOL), '2026-10');
});
test('first statement is the first on or after the opening date', () => {
  assert.equal(firstStatementMonth(setup().card, HOL), '2026-10');
  assert.equal(firstStatementMonth(setup({ opening: '2026-10-20' }).card, HOL), '2026-11');
  assert.deepEqual(statementMonths(setup().card, '2027-01-31', HOL), ['2026-10', '2026-11', '2026-12', '2027-01']);
});

console.log('amount owed on a statement');
test('Wayne’s example: £1000 on the statement, £10 spent the same day but on the next one', () => {
  let { ledger, card } = setup({ owed: 90000 }); // £900 owed on 1 Oct
  ledger = spend(ledger, card, '2026-10-10', 10000); // -> £1000
  ledger = spend(ledger, card, '2026-10-19', 1000, { statementMonth: '2026-11' }); // statement day, carried to next
  const st = statementFor(ledger, card, '2026-10', HOL);
  assert.equal(st.owed, 100000);
  assert.equal(st.date, '2026-10-19');
  assert.equal(statementFor(ledger, card, '2026-11', HOL).owed, 101000);
});
test('moving an entry back onto an earlier statement counts it there', () => {
  let { ledger, card } = setup({ owed: 0 });
  ledger = spend(ledger, card, '2026-10-20', 2500, { statementMonth: '2026-10' });
  assert.equal(statementFor(ledger, card, '2026-10', HOL).owed, 2500);
});
test('payments and refunds reduce what’s owed; notes are ignored', () => {
  let { ledger, card, current } = setup({ owed: 50000 });
  ledger = addTransaction(ledger, { accountId: current.id, date: '2026-10-12', amount: 50000, direction: 'debit', description: 'Barclaycard direct debit', counterpartAccountId: card.id });
  ledger = addTransaction(ledger, { accountId: card.id, date: '2026-10-14', amount: 1359, direction: 'credit', description: 'Refund' });
  ledger = addTransaction(ledger, { accountId: card.id, date: '2026-10-15', amount: 0, direction: 'debit', description: 'BARCLAYCARD STATEMENT', kind: 'note' });
  ledger = spend(ledger, card, '2026-10-16', 2000);
  assert.equal(statementFor(ledger, card, '2026-10', HOL).owed, 2000 - 1359);
});
test('a statement from before the records start can’t be worked out', () => {
  const { ledger, card } = setup();
  const st = statementFor(ledger, card, '2026-09', HOL);
  assert.equal(st.beforeRecords, true);
  assert.equal(st.owed, null);
});
test('effectiveStatementMonth: own choice wins, else by date', () => {
  const { card } = setup();
  assert.equal(effectiveStatementMonth(card, { date: '2026-10-19', statementMonth: '2026-11' }, HOL), '2026-11');
  assert.equal(effectiveStatementMonth(card, { date: '2026-10-19', statementMonth: null }, HOL), '2026-10');
});

console.log('moving entries between statements');
test('boundaryChoice offers this/next statement within 3 days of a statement date only', () => {
  const { card } = setup();
  assert.deepEqual(boundaryChoice(card, '2026-10-19', HOL), { near: '2026-10', options: ['2026-10', '2026-11'], byDate: '2026-10' });
  assert.deepEqual(boundaryChoice(card, '2026-10-21', HOL), { near: '2026-10', options: ['2026-10', '2026-11'], byDate: '2026-11' });
  assert.equal(boundaryChoice(card, '2026-10-05', HOL), null);
  assert.equal(boundaryChoice(setup({ cc: null }).card, '2026-10-19', HOL), null);
  // early in a month, the previous month's statement is the near one
  assert.equal(boundaryChoice(card, '2026-09-19', HOL).near, '2026-09');
});
test('setStatementMonth sets and clears; bad months rejected', () => {
  let { ledger, card } = setup();
  ledger = spend(ledger, card, '2026-10-19', 1000);
  const id = ledger.transactions[0].id;
  ledger = setStatementMonth(ledger, id, '2026-11');
  assert.equal(ledger.transactions[0].statementMonth, '2026-11');
  ledger = setStatementMonth(ledger, id, null);
  assert.equal(ledger.transactions[0].statementMonth, null);
  assert.throws(() => setStatementMonth(ledger, id, '19 Oct'), /statement month/);
});
test('a transfer added from the card keeps its statement choice on the card leg only', () => {
  let { ledger, card, current } = setup();
  ledger = addTransaction(ledger, { accountId: card.id, date: '2026-10-19', amount: 500, direction: 'credit', description: 'Refund via current', counterpartAccountId: current.id, statementMonth: '2026-11' });
  const cardLeg = ledger.transactions.find((t) => t.accountId === card.id);
  const curLeg = ledger.transactions.find((t) => t.accountId === current.id);
  assert.equal(cardLeg.statementMonth, '2026-11');
  assert.ok(!curLeg.statementMonth);
  // editing the card leg's date keeps the other leg's (absent) choice
  ledger = updateTransaction(ledger, cardLeg.id, { date: '2026-10-20', statementMonth: null });
  assert.equal(ledger.transactions.find((t) => t.id === cardLeg.id).statementMonth, null);
});
test('card settings are validated', () => {
  const { ledger, card } = setup();
  assert.throws(() => updateAccount(ledger, card.id, { creditCard: { ...card.creditCard, statementWorkingDay: 25 } }), /1 to 20/);
  assert.throws(() => updateAccount(ledger, card.id, { creditCard: { ...card.creditCard, paymentDaysAfter: 0 } }), /1 to 60/);
  const ok = updateAccount(ledger, card.id, { creditCard: { ...card.creditCard, statementWorkingDay: null } });
  assert.equal(ok.accounts[1].creditCard.statementWorkingDay, null);
});

console.log('statement rows (display)');
test('statement row sits after the statement’s entries and before ones carried to the next', () => {
  let { ledger, card } = setup({ owed: 0 });
  ledger = spend(ledger, card, '2026-10-19', 1000, { statementMonth: '2026-11' }); // added first, but carried
  ledger = spend(ledger, card, '2026-10-19', 2000);
  const view = withStatements(ledger, '2026-10-31', HOL);
  const order = accountRunning(view, card).map((r) => r.transaction.isStatement ? `STMT ${r.transaction.statement.owed}` : r.transaction.amount);
  assert.deepEqual(order, [2000, 'STMT 2000', 1000]);
  const carried = view.transactions.find((t) => t.amount === 1000);
  assert.equal(carried.stmtTag, 'next');
  assert.equal(carried.stmtMonth, '2026-11');
  // grid follows the same order
  const rows = buildGridRows(view, view.accounts);
  assert.deepEqual(rows.map((r) => (r.statement ? 'STMT' : r.description)), ['Spend 2026-10-19', 'STMT', 'Spend 2026-10-19']);
  assert.equal(rows[2].stmtTag.tag, 'next');
});
test('statement rows don’t change balances, and none before the records start', () => {
  let { ledger, card } = setup({ owed: 50000 });
  ledger = spend(ledger, card, '2026-10-05', 1000);
  const view = withStatements(ledger, '2026-12-31', HOL);
  const stmts = view.transactions.filter((t) => t.isStatement);
  assert.deepEqual(stmts.map((t) => t.date), ['2026-10-19', '2026-11-18', '2026-12-17']);
  const running = accountRunning(view, card);
  assert.equal(running[running.length - 1].runningBalance, 51000);
});

console.log('paying the statement (recurring item)');
test('the payment pays the previous month’s statement on its due date', () => {
  let { ledger, current, card } = setup({ owed: 90000 });
  ledger = spend(ledger, card, '2026-10-05', 2000);
  ledger = spend(ledger, card, '2026-11-05', 2000);
  ledger = addRecurring(ledger, ddItem(current, card)).ledger;
  const ps = projections(ledger, '2026-12-31', HOL);
  assert.deepEqual(ps.map((p) => [p.period, p.date]), [['2026-10', '2026-10-12'], ['2026-11', '2026-11-13'], ['2026-12', '2026-12-14']]);
  // Oct pays the 17 Sep statement — before the records: the estimate
  assert.equal(ps[0].amount, 60000);
  assert.equal(ps[0].statement.beforeRecords, true);
  // Nov pays the 19 Oct statement: 900 + 20 - 600 = 320
  assert.equal(ps[1].amount, 32000);
  assert.equal(ps[1].statement.date, '2026-10-19');
});
test('realistic chain: each payment is the statement balance, and paying less carries on', () => {
  let { ledger, current, card } = setup({ owed: 80000 }); // £800 owed on 1 Oct, of which the 17 Sep statement was £600
  ledger = addRecurring(ledger, ddItem(current, card)).ledger;
  ledger = spend(ledger, card, '2026-10-05', 10000);
  ledger = spend(ledger, card, '2026-10-25', 5000);
  ledger = spend(ledger, card, '2026-11-20', 3000);
  let ps = projections(ledger, '2026-12-31', HOL);
  // Oct 12: estimate 600. Oct 19 statement: 800 + 100 - 600 = 300. Nov 18 statement: 300 + 50 - 300 = 50.
  assert.deepEqual(ps.map((p) => p.amount), [60000, 30000, 5000]);
  assert.equal(ps[1].statement.date, '2026-10-19');
  assert.equal(ps[1].statement.owed, 30000);
  // pay only £200 in November -> £100 more on the next statement
  const item = ledger.scheduledItems[0];
  ledger = setOccurrence(ledger, item.id, '2026-11', { amount: 20000 });
  ps = projections(ledger, '2026-12-31', HOL);
  assert.equal(ps[1].amount, 20000);
  assert.equal(ps[1].seriesAmount, 30000);
  assert.equal(ps[1].changed, true);
  assert.equal(ps[2].amount, 15000);
});
test('confirming uses the real amount; the next statement follows it', () => {
  let { ledger, current, card } = setup({ owed: 80000 });
  ledger = addRecurring(ledger, ddItem(current, card)).ledger;
  const item = ledger.scheduledItems[0];
  ledger = confirmOccurrence(ledger, item.id, '2026-10', { date: '2026-10-12', amount: 61234, description: 'Barclaycard direct debit' });
  const ps = projections(ledger, '2026-11-30', HOL);
  assert.deepEqual(ps.map((p) => [p.period, p.amount]), [['2026-11', 80000 - 61234]]);
});
test('a skipped payment counts nothing and the next statement includes it', () => {
  let { ledger, current, card } = setup({ owed: 80000 });
  ledger = addRecurring(ledger, ddItem(current, card)).ledger;
  const item = ledger.scheduledItems[0];
  ledger = setOccurrence(ledger, item.id, '2026-10', { skipped: true });
  const ps = projections(ledger, '2026-11-30', HOL);
  assert.equal(ps[0].skipped, true);
  assert.equal(ps[1].amount, 80000);
});
test('nothing owed -> no payment', () => {
  let { ledger, current, card } = setup({ owed: 0 });
  ledger = addRecurring(ledger, ddItem(current, card, { amount: 0, startDate: '2026-11-01' })).ledger;
  assert.deepEqual(projections(ledger, '2026-12-31', HOL), []);
});
test('projected statement payments appear in the view and its statement rows', () => {
  let { ledger, current, card } = setup({ owed: 80000 });
  ledger = addRecurring(ledger, ddItem(current, card)).ledger;
  const view = withStatements(withProjections(ledger, '2026-11-30', HOL), '2026-11-30', HOL);
  const st = view.transactions.filter((t) => t.isStatement).map((t) => t.statement.owed);
  assert.deepEqual(st, [20000, 0]);
});
test('validation: payStatement needs a transfer to a card with statements', () => {
  const { ledger, current, card } = setup({ cc: null });
  assert.throws(() => addRecurring(ledger, ddItem(current, card)), /statement date first/);
  const s = setup();
  // not a transfer: the flag is simply dropped
  assert.equal(addRecurring(s.ledger, { ...ddItem(s.current, s.card), kind: 'out' }).item.payStatement, false);
  // a zero estimate is fine for a statement payment
  assert.ok(addRecurring(s.ledger, ddItem(s.current, s.card, { amount: 0 })).item.payStatement);
});
test('turning payStatement on for an existing item keeps its confirmed months', () => {
  let { ledger, current, card } = setup({ owed: 80000 });
  ledger = addRecurring(ledger, { ...ddItem(current, card), payStatement: false }).ledger;
  const item = ledger.scheduledItems[0];
  ledger = confirmOccurrence(ledger, item.id, '2026-10', { date: '2026-10-12', amount: 60000, description: 'Barclaycard direct debit' });
  ledger = updateRecurring(ledger, item.id, { payStatement: true });
  const ps = projections(ledger, '2026-12-31', HOL);
  // October stays the confirmed one; November pays the rest of the 19 Oct statement; nothing left for December
  assert.deepEqual(ps.map((p) => [p.period, p.amount]), [['2026-11', 20000]]);
});
test('if the card’s statement day is removed, the item falls back to a plain monthly one', () => {
  let { ledger, current, card } = setup();
  ledger = addRecurring(ledger, ddItem(current, card)).ledger;
  ledger = updateAccount(ledger, card.id, { creditCard: { ...card.creditCard, statementWorkingDay: null } });
  const ps = projections(ledger, '2026-11-30', HOL);
  assert.deepEqual(ps.map((p) => [p.date, p.amount]), [['2026-10-12', 60000], ['2026-11-12', 60000]]);
});
test('upcomingDates and describeRule for a statement payment', () => {
  const { current, card } = setup();
  const item = { ...ddItem(current, card), id: 'x' };
  assert.deepEqual(upcomingDates(item, '2026-10-06', 3, HOL, card), ['2026-10-12', '2026-11-13', '2026-12-14']);
  assert.match(describeRule(item, card), /Statement balance · 25 days after/);
});

console.log('sync and export carry the new fields');
test('export/import round trip keeps statement settings, choices and payStatement', () => {
  let { ledger, current, card } = setup();
  ledger = spend(ledger, card, '2026-10-19', 1000, { statementMonth: '2026-11' });
  ledger = addRecurring(ledger, ddItem(current, card)).ledger;
  const back = parseImport(JSON.stringify(buildExport(ledger))).ledger;
  assert.equal(back.accounts[1].creditCard.statementWorkingDay, 13);
  assert.equal(back.accounts[1].creditCard.paymentDaysAfter, 25);
  assert.equal(back.transactions[0].statementMonth, '2026-11');
  assert.equal(back.scheduledItems[0].payStatement, true);
});
test('a statement choice made on one device merges with other edits', () => {
  let { ledger, card } = setup();
  ledger = spend(ledger, card, '2026-10-19', 1000);
  const base = ledger;
  const id = ledger.transactions[0].id;
  const local = setStatementMonth(base, id, '2026-11');
  const remote = spend(base, card, '2026-10-20', 500);
  const { merged, groups } = prepareMerge({ base, local, remote });
  assert.equal(groups.length, 0);
  assert.equal(merged.transactions.find((t) => t.id === id).statementMonth, '2026-11');
  assert.equal(merged.transactions.length, 2);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
