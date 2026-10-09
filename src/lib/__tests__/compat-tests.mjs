// Run with: node src/lib/__tests__/compat-tests.mjs
//
// Safeguard 5 of the joint account plan: an OLDER app version must not strip
// data a NEWER version added. This code base (v0.13.2) plays the older
// version; the extra fields below stand in for whatever the joint release
// adds (e.g. a cross-file link id on Wayne's half of a transfer).
//
// Part A proves what IS kept. Part B pins down what is NOT kept, so the joint
// design can stay clear of it — if one of those ever starts passing through,
// the test fails and this note needs revisiting.
import assert from 'node:assert/strict';
import {
  emptyLedger, addAccount, addTransaction, updateTransaction, updateAccount, deleteTransaction,
  moveAccount, setStatementMonth,
} from '../ops.js';
import { addRecurring, updateRecurring, setOccurrence, confirmOccurrence } from '../schedule.js';
import { mergeLedger } from '../merge.js';
import { prepareMerge, applyResolutions, repairLedger, fingerprint } from '../sync-core.js';
import { buildExport, parseImport } from '../transfer-file.js';
import { createSyncEngine } from '../sync-engine.js';
import { createFakeDrive, createFakeAuth, createFakeStore } from './fake-drive.mjs';

let passed = 0;
let failed = 0;
const queue = [];
const test = (name, fn) => queue.push([name, fn]);

// "Future" fields, of several shapes (string, object, array, null-able).
const FUTURE_TX = { jointLink: { linkId: 'lnk-1', side: 'personal' }, futureFlag: true };
const FUTURE_ACC = { futureAccountThing: ['a', 'b'] };
const FUTURE_CC = { futureCardThing: 7 };
const FUTURE_ITEM = { jointLink: { linkId: 'lnk-rec', side: 'personal' } };

/** A ledger as a NEWER version would leave it: unknown fields everywhere a record can carry them. */
function futureLedger() {
  let l = emptyLedger();
  let r = addAccount(l, { name: 'Current Account', type: 'current', institution: 'other', openingBalance: 360000, openingDate: '2026-10-01' });
  const current = r.account;
  r = addAccount(r.ledger, { name: 'Barclaycard', type: 'credit', institution: 'barclaycard', openingBalance: 100000, openingDate: '2026-10-01' });
  const card = r.account;
  l = updateAccount(r.ledger, card.id, { creditCard: { ...r.account.creditCard, statementWorkingDay: 13 } });
  l = addTransaction(l, { accountId: current.id, date: '2026-10-03', amount: 50000, direction: 'debit', description: 'To bills account' });
  l = addTransaction(l, { accountId: current.id, date: '2026-10-04', amount: 1200, direction: 'debit', description: 'Coffee' });
  l = addTransaction(l, { accountId: current.id, date: '2026-10-07', amount: 5000, direction: 'debit', description: 'Card DD', counterpartAccountId: card.id });
  l = addTransaction(l, { accountId: card.id, date: '2026-10-08', amount: 2500, direction: 'debit', description: 'Shop' });
  ({ ledger: l } = addRecurring(l, {
    description: 'To bills account', kind: 'out', accountId: current.id, toAccountId: null, amount: 50000,
    everyMonths: 1, day: 3, startDate: '2026-10-01', endDate: null, shift: 'none',
  }));
  const bills = l.transactions.find((t) => t.description === 'To bills account');
  const legs = l.transactions.filter((t) => t.transferId);
  const shop = l.transactions.find((t) => t.description === 'Shop');
  const item = l.scheduledItems[0];
  const mark = {
    transactions: l.transactions.map((t) => (t.id === bills.id || t.transferId || t.id === shop.id ? { ...t, ...FUTURE_TX } : t)),
    accounts: l.accounts.map((a) => (a.id === card.id ? { ...a, ...FUTURE_ACC, creditCard: { ...a.creditCard, ...FUTURE_CC } } : { ...a, ...FUTURE_ACC })),
    scheduledItems: l.scheduledItems.map((s) => ({ ...s, ...FUTURE_ITEM })),
  };
  l = { ...l, ...mark };
  return { ledger: l, current, card, billsId: bills.id, legIds: legs.map((t) => t.id), shopId: shop.id, itemId: item.id };
}

const txOf = (l, id) => l.transactions.find((t) => t.id === id);
const accOf = (l, id) => l.accounts.find((a) => a.id === id);
const itemOf = (l, id) => l.scheduledItems.find((s) => s.id === id);
function hasFuture(rec, future) {
  for (const [k, v] of Object.entries(future)) assert.deepEqual(rec[k], v, `field ${k} lost`);
}
/** Every marked record in `l` still carries its future fields. */
function allKept(l, s) {
  hasFuture(txOf(l, s.billsId), FUTURE_TX);
  for (const id of s.legIds) hasFuture(txOf(l, id), FUTURE_TX);
  hasFuture(txOf(l, s.shopId), FUTURE_TX);
  for (const a of l.accounts) hasFuture(a, FUTURE_ACC);
  hasFuture(accOf(l, s.card.id).creditCard, FUTURE_CC);
  hasFuture(itemOf(l, s.itemId), FUTURE_ITEM);
}

// ============================================================ Part A: kept
console.log('Part A — an older version keeps fields it does not know');

test('editing the entry itself (amount, date, text) keeps its new fields', () => {
  const s = futureLedger();
  let l = updateTransaction(s.ledger, s.billsId, { amount: 51000, date: '2026-10-02', description: 'To bills' });
  hasFuture(txOf(l, s.billsId), FUTURE_TX);
  l = updateTransaction(l, s.billsId, { direction: 'credit' });
  hasFuture(txOf(l, s.billsId), FUTURE_TX);
});

test('editing one leg of a transfer keeps new fields on BOTH legs', () => {
  const s = futureLedger();
  const l = updateTransaction(s.ledger, s.legIds[0], { amount: 6000, description: 'Card DD (Oct)' });
  for (const id of s.legIds) hasFuture(txOf(l, id), FUTURE_TX);
});

test('reconcile tick and statement move keep new fields', () => {
  const s = futureLedger();
  let l = updateTransaction(s.ledger, s.billsId, { reconciled: true });
  hasFuture(txOf(l, s.billsId), FUTURE_TX);
  l = setStatementMonth(l, s.shopId, '2026-11');
  hasFuture(txOf(l, s.shopId), FUTURE_TX);
});

test('other edits (add, delete, reorder) leave marked records untouched', () => {
  const s = futureLedger();
  let l = addTransaction(s.ledger, { accountId: s.current.id, date: '2026-10-09', amount: 100, direction: 'debit', description: 'x' });
  l = deleteTransaction(l, l.transactions.find((t) => t.description === 'Coffee').id);
  l = moveAccount(l, s.card.id, -1);
  allKept(l, s);
});

test('editing an account (name, card statement day) keeps its new fields, inside creditCard too', () => {
  const s = futureLedger();
  let l = updateAccount(s.ledger, s.current.id, { name: 'Current' });
  l = updateAccount(l, s.card.id, { name: 'Barclay', creditCard: { ...accOf(l, s.card.id).creditCard, statementWorkingDay: 14 } });
  allKept(l, s);
});

test('editing a recurring item, or one month of it, keeps the item’s new fields', () => {
  const s = futureLedger();
  let l = updateRecurring(s.ledger, s.itemId, { amount: 52000, day: 4 });
  hasFuture(itemOf(l, s.itemId), FUTURE_ITEM);
  l = setOccurrence(l, s.itemId, '2026-11', { amount: 40000 });
  l = setOccurrence(l, s.itemId, '2026-12', { skipped: true });
  hasFuture(itemOf(l, s.itemId), FUTURE_ITEM);
});

test('export → import round trip keeps everything', () => {
  const s = futureLedger();
  const back = parseImport(JSON.stringify(buildExport(s.ledger, 'test'))).ledger;
  allKept(back, s);
});

test('three-way merge: a record changed on one side only keeps its fields (either side)', () => {
  const s = futureLedger();
  const base = s.ledger;
  const edited = updateTransaction(base, s.billsId, { description: 'Bills' });
  for (const [local, remote] of [[edited, base], [base, edited]]) {
    const { merged, groups } = prepareMerge({ base, local, remote });
    assert.equal(groups.length, 0);
    allKept(merged, s);
  }
});

test('three-way merge: a record ADDED by the newer version arrives with its fields', () => {
  const s = futureLedger();
  const base = s.ledger;
  const added = { ...txOf(base, s.shopId), id: 'new-1', description: 'New', ...FUTURE_TX };
  const remote = { ...base, transactions: [...base.transactions, added] };
  const local = updateTransaction(base, s.shopId, { description: 'Shop!' });
  const { merged, groups } = prepareMerge({ base, local, remote });
  assert.equal(groups.length, 0);
  hasFuture(txOf(merged, 'new-1'), FUTURE_TX);
  allKept(merged, s);
});

test('a clash, decided either way, keeps the chosen side’s fields', () => {
  const s = futureLedger();
  const base = s.ledger;
  const local = updateTransaction(base, s.billsId, { amount: 1 });
  const remote = updateTransaction(base, s.billsId, { amount: 2 });
  const { merged, groups } = prepareMerge({ base, local, remote });
  assert.equal(groups.length, 1);
  for (const side of ['local', 'remote']) {
    const r = applyResolutions(merged, groups, { [groups[0].key]: side }, [local, remote, base]);
    hasFuture(txOf(r, s.billsId), FUTURE_TX);
  }
});

async function device(drive, initial) {
  const auth = createFakeAuth();
  const store = createFakeStore(initial);
  const engine = createSyncEngine({ auth, drive, store });
  await engine.init();
  return { store, engine };
}

test('Drive sync, end to end: old device pulls, edits, merges and pushes — the file keeps every new field', async () => {
  const drive = createFakeDrive();
  const s = futureLedger();
  const newer = await device(drive, s.ledger);
  await newer.engine.connect();
  const older = await device(drive, emptyLedger());
  await older.engine.connect();
  allKept(older.store.getLocal(), s); // joined: took Drive's copy whole

  // old device edits the marked entry itself and pushes
  older.store.edit((l) => updateTransaction(l, s.billsId, { description: 'Bills (old phone)' }));
  await older.engine.sync();
  allKept(parseImport(drive.fileText()).ledger, s);

  // both edit at once → real three-way merge on the old device
  await newer.engine.sync();
  newer.store.edit((l) => updateTransaction(l, s.shopId, { amount: 2600 }));
  older.store.edit((l) => updateRecurring(l, s.itemId, { amount: 53000 }));
  await newer.engine.sync();
  const r = await older.engine.sync();
  assert.notEqual(r.status, 'conflicts');
  const file = parseImport(drive.fileText()).ledger;
  allKept(file, s);
  assert.equal(txOf(file, s.shopId).amount, 2600);
  assert.equal(itemOf(file, s.itemId).amount, 53000);
});

// ============================================================ Part B: limits
console.log('Part B — what an older version does NOT keep (the joint design must avoid these)');

test('LIMIT: a new TOP-LEVEL ledger field is dropped by a three-way merge (and ignored by the change check)', () => {
  const s = futureLedger();
  const base = { ...s.ledger, futureTop: { x: 1 } };
  const local = updateTransaction(base, s.billsId, { description: 'a' });
  const remote = updateTransaction(base, s.shopId, { description: 'b' });
  const { merged } = prepareMerge({ base, local, remote });
  assert.equal('futureTop' in merged, false);
  assert.equal(fingerprint(base), fingerprint(s.ledger)); // a change to it alone would never be synced
});

test('LIMIT: a transfer leg whose partner is not in the same file loses its transferId on any merge', () => {
  const s = futureLedger();
  const lone = { ...txOf(s.ledger, s.billsId), transferId: 'xfer-to-joint', category: 'Transfer' };
  const ledger = { ...s.ledger, transactions: s.ledger.transactions.map((t) => (t.id === s.billsId ? lone : t)) };
  const fixed = repairLedger(ledger);
  assert.equal(txOf(fixed, s.billsId).transferId, null);
  assert.equal(txOf(fixed, s.billsId).category, null);
  hasFuture(txOf(fixed, s.billsId), FUTURE_TX); // …but a field it doesn't know about survives
});

test('LIMIT: extra fields on Transfer records are lost — they are rebuilt from the legs', () => {
  const s = futureLedger();
  const ledger = { ...s.ledger, transfers: s.ledger.transfers.map((t) => ({ ...t, futureOnTransfer: 1 })) };
  const fixed = repairLedger(ledger);
  assert.equal('futureOnTransfer' in fixed.transfers[0], false);
});

test('LIMIT: an old device confirming a month of a linked recurring item makes a plain entry (no link)', () => {
  const s = futureLedger();
  const l = confirmOccurrence(s.ledger, s.itemId, '2026-11', { date: '2026-11-03', amount: 50000 });
  const made = l.transactions.find((t) => t.scheduledItemId === s.itemId);
  assert.equal(made.jointLink, undefined);
  assert.equal(made.direction, 'debit');
});

test('LIMIT: a merge where neither side changed the ledger name/id still takes local’s top-level values', () => {
  const s = futureLedger();
  const base = s.ledger;
  const remote = { ...base, name: 'Renamed elsewhere' };
  const { merged } = mergeLedger({ base, local: base, remote });
  assert.equal(merged.name, base.name);
});

// ---------------------------------------------------------------- run
for (const [name, fn] of queue) {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL - ${name}`);
    console.log(`    ${err.stack}`);
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
