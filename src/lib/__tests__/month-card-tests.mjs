// Run with: node src/lib/__tests__/month-card-tests.mjs
// v0.15.26: the "This month" card on the phone Summary (Wayne, 27 Nov).
import assert from 'node:assert/strict';
import { emptyLedger, addAccount, addTransaction } from '../ops.js';
import { addRecurring, updateRecurring, withProjections, setOccurrence, confirmOccurrence } from '../schedule.js';
import {
  payItemIds, nextPayday, daysUntil, leftUntilPayday, spentBetween, spentThisMonth, spendComparison, comingUp, allWarnings,
} from '../month-card.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); } catch (err) { failed++; console.log(`  FAIL - ${name}`); console.log(`    ${err.stack}`); }
}
const HOL = new Set(['2026-12-25', '2026-12-28']); // Christmas, Boxing Day substitute
const TO = '2027-03-31';
const view = (l, today) => withProjections(l, TO, HOL, { today });

function setup() {
  let r = addAccount(emptyLedger(), { name: 'Current Account', type: 'current', institution: 'other', openingBalance: 100000, openingDate: '2026-10-01' });
  const current = r.account;
  r = addAccount(r.ledger, { name: 'Barclaycard', type: 'credit', institution: 'barclaycard', openingBalance: 0, openingDate: '2026-10-01' });
  const card = r.account;
  r = addAccount(r.ledger, { name: 'Pots', type: 'savings', institution: 'monzo', openingBalance: 0, openingDate: '2026-10-01' });
  const pots = r.account;
  r = addAccount(r.ledger, { name: 'Klarna', type: 'loan', institution: 'klarna', openingBalance: -30000, openingDate: '2026-10-01' });
  return { ledger: r.ledger, current, card, pots, loan: r.account };
}
const item = (l, f) => addRecurring(l, {
  kind: 'out', everyMonths: 1, everyDays: null, shift: 'none', startDate: '2026-10-01', endDate: null,
  finalAmount: null, firstNumber: 1, envelopeSplits: null, ...f,
});
const salary = (l, accountId, extra = {}) => item(l, { description: 'Salary', kind: 'in', accountId, amount: 250000, day: 28, shift: 'before', isPay: true, ...extra });
const spend = (l, accountId, amount, date, extra = {}) => addTransaction(l, { accountId, date, amount, direction: 'debit', description: 'x', ...extra });

console.log('pay');
test('isPay is kept only on money in', () => {
  const s = setup();
  const a = salary(s.ledger, s.current.id);
  assert.equal(a.item.isPay, true);
  const b = item(a.ledger, { description: 'Rent', accountId: s.current.id, amount: 1000, day: 1, isPay: true });
  assert.equal(b.item.isPay, false);
  assert.deepEqual([...payItemIds(b.ledger)], [a.item.id]);
  const c = updateRecurring(b.ledger, a.item.id, { isPay: false });
  assert.equal(payItemIds(c).size, 0);
});

test('payday: 28th, or the working day before (Sat 28 Nov 2026 → Fri 27 Nov)', () => {
  const s = setup();
  const { ledger } = salary(s.ledger, s.current.id);
  const p = nextPayday(view(ledger, '2026-11-20'), '2026-11-20');
  assert.equal(p.date, '2026-11-27');
  assert.equal(p.accountId, s.current.id);
  assert.equal(daysUntil('2026-11-20', p.date), 7);
  // December: the 28th is the Boxing Day substitute bank holiday, 26–27 a weekend, 25 Christmas → Thu 24 Dec
  assert.equal(nextPayday(view(ledger, '2026-12-01'), '2026-12-01').date, '2026-12-24');
});

test('Alison: day 31 = the last day of each month, brought forward to a working day', () => {
  const s = setup();
  const { ledger } = salary(s.ledger, s.current.id, { day: 31 });
  assert.equal(nextPayday(view(ledger, '2026-11-02'), '2026-11-02').date, '2026-11-30');
  assert.equal(nextPayday(view(ledger, '2027-01-02'), '2027-01-02').date, '2027-01-29'); // Sun 31 Jan → Fri 29
  assert.equal(nextPayday(view(ledger, '2027-02-02'), '2027-02-02').date, '2027-02-26'); // Sun 28 Feb → Fri 26
});

test('pay today: counted to the next one; a skipped month is passed over', () => {
  const s = setup();
  let { ledger, item: pay } = salary(s.ledger, s.current.id);
  let p = nextPayday(view(ledger, '2026-11-27'), '2026-11-27');
  assert.equal(p.isToday, true);
  assert.equal(p.date, '2026-12-24');
  ledger = confirmOccurrence(ledger, pay.id, '2026-11', { date: '2026-11-27', amount: 250000, description: 'Salary' });
  p = nextPayday(view(ledger, '2026-11-27'), '2026-11-27');
  assert.equal(p.isToday, true);
  ledger = setOccurrence(ledger, pay.id, '2026-12', { skipped: true });
  assert.equal(nextPayday(view(ledger, '2026-11-28'), '2026-11-28').date, '2027-01-28');
});

test('no pay ticked → no payday', () => {
  const s = setup();
  const { ledger } = salary(s.ledger, s.current.id, { isPay: false });
  assert.equal(nextPayday(view(ledger, '2026-11-20'), '2026-11-20'), null);
});

test('left until payday = projected balance at the end of the day before', () => {
  const s = setup();
  let { ledger } = salary(s.ledger, s.current.id);
  ledger = item(ledger, { description: 'Gas', accountId: s.current.id, amount: 5000, day: 26 }).ledger;
  ledger = spend(ledger, s.current.id, 2000, '2026-11-10');
  const v = view(ledger, '2026-11-20');
  const left = leftUntilPayday(v, nextPayday(v, '2026-11-20'));
  assert.equal(left.date, '2026-11-26');
  // 1000.00 + Oct salary 2500 − Oct gas 50 − 20 − Nov gas 50 (on the 26th, counted)
  assert.equal(left.balance, 100000 + 250000 - 5000 - 2000 - 5000);
});

console.log('spent');
test('spend: outside the accounts only; card spends count; transfers, notes and projections don’t', () => {
  const s = setup();
  let l = s.ledger;
  l = spend(l, s.current.id, 1000, '2026-11-02');                                    // counts
  l = spend(l, s.card.id, 2500, '2026-11-03');                                       // counts
  l = spend(l, s.current.id, 30000, '2026-11-04', { counterpartAccountId: s.card.id }); // card payment: no
  l = spend(l, s.current.id, 5000, '2026-11-05', { counterpartAccountId: s.pots.id });  // pot move: no
  l = spend(l, s.loan.id, 700, '2026-11-06');                                         // Klarna purchase: counts
  l = addTransaction(l, { accountId: s.card.id, date: '2026-11-07', amount: 500, direction: 'credit', description: 'refund' }); // −
  l = addTransaction(l, { accountId: s.current.id, date: '2026-11-08', amount: 9999, direction: 'credit', description: 'gift' }); // money in: no
  l = addTransaction(l, { accountId: s.current.id, date: '2026-11-09', amount: 0, direction: 'debit', description: 'In Greece', kind: 'note' });
  l = spend(l, s.current.id, 1234, '2026-10-30');                                     // last month
  l = item(l, { description: 'Gas', accountId: s.current.id, amount: 5000, day: 15 }).ledger; // projected: no
  const ids = l.accounts.map((a) => a.id);
  const v = view(l, '2026-11-20');
  assert.equal(spentThisMonth(v, ids, '2026-11-20'), 1000 + 2500 + 700 - 500);
  assert.equal(spentBetween(l, ids, '2026-11-01', '2026-11-02'), 1000);
});

test('comparison: none in the first month; last month to the same day; three-month average from the fourth', () => {
  const s = setup();
  let l = s.ledger;
  const ids = l.accounts.map((a) => a.id);
  assert.equal(spendComparison(l, ids, '2026-10-20'), null);
  l = spend(l, s.current.id, 1000, '2026-10-05');
  l = spend(l, s.current.id, 9000, '2026-10-25'); // after the 20th: not in "to the same day"
  l = spend(l, s.current.id, 3000, '2026-11-03');
  let c = spendComparison(l, ids, '2026-11-20');
  assert.deepEqual(c, { basis: 'last-month', usual: 1000, diff: 2000 });
  l = spend(l, s.current.id, 2000, '2026-12-04');
  assert.equal(spendComparison(l, ids, '2026-12-20').basis, 'last-month'); // Oct + Nov only
  l = spend(l, s.current.id, 500, '2027-01-02');
  c = spendComparison(l, ids, '2027-01-20');
  assert.equal(c.basis, 'three-months');
  assert.equal(c.usual, Math.round((1000 + 3000 + 2000) / 3));
  assert.equal(c.diff, 500 - 2000);
});

test('comparison: a month that started part-way isn’t a full month; 31st compares with 28 Feb', () => {
  let r = addAccount(emptyLedger(), { name: 'A', type: 'current', institution: 'other', openingBalance: 0, openingDate: '2026-12-15' });
  let l = r.ledger;
  const ids = [r.account.id];
  assert.equal(spendComparison(l, ids, '2027-01-20'), null);
  l = spend(l, r.account.id, 700, '2027-02-28');
  assert.equal(spendComparison(l, ids, '2027-03-31').usual, 700);
});

console.log('coming up');
test('next 7 days: bills and card/loan payments; not pot moves, card spends or today’s confirmed entries', () => {
  const s = setup();
  let l = s.ledger;
  l = item(l, { description: 'Netflix', accountId: s.current.id, amount: 1099, day: 22 }).ledger;
  l = item(l, { description: 'To pots', kind: 'transfer', accountId: s.current.id, toAccountId: s.pots.id, amount: 5000, day: 23 }).ledger;
  l = item(l, { description: 'Barclaycard', kind: 'transfer', accountId: s.current.id, toAccountId: s.card.id, amount: 20000, day: 24 }).ledger;
  l = item(l, { description: 'Klarna', kind: 'transfer', accountId: s.current.id, toAccountId: s.loan.id, amount: 3000, day: 25 }).ledger;
  l = item(l, { description: 'Later', accountId: s.current.id, amount: 100, day: 27 }).ledger; // 21+6 = 27: last day in
  l = item(l, { description: 'Too late', accountId: s.current.id, amount: 100, day: 28 }).ledger;
  l = spend(l, s.card.id, 999, '2026-11-23', { description: 'Card spend' });
  l = spend(l, s.current.id, 888, '2026-11-21', { description: 'Already paid today' });
  l = spend(l, s.current.id, 777, '2026-11-26', { description: 'Typed in ahead' });
  const got = comingUp(view(l, '2026-11-21'), '2026-11-21').map((t) => t.description);
  assert.deepEqual(got, ['Netflix', 'Barclaycard', 'Klarna', 'Typed in ahead', 'Later']);
});

test('skipped months are left out', () => {
  const s = setup();
  let { ledger: l, item: it } = item(s.ledger, { description: 'Netflix', accountId: s.current.id, amount: 1099, day: 22 });
  l = setOccurrence(l, it.id, '2026-11', { skipped: true });
  assert.equal(comingUp(view(l, '2026-11-21'), '2026-11-21').length, 0);
});

console.log('warnings');
test('warnings: every account, soonest first', () => {
  let r = addAccount(emptyLedger(), { name: 'Current', type: 'current', institution: 'other', openingBalance: 1000, openingDate: '2026-10-01', overdraftLimit: 50000 });
  const cur = r.account;
  r = addAccount(r.ledger, { name: 'Card', type: 'credit', institution: 'barclaycard', openingBalance: 0, openingDate: '2026-10-01', creditLimit: 1000 });
  let l = r.ledger;
  l = item(l, { description: 'Rent', accountId: cur.id, amount: 5000, day: 25, startDate: '2026-11-01' }).ledger;
  l = spend(l, r.account.id, 2000, '2026-11-22');
  const v = view(l, '2026-11-21');
  const w = allWarnings(v, v.accounts, '2026-11-21', '2026-12-31');
  assert.deepEqual(w.map((x) => [x.account.name, x.level, x.date]), [['Card', 'over-credit-limit', '2026-11-22'], ['Current', 'overdraft', '2026-11-25']]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
