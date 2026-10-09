// Run with: node src/lib/__tests__/limits-tests.mjs
// v0.14 limits (Wayne, 8 Oct): overdraft limit, card credit limit, warnings
// (never blocks) for a change that takes an account past a line within the
// dates shown; loan / credit accounts shown as owed, with transfers OUT blocked.
import assert from 'node:assert/strict';
import {
  emptyLedger, addAccount, addTransaction, updateTransaction, updateAccount, balanceAsOf, accountBalances, displayOpening, toDisplay, signedOpening,
} from '../ops.js';
import { addRecurring, setOccurrence, withProjections } from '../schedule.js';
import { reconcileScope } from '../reconcile.js';
import { envelopeBalances } from '../envelopes.js';
import {
  balanceLevel, balanceProblems, newLimitProblems, isLoan, showsOwed, LoanTransferError, cleanLimit,
} from '../limits.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); } catch (err) { failed++; console.log(`  FAIL - ${name}`); console.log(`    ${err.stack}`); }
}
const HOL = new Set();
const TODAY = '2026-10-08';
const TO = '2027-01-31';
const view = (l) => withProjections(l, TO, HOL, { today: TODAY });

function setup({ overdraftLimit = null, creditLimit = null } = {}) {
  let r = addAccount(emptyLedger(), { name: 'Current Account', type: 'current', institution: 'other', openingBalance: 10000, openingDate: '2026-10-01', overdraftLimit });
  const current = r.account;
  r = addAccount(r.ledger, { name: 'Barclaycard', type: 'credit', institution: 'barclaycard', openingBalance: 250000, openingDate: '2026-10-01', creditLimit });
  const card = r.account;
  r = addAccount(r.ledger, { name: 'Car loan', type: 'loan', institution: 'other', openingBalance: -480000, openingDate: '2026-10-01' });
  return { ledger: r.ledger, current, card, loan: r.account };
}
const out = (l, accountId, amount, date, description = 'x', extra = {}) =>
  addTransaction(l, { accountId, date, amount, direction: 'debit', description, ...extra });

console.log('lines');
test('current account: below £0 = overdrawn; with an overdraft, into it / past it', () => {
  const a = { type: 'current' };
  assert.equal(balanceLevel(a, 0), null);
  assert.equal(balanceLevel(a, -1), 'overdrawn');
  const od = { type: 'current', overdraftLimit: 50000 };
  assert.equal(balanceLevel(od, -100), 'overdraft');
  assert.equal(balanceLevel(od, -50000), 'overdraft');
  assert.equal(balanceLevel(od, -50001), 'past-overdraft');
});
test('card: over the credit limit only when it has one; loans never warn', () => {
  assert.equal(balanceLevel({ type: 'credit', creditLimit: 300000 }, 300001), 'over-credit-limit');
  assert.equal(balanceLevel({ type: 'credit', creditLimit: 300000 }, 300000), null);
  assert.equal(balanceLevel({ type: 'credit' }, 9999999), null);
  assert.equal(balanceLevel({ type: 'loan' }, -480000), null);
  assert.equal(balanceLevel({ type: 'loan' }, 480000), null);
});
test('limits are cleaned: blank = none, negative refused, wrong type dropped', () => {
  assert.equal(cleanLimit('', 'x'), null);
  assert.equal(cleanLimit(0, 'x'), null);
  assert.throws(() => cleanLimit(-1, 'Overdraft limit'), /£0.00 or more/);
  const s = setup({ overdraftLimit: 50000, creditLimit: 300000 });
  assert.equal(s.current.overdraftLimit, 50000);
  assert.equal(s.card.creditLimit, 300000);
  const l = updateAccount(s.ledger, s.card.id, { overdraftLimit: 1000 });
  assert.equal(l.accounts.find((a) => a.id === s.card.id).overdraftLimit, null, 'a card has no overdraft');
});

console.log('warnings when saving');
test('Wayne’s example: today 8 Oct, an entry for tomorrow, overdrawn on 20 Oct because of a recurring bill', () => {
  const s = setup();
  const { ledger } = addRecurring(s.ledger, { description: 'Council tax', kind: 'out', accountId: s.current.id, toAccountId: null, amount: 5000, everyMonths: 1, day: 20, startDate: '2026-10-01', endDate: null, shift: 'none' });
  const after = out(ledger, s.current.id, 6000, '2026-10-09', 'Shopping');
  const w = newLimitProblems(view(ledger), view(after), TODAY, TO);
  assert.equal(w.length, 1);
  assert.equal(w[0].level, 'overdrawn');
  assert.equal(w[0].date, '2026-10-20');
  assert.equal(w[0].balance, -1000);
  assert.equal(w[0].account.name, 'Current Account');
});
test('with an overdraft: "into it" first, then the stronger "past it" on a later date', () => {
  const s = setup({ overdraftLimit: 5000 });
  let l = out(s.ledger, s.current.id, 12000, '2026-10-10');
  l = out(l, s.current.id, 4000, '2026-10-25');
  const w = newLimitProblems(view(s.ledger), view(l), TODAY, TO);
  assert.deepEqual(w.map((x) => [x.level, x.date, x.balance, x.limit]), [['overdraft', '2026-10-10', -2000, 5000], ['past-overdraft', '2026-10-25', -6000, 5000]]);
});
test('a card going over its credit limit warns; with no limit set it doesn’t', () => {
  const s = setup({ creditLimit: 260000 });
  const l = out(s.ledger, s.card.id, 20000, '2026-10-12', 'TV');
  assert.equal(newLimitProblems(view(s.ledger), view(l), TODAY, TO)[0].level, 'over-credit-limit');
  const n = setup();
  assert.equal(newLimitProblems(view(n.ledger), view(out(n.ledger, n.card.id, 20000, '2026-10-12')), TODAY, TO).length, 0);
});
test('a transfer warns about the account the money comes OUT of', () => {
  const s = setup();
  const l = addTransaction(s.ledger, { accountId: s.current.id, date: '2026-10-09', amount: 20000, direction: 'debit', description: 'Pay card', counterpartAccountId: s.card.id });
  const w = newLimitProblems(view(s.ledger), view(l), TODAY, TO);
  assert.deepEqual(w.map((x) => x.account.name), ['Current Account']);
});
test('v0.14.1: a big card spend → the knock-on warning on the current account names the card payment as the cause', () => {
  const s = setup({ creditLimit: 300000 });
  let l = updateAccount(s.ledger, s.card.id, { creditCard: { ...s.card.creditCard, statementWorkingDay: 13, paymentDaysAfter: 25 } });
  ({ ledger: l } = addRecurring(l, { description: 'Barclaycard payment', kind: 'transfer', accountId: s.current.id, toAccountId: s.card.id,
    amount: 0, everyMonths: 1, day: 12, startDate: '2026-10-01', endDate: null, shift: 'after', payStatement: true }));
  const after = out(l, s.card.id, 99999900, '2026-10-09', 'Test spend');
  const w = newLimitProblems(view(l), view(after), TODAY, TO);
  const card = w.find((x) => x.account.id === s.card.id);
  const cur = w.find((x) => x.account.id === s.current.id);
  assert.equal(card.level, 'over-credit-limit');
  assert.equal(card.date, '2026-10-09');
  assert.equal(cur.level, 'overdrawn');
  assert.ok(cur.date > '2026-11-01', `on the card payment date, not the spend day (${cur.date})`);
  assert.equal(cur.cause.description, 'Barclaycard payment');
  assert.equal(cur.cause.isProjected, true);
});

test('v0.14.1: already overdrawn for other reasons → the knock-on is reported on the day THIS change makes it worse, with what it was', () => {
  const s = setup();
  let l = updateAccount(s.ledger, s.card.id, { creditCard: { ...s.card.creditCard, statementWorkingDay: 13, paymentDaysAfter: 25 } });
  ({ ledger: l } = addRecurring(l, { description: 'Barclaycard payment', kind: 'transfer', accountId: s.current.id, toAccountId: s.card.id,
    amount: 0, everyMonths: 1, day: 12, startDate: '2026-10-01', endDate: null, shift: 'after', payStatement: true }));
  l = out(l, s.current.id, 15000, '2026-10-10', 'Taxi'); // overdrawn from 10 Oct already
  const after = out(l, s.card.id, 500000, '2026-10-09', 'Test spend');
  const cur = newLimitProblems(view(l), view(after), TODAY, TO).filter((x) => x.account.id === s.current.id);
  assert.equal(cur.length, 1);
  assert.ok(cur[0].date > '2026-11-01', `not the old 10 Oct date (${cur[0].date})`);
  assert.equal(cur[0].cause.description, 'Barclaycard payment');
  assert.ok(cur[0].was < 0 && cur[0].balance < cur[0].was, 'reports what it was and how much worse');
});

test('only warns about what THIS change does: an existing overdrawn day isn’t nagged about on an unrelated save', () => {
  const s = setup();
  const already = out(s.ledger, s.current.id, 15000, '2026-10-20');
  const unrelated = out(already, s.card.id, 1000, '2026-10-11');
  assert.equal(newLimitProblems(view(already), view(unrelated), TODAY, TO).length, 0);
  const deeper = out(already, s.current.id, 100, '2026-10-21');
  assert.equal(newLimitProblems(view(already), view(deeper), TODAY, TO).length, 1, 'making it worse warns again');
  const earlier = out(already, s.current.id, 20000, '2026-10-15');
  assert.equal(newLimitProblems(view(already), view(earlier), TODAY, TO)[0].date, '2026-10-15', 'an earlier date warns again');
});
test('only as far ahead as the screen shows; skipped months count nothing', () => {
  const s = setup();
  const { ledger, item } = addRecurring(s.ledger, { description: 'Big bill', kind: 'out', accountId: s.current.id, toAccountId: null, amount: 20000, everyMonths: 1, day: 5, startDate: '2027-03-01', endDate: null, shift: 'none' });
  assert.equal(newLimitProblems(view(s.ledger), view(ledger), TODAY, TO).length, 0, 'March 2027 is past the shown dates');
  const longer = withProjections(ledger, '2027-04-30', HOL, { today: TODAY });
  assert.equal(newLimitProblems(withProjections(s.ledger, '2027-04-30', HOL, { today: TODAY }), longer, TODAY, '2027-04-30').length, 1, 'show more → it appears');
  const skipped = setOccurrence(ledger, item.id, '2027-03', { skipped: true });
  const pr = balanceProblems(withProjections(skipped, '2027-03-31', HOL, { today: TODAY }), s.current, TODAY, '2027-03-31');
  assert.equal(pr, null);
});
test('already overdrawn today counts (from today, not only future dates)', () => {
  const s = setup();
  const l = out(s.ledger, s.current.id, 11000, TODAY);
  assert.equal(newLimitProblems(view(s.ledger), view(l), TODAY, TO)[0].date, TODAY);
});

console.log('loan / credit accounts');
test('stored as a negative balance, shown as owed; repayments bring it down', () => {
  const s = setup();
  assert.equal(isLoan(s.loan), true);
  assert.equal(showsOwed(s.loan), true);
  assert.equal(s.loan.openingBalance, -480000, 'stored exactly as before (so an older version still reads it right)');
  assert.equal(displayOpening(s.loan), 480000);
  const l = addTransaction(s.ledger, { accountId: s.current.id, date: '2026-10-09', amount: 20000, direction: 'debit', description: 'Loan repayment', counterpartAccountId: s.loan.id });
  assert.equal(balanceAsOf(l, s.loan, '2026-10-31'), 460000);
  assert.equal(accountBalances(s.ledger)[s.loan.id], 480000);
  // what v0.13.2 would show: it treats an unknown type like a current account
  assert.equal(signedOpening(s.loan), -480000);
});
test('interest or a charge is an ordinary entry on any date', () => {
  const s = setup();
  const l = out(s.ledger, s.loan.id, 1250, '2026-10-31', 'Interest');
  assert.equal(balanceAsOf(l, s.loan, '2026-10-31'), 481250);
});
test('BLOCKED: a transfer out of a loan, from either side', () => {
  const s = setup();
  assert.throws(() => addTransaction(s.ledger, { accountId: s.loan.id, date: '2026-10-09', amount: 100, direction: 'debit', description: 'x', counterpartAccountId: s.current.id }), LoanTransferError);
  assert.throws(() => addTransaction(s.ledger, { accountId: s.current.id, date: '2026-10-09', amount: 100, direction: 'credit', description: 'x', counterpartAccountId: s.loan.id }), LoanTransferError);
});
test('BLOCKED: turning a repayment round so it takes money out of the loan', () => {
  const s = setup();
  const l = addTransaction(s.ledger, { accountId: s.current.id, date: '2026-10-09', amount: 20000, direction: 'debit', description: 'Repay', counterpartAccountId: s.loan.id });
  const leg = l.transactions.find((t) => t.accountId === s.current.id && t.transferId);
  assert.throws(() => updateTransaction(l, leg.id, { direction: 'credit' }), LoanTransferError);
  assert.doesNotThrow(() => updateTransaction(l, leg.id, { amount: 25000 }));
});
test('BLOCKED: a recurring transfer out of a loan; recurring repayments in are fine', () => {
  const s = setup();
  const base = { description: 'Loan', kind: 'transfer', amount: 20000, everyMonths: 1, day: 1, startDate: '2026-11-01', endDate: null, shift: 'none' };
  assert.throws(() => addRecurring(s.ledger, { ...base, accountId: s.loan.id, toAccountId: s.current.id }), LoanTransferError);
  assert.doesNotThrow(() => addRecurring(s.ledger, { ...base, accountId: s.current.id, toAccountId: s.loan.id }));
});
test('changing an account into a loan: refused while something transfers out of it; else no amounts change', () => {
  const s = setup();
  let r = addAccount(s.ledger, { name: 'Very', type: 'current', institution: 'very', openingBalance: -60000, openingDate: '2026-10-01' });
  const very = r.account;
  const ok = updateAccount(r.ledger, very.id, { type: 'loan' });
  const after = ok.accounts.find((a) => a.id === very.id);
  assert.equal(after.openingBalance, -60000);
  assert.equal(balanceAsOf(ok, after, '2026-10-31'), 60000, 'now shown as owed');
  const withOut = addTransaction(r.ledger, { accountId: very.id, date: '2026-10-05', amount: 100, direction: 'debit', description: 'x', counterpartAccountId: s.current.id });
  assert.throws(() => updateAccount(withOut, very.id, { type: 'loan' }), /1 transfer out/);
});
test('v0.14.1: a loan can use envelopes; converting an envelope account keeps every figure', () => {
  const s = setup();
  let r = addAccount(s.ledger, { name: 'Klarna', type: 'current', institution: 'klarna', openingBalance: -30000, openingDate: '2026-10-01',
    envelopes: { enabled: true, list: [{ id: 'sofa', name: 'Sofa', openingBalance: -20000, hidden: false }, { id: 'laptop', name: 'Laptop', openingBalance: -10000, hidden: false }] } });
  const k = r.account;
  let l = addTransaction(r.ledger, { accountId: s.current.id, date: '2026-10-09', amount: 5000, direction: 'debit', description: 'Klarna repayment',
    counterpartAccountId: k.id, counterpartEnvelopeSplits: [{ envelopeId: 'sofa', amount: 5000 }] });
  const before = envelopeBalances(l, k, '2026-10-31');
  const converted = updateAccount(l, k.id, { type: 'loan' });
  const loan = converted.accounts.find((a) => a.id === k.id);
  assert.equal(loan.type, 'loan');
  assert.deepEqual(loan.envelopes, k.envelopes, 'envelopes kept exactly');
  assert.deepEqual(envelopeBalances(converted, loan, '2026-10-31'), before, 'stored envelope figures unchanged');
  assert.equal(before.byId.sofa, -15000, 'Sofa still owes £150 (shown as owed)');
  assert.equal(balanceAsOf(converted, loan, '2026-10-31'), 25000, 'account shown as owed £250');
  // a new loan with envelopes, and a charge into one envelope
  const n = addAccount(s.ledger, { name: 'Flex', type: 'loan', institution: 'monzoflex', openingBalance: -10000, openingDate: '2026-10-01',
    envelopes: { enabled: true, list: [{ id: 'tv', name: 'TV', openingBalance: -10000, hidden: false }] } });
  const withCharge = addTransaction(n.ledger, { accountId: n.account.id, date: '2026-10-20', amount: 500, direction: 'debit', description: 'Late fee', envelopeSplits: [{ envelopeId: 'tv', amount: 500 }] });
  assert.equal(envelopeBalances(withCharge, n.account, '2026-10-31').byId.tv, -10500);
  // still no transfers out, envelopes or not
  assert.throws(() => addTransaction(converted, { accountId: k.id, date: '2026-10-10', amount: 100, direction: 'debit', description: 'x', counterpartAccountId: s.current.id, envelopeSplits: [{ envelopeId: 'sofa', amount: 100 }] }), LoanTransferError);
});

test('reconciling a loan compares the amount owed', () => {
  const s = setup();
  const scope = reconcileScope(s.ledger, s.loan, { toDate: '2026-10-31' }, HOL);
  assert.equal(scope.opening, 480000);
  assert.equal(scope.tickedBalance, 480000);
  assert.equal(toDisplay(s.loan, -480000), 480000);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
