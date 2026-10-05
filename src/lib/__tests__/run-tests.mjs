// Minimal test runner: no dependencies, just Node's built-in assert.
// Run with: node src/lib/__tests__/run-tests.mjs
// All amounts are integer pence.
import assert from 'node:assert/strict';
import {
  sortForBalance,
  calculateRunningBalance,
  currentBalance,
  findPassthroughCandidates,
  calculateEnvelopeBalances,
} from '../balances.js';
import { createTransfer } from '../ledger.js';

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
    console.log(`    ${err.message}`);
  }
}

function tx(overrides) {
  return {
    id: overrides.id ?? Math.random().toString(36).slice(2),
    accountId: 'acc-1',
    date: overrides.date,
    amount: overrides.amount,
    direction: overrides.direction,
    description: overrides.description ?? '',
    category: overrides.category ?? null,
    kind: overrides.kind ?? 'transaction',
    transferId: overrides.transferId ?? null,
    envelopeSplits: overrides.envelopeSplits ?? null,
    scheduledItemId: overrides.scheduledItemId ?? null,
    isProjected: overrides.isProjected ?? false,
  };
}

console.log('sortForBalance');
test('orders by date first', () => {
  const a = tx({ date: '2026-01-02', amount: 1000, direction: 'credit' });
  const b = tx({ date: '2026-01-01', amount: 1000, direction: 'credit' });
  assert.deepEqual(sortForBalance([a, b]), [b, a]);
});

test('same-day credits before debits', () => {
  const debit = tx({ date: '2026-01-01', amount: 5000, direction: 'debit', description: 'Rent' });
  const credit = tx({ date: '2026-01-01', amount: 5000, direction: 'credit', description: 'Salary' });
  const sorted = sortForBalance([debit, credit]);
  assert.equal(sorted[0].description, 'Salary');
  assert.equal(sorted[1].description, 'Rent');
});

test('stable for same date + direction', () => {
  const a = tx({ date: '2026-01-01', amount: 500, direction: 'debit', description: 'first' });
  const b = tx({ date: '2026-01-01', amount: 500, direction: 'debit', description: 'second' });
  assert.deepEqual(sortForBalance([a, b]).map((t) => t.description), ['first', 'second']);
});

console.log('calculateRunningBalance / currentBalance');
test('same-day credit applied before debit avoids artificial negative', () => {
  const opening = 2000;
  const debit = tx({ date: '2026-01-01', amount: 5000, direction: 'debit', description: 'Rent' });
  const credit = tx({ date: '2026-01-01', amount: 5000, direction: 'credit', description: 'Salary' });
  const result = calculateRunningBalance([debit, credit], opening);
  assert.equal(result[0].runningBalance, 7000);
  assert.equal(result[1].runningBalance, 2000);
  assert.equal(currentBalance([debit, credit], opening), 2000);
});

test('realistic multi-entry month matches expected total exactly (no float drift)', () => {
  const transactions = [
    tx({ date: '2026-01-01', amount: 46200, direction: 'debit', description: 'Train/Parking/Petrol' }),
    tx({ date: '2026-01-01', amount: 185000, direction: 'debit', description: 'To bills account' }),
    tx({ date: '2026-01-12', amount: 70000, direction: 'debit', description: 'Barclaycard direct debit' }),
    tx({ date: '2026-01-28', amount: 400000, direction: 'credit', description: 'Salary' }),
    tx({ date: '2026-01-31', amount: 60, direction: 'credit', description: 'Interest' }),
  ];
  const expected = 360000 - 46200 - 185000 - 70000 + 400000 + 60;
  assert.equal(currentBalance(transactions, 360000), expected);
});

test('the spreadsheet drift case: 3600 - 57.99 - ... stays exact', () => {
  // From Budget.xlsx: 3600 - 57.99 + ... reached 1366.0100000000002 in floats.
  const debits = [5799, 25000, 46200, 1500, 100, 185000];
  const credits = [20000, 20200];
  const transactions = [
    ...debits.map((amount) => tx({ date: '2026-01-01', amount, direction: 'debit' })),
    ...credits.map((amount) => tx({ date: '2026-01-01', amount, direction: 'credit' })),
  ];
  assert.equal(currentBalance(transactions, 360000), 136601);
});

console.log('findPassthroughCandidates');
test('flags same-day same-amount opposite-direction pairs', () => {
  const credit = tx({ date: '2026-01-28', amount: 400000, direction: 'credit', description: 'Salary (sent to Chase)' });
  const debit = tx({ date: '2026-01-28', amount: 400000, direction: 'debit', description: 'Salary (sent to Chase)' });
  const unrelated = tx({ date: '2026-01-29', amount: 1500, direction: 'debit', description: 'Lottery' });
  const pairs = findPassthroughCandidates([credit, debit, unrelated]);
  assert.equal(pairs.length, 1);
  assert.deepEqual(pairs[0], [credit, debit]);
});

test('does not pair different amounts', () => {
  const credit = tx({ date: '2026-01-01', amount: 10000, direction: 'credit' });
  const debit = tx({ date: '2026-01-01', amount: 9900, direction: 'debit' });
  assert.equal(findPassthroughCandidates([credit, debit]).length, 0);
});

test('ignores note rows', () => {
  const a = tx({ date: '2026-01-01', amount: 0, direction: 'credit', kind: 'note' });
  const b = tx({ date: '2026-01-01', amount: 0, direction: 'debit', kind: 'note' });
  assert.equal(findPassthroughCandidates([a, b]).length, 0);
});

console.log('calculateEnvelopeBalances');
test('splits transaction across envelopes (Transport/Health/Maintenance pattern)', () => {
  const envelopeNames = ['Maintenance', 'Health', 'Transport'];
  const transactions = [
    tx({
      date: '2026-02-28',
      amount: 79238,
      direction: 'credit',
      envelopeSplits: [
        { envelopeName: 'Maintenance', amount: 12172 },
        { envelopeName: 'Health', amount: 20866 },
        { envelopeName: 'Transport', amount: 46200 },
      ],
    }),
    tx({
      date: '2026-03-10',
      amount: 27400,
      direction: 'debit',
      envelopeSplits: [
        { envelopeName: 'Health', amount: 12000 },
        { envelopeName: 'Transport', amount: 15400 },
      ],
    }),
  ];
  const balances = calculateEnvelopeBalances(transactions, envelopeNames);
  assert.equal(balances.Maintenance, 12172);
  assert.equal(balances.Health, 8866);
  assert.equal(balances.Transport, 30800);
});

test('ignores transactions with no envelopeSplits', () => {
  const transactions = [tx({ date: '2026-01-01', amount: 5000, direction: 'debit' })];
  const balances = calculateEnvelopeBalances(transactions, ['Maintenance']);
  assert.equal(balances.Maintenance, 0);
});

console.log('createTransfer');
test('creates linked debit + credit pair with same transferId', () => {
  const { transfer, transactions } = createTransfer({
    fromAccountId: 'savings-1',
    toAccountId: 'current-1',
    amount: 20000,
    date: '2026-01-01',
    note: 'Top up current account',
  });
  assert.equal(transactions.length, 2);
  const [debitLeg, creditLeg] = transactions;
  assert.equal(debitLeg.accountId, 'savings-1');
  assert.equal(debitLeg.direction, 'debit');
  assert.equal(creditLeg.accountId, 'current-1');
  assert.equal(creditLeg.direction, 'credit');
  assert.equal(debitLeg.transferId, transfer.id);
  assert.equal(creditLeg.transferId, transfer.id);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
