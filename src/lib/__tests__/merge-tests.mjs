// Run with: node src/lib/__tests__/merge-tests.mjs
import assert from 'node:assert/strict';
import { mergeCollection, mergeLedger, resolveConflict } from '../merge.js';

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

function ledger(overrides = {}) {
  return {
    id: 'ledger-1',
    name: 'Joint account',
    accounts: [],
    transactions: [],
    transfers: [],
    scheduledItems: [],
    schemaVersion: '2',
    lastModified: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function tx(id, overrides = {}) {
  return {
    id,
    accountId: 'acc-1',
    date: '2026-01-01',
    amount: 1000,
    direction: 'debit',
    description: 'tx',
    category: null,
    kind: 'transaction',
    transferId: null,
    envelopeSplits: null,
    scheduledItemId: null,
    isProjected: false,
    ...overrides,
  };
}

console.log('mergeCollection - additions');
test('both sides add different new records - both kept, no conflict', () => {
  const { merged, conflicts } = mergeCollection([], [tx('a')], [tx('b')], 'transaction');
  assert.equal(conflicts.length, 0);
  assert.deepEqual(merged.map((t) => t.id).sort(), ['a', 'b']);
});

test('local-only addition is kept', () => {
  const { merged, conflicts } = mergeCollection([], [tx('a')], [], 'transaction');
  assert.equal(conflicts.length, 0);
  assert.deepEqual(merged.map((t) => t.id), ['a']);
});

console.log('mergeCollection - edits');
test('remote edits a record local left untouched - remote edit wins, no conflict', () => {
  const base = [tx('a', { description: 'original' })];
  const local = [tx('a', { description: 'original' })];
  const remote = [tx('a', { description: 'renamed by wife' })];
  const { merged, conflicts } = mergeCollection(base, local, remote, 'transaction');
  assert.equal(conflicts.length, 0);
  assert.equal(merged[0].description, 'renamed by wife');
});

test('local edits a record remote left untouched - local edit wins, no conflict', () => {
  const base = [tx('a', { description: 'original' })];
  const local = [tx('a', { description: 'renamed by me' })];
  const remote = [tx('a', { description: 'original' })];
  const { merged, conflicts } = mergeCollection(base, local, remote, 'transaction');
  assert.equal(conflicts.length, 0);
  assert.equal(merged[0].description, 'renamed by me');
});

test('both sides make the identical edit - no conflict', () => {
  const { merged, conflicts } = mergeCollection(
    [tx('a', { amount: 1000 })],
    [tx('a', { amount: 2500 })],
    [tx('a', { amount: 2500 })],
    'transaction'
  );
  assert.equal(conflicts.length, 0);
  assert.equal(merged[0].amount, 2500);
});

console.log('mergeCollection - genuine conflicts');
test('both sides edit the same record differently - flagged as edit-edit conflict', () => {
  const { merged, conflicts } = mergeCollection(
    [tx('a', { amount: 1000 })],
    [tx('a', { amount: 2500 })],
    [tx('a', { amount: 3000 })],
    'transaction'
  );
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].reason, 'edit-edit');
  assert.equal(conflicts[0].id, 'a');
  assert.equal(merged[0].amount, 2500);
});

test('local deletes a record remote edited - flagged as delete-edit conflict', () => {
  const { merged, conflicts } = mergeCollection(
    [tx('a', { amount: 1000 })],
    [],
    [tx('a', { amount: 3000 })],
    'transaction'
  );
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].reason, 'delete-edit');
  assert.equal(merged.length, 0);
});

test('local edits a record remote deleted - flagged as edit-delete conflict', () => {
  const { merged, conflicts } = mergeCollection(
    [tx('a', { amount: 1000 })],
    [tx('a', { amount: 3000 })],
    [],
    'transaction'
  );
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].reason, 'edit-delete');
  assert.equal(merged[0].amount, 3000);
});

console.log('mergeCollection - deletions');
test('both sides delete the same record - no conflict, stays deleted', () => {
  const { merged, conflicts } = mergeCollection([tx('a')], [], [], 'transaction');
  assert.equal(conflicts.length, 0);
  assert.equal(merged.length, 0);
});

test('one side deletes, other leaves untouched - deletion wins, no conflict', () => {
  const { merged, conflicts } = mergeCollection([tx('a')], [], [tx('a')], 'transaction');
  assert.equal(conflicts.length, 0);
  assert.equal(merged.length, 0);
});

console.log('mergeLedger - realistic joint-account scenario');
test('interleaved additions, edits and no real conflict', () => {
  const base = ledger({ transactions: [tx('rent', { amount: 80000, description: 'Rent' })] });
  const local = ledger({
    transactions: [
      tx('rent', { amount: 80000, description: 'Rent' }),
      tx('grocery-1', { amount: 4500, description: 'Tesco' }),
    ],
  });
  const remote = ledger({
    transactions: [
      tx('rent', { amount: 85000, description: 'Rent (increased)' }),
      tx('parking', { amount: 600, description: 'Parking' }),
    ],
  });
  const { merged, conflicts } = mergeLedger({ base, local, remote });
  assert.equal(conflicts.length, 0);
  assert.deepEqual(merged.transactions.map((t) => t.id).sort(), ['grocery-1', 'parking', 'rent']);
  assert.equal(merged.transactions.find((t) => t.id === 'rent').amount, 85000);
});

test('transfer is dropped if both its legs get removed', () => {
  const debitLeg = tx('debit-leg', { direction: 'debit', transferId: 'transfer-1', accountId: 'savings' });
  const creditLeg = tx('credit-leg', { direction: 'credit', transferId: 'transfer-1', accountId: 'current' });
  const transfer = { id: 'transfer-1', fromAccountId: 'savings', toAccountId: 'current', amount: 1000, date: '2026-01-01', note: 'Top up' };

  const base = ledger({ transactions: [debitLeg, creditLeg], transfers: [transfer] });
  const local = ledger({ transactions: [], transfers: [] });
  const remote = ledger({ transactions: [debitLeg, creditLeg], transfers: [transfer] });

  const { merged } = mergeLedger({ base, local, remote });
  assert.equal(merged.transactions.length, 0);
  assert.equal(merged.transfers.length, 0);
});

console.log('resolveConflict');
test('resolving with "remote" swaps in the remote version', () => {
  const base = ledger({ transactions: [tx('a', { amount: 1000 })] });
  const local = ledger({ transactions: [tx('a', { amount: 2500 })] });
  const remote = ledger({ transactions: [tx('a', { amount: 3000 })] });
  const { merged, conflicts } = mergeLedger({ base, local, remote });
  assert.equal(conflicts.length, 1);
  const resolved = resolveConflict(merged, conflicts[0], 'remote');
  assert.equal(resolved.transactions.find((t) => t.id === 'a').amount, 3000);
});

test('resolving with a manually-merged object uses it directly', () => {
  const base = ledger({ transactions: [tx('a', { amount: 1000 })] });
  const local = ledger({ transactions: [tx('a', { amount: 2500 })] });
  const remote = ledger({ transactions: [tx('a', { amount: 3000 })] });
  const { merged, conflicts } = mergeLedger({ base, local, remote });
  const manuallyResolved = tx('a', { amount: 2700, description: 'split the difference' });
  const resolved = resolveConflict(merged, conflicts[0], manuallyResolved);
  const result = resolved.transactions.find((t) => t.id === 'a');
  assert.equal(result.amount, 2700);
  assert.equal(result.description, 'split the difference');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
