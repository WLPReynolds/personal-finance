// Run with: node src/lib/__tests__/app-tests.mjs
import assert from 'node:assert/strict';
import { parseAmount, formatPence, penceToInput } from '../money.js';
import {
  emptyLedger,
  addAccount,
  updateAccount,
  deleteAccount,
  moveAccount,
  addTransaction,
  updateTransaction,
  deleteTransaction,
  accountBalances,
  accountRunning,
  balanceAsOf,
  descriptionHistory,
  counterpartOf,
} from '../ops.js';
import { buildGridRows } from '../grid.js';
import { INSTITUTIONS, institutionStyle } from '../institutions.js';
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
    console.log(`    ${err.message}`);
  }
}

/** Three accounts like Budget.xlsx: current, Nationwide card, Barclaycard. */
function setup() {
  let l = emptyLedger();
  let r = addAccount(l, { name: 'Current Account', type: 'current', institution: 'other', openingBalance: 360000, openingDate: '2026-10-01' });
  const current = r.account;
  r = addAccount(r.ledger, { name: 'Nationwide', type: 'credit', institution: 'nationwide', openingBalance: 600, openingDate: '2026-10-01' });
  const nationwide = r.account;
  r = addAccount(r.ledger, { name: 'Barclaycard', type: 'credit', institution: 'barclaycard', openingBalance: 100000, openingDate: '2026-10-01' });
  return { ledger: r.ledger, current, nationwide, barclaycard: r.account };
}

console.log('money');
test('parseAmount accepts common forms', () => {
  assert.equal(parseAmount('12'), 1200);
  assert.equal(parseAmount('12.3'), 1230);
  assert.equal(parseAmount('12.34'), 1234);
  assert.equal(parseAmount('£1,234.56'), 123456);
  assert.equal(parseAmount(' .5 '), 50);
  assert.equal(parseAmount('57.99'), 5799); // float trap: 57.99*100 = 5798.999...
  assert.equal(parseAmount('0.29'), 29); // float trap: 0.29*100 = 28.999...
});
test('parseAmount rejects junk', () => {
  for (const bad of ['', 'abc', '-5', '1.234', '1.2.3', '.', '£']) assert.equal(parseAmount(bad), null, bad);
});
test('formatPence', () => {
  assert.equal(formatPence(136601), '£1,366.01');
  assert.equal(formatPence(-1200), '-£12.00');
  assert.equal(formatPence(5), '£0.05');
  assert.equal(penceToInput(123456), '1234.56');
});

console.log('accounts');
test('credit card balances read as amount owed', () => {
  let { ledger, barclaycard } = setup();
  ledger = addTransaction(ledger, { accountId: barclaycard.id, date: '2026-10-02', amount: 27495, direction: 'debit', description: 'Loveholidays' });
  assert.equal(accountBalances(ledger)[barclaycard.id], 127495); // owed goes up with a spend
});
test('deleteAccount refuses when it has transactions', () => {
  let { ledger, current } = setup();
  ledger = addTransaction(ledger, { accountId: current.id, date: '2026-10-02', amount: 1500, direction: 'debit', description: 'Lottery' });
  assert.throws(() => deleteAccount(ledger, current.id), /has transactions/);
});
test('moveAccount reorders and clamps', () => {
  let { ledger, current, barclaycard } = setup();
  ledger = moveAccount(ledger, barclaycard.id, -1);
  assert.deepEqual(ledger.accounts.map((a) => a.name), ['Current Account', 'Barclaycard', 'Nationwide']);
  assert.equal(moveAccount(ledger, current.id, -1), ledger);
});
test('updateAccount changes opening balance and recalculates', () => {
  let { ledger, current } = setup();
  ledger = updateAccount(ledger, current.id, { openingBalance: 100000 });
  assert.equal(accountBalances(ledger)[current.id], 100000);
});

console.log('transactions');
test('validation', () => {
  const { ledger, current } = setup();
  assert.throws(() => addTransaction(ledger, { accountId: current.id, date: '2026-10-02', amount: 0, direction: 'debit', description: 'x' }));
  assert.throws(() => addTransaction(ledger, { accountId: current.id, date: 'bad', amount: 100, direction: 'debit', description: 'x' }));
  assert.throws(() => addTransaction(ledger, { accountId: current.id, date: '2026-10-02', amount: 12.5, direction: 'debit', description: 'x' }));
});
test('note rows carry no money', () => {
  let { ledger, barclaycard } = setup();
  ledger = addTransaction(ledger, { accountId: barclaycard.id, date: '2026-10-19', amount: 999, direction: 'debit', description: 'BARCLAYCARD STATEMENT', kind: 'note' });
  assert.equal(ledger.transactions[0].amount, 0);
  assert.equal(accountBalances(ledger)[barclaycard.id], 100000);
});
test('transfer: Barclaycard direct debit = current debit + card credit, one row in grid', () => {
  let { ledger, current, nationwide, barclaycard } = setup();
  ledger = addTransaction(ledger, {
    accountId: current.id, date: '2026-10-07', amount: 61196, direction: 'debit',
    description: 'Barclaycard direct debit', counterpartAccountId: barclaycard.id,
  });
  assert.equal(ledger.transactions.length, 2);
  assert.equal(ledger.transfers.length, 1);
  const bal = accountBalances(ledger);
  assert.equal(bal[current.id], 360000 - 61196);
  assert.equal(bal[barclaycard.id], 100000 - 61196);
  const rows = buildGridRows(ledger, [current, nationwide, barclaycard]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cells[current.id].debit, 61196);
  assert.equal(rows[0].cells[barclaycard.id].credit, 61196);
  assert.equal(rows[0].balances[nationwide.id], 600);
});
test('editing one leg of a transfer mirrors onto the other; direction flips both', () => {
  let { ledger, current, barclaycard } = setup();
  ledger = addTransaction(ledger, { accountId: current.id, date: '2026-10-07', amount: 1000, direction: 'debit', description: 'DD', counterpartAccountId: barclaycard.id });
  const cardLeg = ledger.transactions.find((t) => t.accountId === barclaycard.id);
  ledger = updateTransaction(ledger, cardLeg.id, { amount: 2000, date: '2026-10-08', description: 'DD fixed' });
  const currentLeg = ledger.transactions.find((t) => t.accountId === current.id);
  assert.equal(currentLeg.amount, 2000);
  assert.equal(currentLeg.date, '2026-10-08');
  assert.equal(currentLeg.description, 'DD fixed');
  assert.equal(ledger.transfers[0].amount, 2000);
  ledger = updateTransaction(ledger, currentLeg.id, { direction: 'credit' });
  assert.equal(ledger.transactions.find((t) => t.accountId === barclaycard.id).direction, 'debit');
  assert.equal(ledger.transfers[0].fromAccountId, barclaycard.id);
  assert.equal(counterpartOf(ledger, currentLeg).accountId, barclaycard.id);
});
test('deleting one leg deletes the whole transfer', () => {
  let { ledger, current, barclaycard } = setup();
  ledger = addTransaction(ledger, { accountId: current.id, date: '2026-10-07', amount: 1000, direction: 'debit', description: 'DD', counterpartAccountId: barclaycard.id });
  ledger = deleteTransaction(ledger, ledger.transactions[1].id);
  assert.equal(ledger.transactions.length, 0);
  assert.equal(ledger.transfers.length, 0);
});
test('backfilled (retrospective) entry slots into the right place', () => {
  let { ledger, current } = setup();
  ledger = addTransaction(ledger, { accountId: current.id, date: '2026-10-04', amount: 599, direction: 'debit', description: 'Netflix' });
  ledger = addTransaction(ledger, { accountId: current.id, date: '2026-10-02', amount: 1500, direction: 'debit', description: 'Lottery' });
  const running = accountRunning(ledger, current);
  assert.deepEqual(running.map((r) => r.transaction.description), ['Lottery', 'Netflix']);
  assert.deepEqual(running.map((r) => r.runningBalance), [358500, 357901]);
});
test('grid balances agree with per-account balances', () => {
  let { ledger, current, nationwide, barclaycard } = setup();
  ledger = addTransaction(ledger, { accountId: current.id, date: '2026-10-02', amount: 1500, direction: 'debit', description: 'Lottery' });
  ledger = addTransaction(ledger, { accountId: nationwide.id, date: '2026-10-03', amount: 598, direction: 'debit', description: 'Dreaming Spanish' });
  ledger = addTransaction(ledger, { accountId: current.id, date: '2026-10-03', amount: 400000, direction: 'credit', description: 'Salary' });
  ledger = addTransaction(ledger, { accountId: current.id, date: '2026-10-05', amount: 600, direction: 'debit', description: 'Nationwide DD', counterpartAccountId: nationwide.id });
  const accounts = [current, nationwide, barclaycard];
  const rows = buildGridRows(ledger, accounts);
  const last = rows[rows.length - 1];
  const bal = accountBalances(ledger);
  for (const a of accounts) assert.equal(last.balances[a.id], bal[a.id], a.name);
  assert.equal(bal[nationwide.id], 598);
});
test('descriptionHistory gives most recent use first, de-duplicated', () => {
  let { ledger, current } = setup();
  ledger = addTransaction(ledger, { accountId: current.id, date: '2026-10-02', amount: 1500, direction: 'debit', description: 'Lottery' });
  ledger = addTransaction(ledger, { accountId: current.id, date: '2026-10-03', amount: 599, direction: 'debit', description: 'Netflix' });
  ledger = addTransaction(ledger, { accountId: current.id, date: '2026-10-04', amount: 250, direction: 'debit', description: 'lottery' });
  const h = descriptionHistory(ledger);
  assert.deepEqual(h.map((x) => x.description), ['lottery', 'Netflix']);
  assert.equal(h[0].amount, 250);
});

console.log('export / import');
test('round-trips', () => {
  let { ledger, current } = setup();
  ledger = addTransaction(ledger, { accountId: current.id, date: '2026-10-02', amount: 1500, direction: 'debit', description: 'Lottery' });
  const parsed = parseImport(JSON.stringify(buildExport(ledger, 'Android')));
  assert.deepEqual(parsed.ledger, ledger);
  assert.equal(parsed.exportedFrom, 'Android');
});
test('rejects foreign or damaged files', () => {
  assert.throws(() => parseImport('not json'), /valid JSON/);
  assert.throws(() => parseImport('{"hello":1}'), /doesn't look like/);
  const { ledger } = setup();
  const bad = buildExport({ ...ledger, transactions: [{ accountId: 'nope', amount: 1 }] });
  assert.throws(() => parseImport(JSON.stringify(bad)), /missing account/);
});

console.log('balanceAsOf');
test('ignores entries dated after the cutoff (backfilled far-future rows)', () => {
  let { ledger, current } = setup();
  ledger = addTransaction(ledger, { accountId: current.id, date: '2026-10-05', amount: 1500, direction: 'debit', description: 'Lottery' });
  ledger = addTransaction(ledger, { accountId: current.id, date: '2100-01-01', amount: 999900, direction: 'credit', description: 'Far future' });
  assert.equal(balanceAsOf(ledger, current, '2026-10-31'), 360000 - 1500);
  assert.equal(balanceAsOf(ledger, current, '2100-01-01'), 360000 - 1500 + 999900);
});
test('credit card reads as amount owed at the cutoff too', () => {
  let { ledger, barclaycard } = setup();
  ledger = addTransaction(ledger, { accountId: barclaycard.id, date: '2026-10-02', amount: 20000, direction: 'debit', description: 'Spend' });
  ledger = addTransaction(ledger, { accountId: barclaycard.id, date: '2026-11-02', amount: 20000, direction: 'credit', description: 'Payment' });
  assert.equal(balanceAsOf(ledger, barclaycard, '2026-10-31'), 120000);
  assert.equal(balanceAsOf(ledger, barclaycard, '2026-11-30'), 100000);
});
test('matches accountBalances when the cutoff is after everything entered', () => {
  let { ledger, current } = setup();
  ledger = addTransaction(ledger, { accountId: current.id, date: '2026-10-05', amount: 1500, direction: 'debit', description: 'Lottery' });
  assert.equal(balanceAsOf(ledger, current, '2099-12-31'), accountBalances(ledger)[current.id]);
});

test('institutions: Flex, Klarna and Very exist; ink defaults to white, Klarna is dark', () => {
  for (const k of ['monzoflex', 'klarna', 'very']) assert.ok(INSTITUTIONS[k], k);
  assert.equal(institutionStyle('monzoflex').accent, '#FF4D56');
  assert.equal(institutionStyle('nationwide').ink, '#FFFFFF');
  assert.equal(institutionStyle('klarna').colour, '#FFA8CD');
  assert.equal(institutionStyle('klarna').ink, '#0B051D');
  assert.equal(institutionStyle('nope').colour, INSTITUTIONS.other.colour);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
