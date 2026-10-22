// Run with: node src/lib/__tests__/expense-tests.mjs
// v0.15.8 expense claims (claude/expense-claims-design.md): the fields on
// accounts and entries, the claim list, the photo store and its clean-up.
import assert from 'node:assert/strict';
import { emptyLedger, addAccount, addTransaction, updateTransaction, updateAccount, deleteTransaction } from '../ops.js';
import {
  claimsOn, isExpense, setExpense, setClaimStatus, nextStatus, previousStatus, claimSections, recentCandidates,
  shareSummary, photoFileName, cleanupPlan, cleanupMessage, fitExpense, unpaidSummary, receiptFileName,
} from '../expenses.js';
import { createPhotoLibrary, memoryPhotoBackend, fitWithin, isPdf, pdfProblem, MAX_PDF_BYTES, PDF_TYPE } from '../photos.js';
import { mergeLedger } from '../merge.js';
import { prepareMerge, repairLedger, fingerprint } from '../sync-core.js';
import { buildExport, parseImport } from '../transfer-file.js';
import { emptyJointLedger, addJointAccount, combineLedgers, splitLedger } from '../joint.js';
import { createSyncEngine } from '../sync-engine.js';
import { createFakeDrive, createFakeAuth, createFakeStore } from './fake-drive.mjs';

let passed = 0;
let failed = 0;
const queue = [];
const test = (name, fn) => queue.push([name, fn]);

/** Alison's accounts: a current account and an MBNA card ticked for claims. */
function setup() {
  let r = addAccount(emptyLedger(), { name: 'Current Account', type: 'current', institution: 'other', openingBalance: 100000, openingDate: '2026-10-01' });
  const current = r.account;
  r = addAccount(r.ledger, { name: 'MBNA', type: 'credit', institution: 'mbna', openingBalance: 0, openingDate: '2026-10-01' });
  const mbna = r.account;
  let l = updateAccount(r.ledger, mbna.id, { expenseClaims: true });
  l = addTransaction(l, { accountId: mbna.id, date: '2026-10-12', amount: 18900, direction: 'debit', description: 'Premier Inn' });
  l = addTransaction(l, { accountId: mbna.id, date: '2026-10-13', amount: 2350, direction: 'debit', description: 'Fuel' });
  l = addTransaction(l, { accountId: mbna.id, date: '2026-10-14', amount: 500, direction: 'credit', description: 'Refund' });
  l = addTransaction(l, { accountId: current.id, date: '2026-10-14', amount: 1200, direction: 'debit', description: 'Lunch' });
  const id = (d) => l.transactions.find((t) => t.description === d).id;
  return { ledger: l, current, mbna, hotel: id('Premier Inn'), fuel: id('Fuel'), refund: id('Refund'), lunch: id('Lunch') };
}
const txOf = (l, id) => l.transactions.find((t) => t.id === id);

// ------------------------------------------------------------ fields
console.log('fields on accounts and entries');

test('the account tick: absent or false = off, true = on', () => {
  const s = setup();
  assert.equal(claimsOn(s.ledger.accounts.find((a) => a.id === s.mbna.id)), true);
  assert.equal(claimsOn(s.ledger.accounts.find((a) => a.id === s.current.id)), false);
  assert.equal(claimsOn({ expenseClaims: false }), false);
});

test('mark an entry: claim amount starts at the entry amount, status To claim', () => {
  const s = setup();
  const l = setExpense(s.ledger, s.fuel, { details: 'Client visit, Leeds' });
  assert.deepEqual(txOf(l, s.fuel).expense, { amount: 2350, details: 'Client visit, Leeds', status: 'toClaim', submittedAt: null, paidAt: null });
});

test('part-business claim: can be lowered, never more than the entry', () => {
  const s = setup();
  const l = setExpense(s.ledger, s.hotel, { amount: 14500, details: 'Room only, not the bar' });
  assert.equal(txOf(l, s.hotel).expense.amount, 14500);
  assert.throws(() => setExpense(s.ledger, s.hotel, { amount: 18901 }), /can’t be more than the entry/);
  assert.throws(() => setExpense(s.ledger, s.hotel, { amount: 0 }), /more than £0.00/);
});

test('only money going out, and only on a ticked account', () => {
  const s = setup();
  assert.throws(() => setExpense(s.ledger, s.refund, {}), /money going out/);
  assert.throws(() => setExpense(s.ledger, s.lunch, {}), /isn’t set up for expense claims/);
});

test('editing the entry amount below the claim pulls the claim down; above leaves it', () => {
  const s = setup();
  let l = setExpense(s.ledger, s.hotel, { amount: 14500 });
  l = updateTransaction(l, s.hotel, { amount: 12000 });
  assert.equal(txOf(l, s.hotel).expense.amount, 12000);
  l = updateTransaction(l, s.hotel, { amount: 20000 });
  assert.equal(txOf(l, s.hotel).expense.amount, 12000);
  assert.equal(fitExpense({ kind: 'note', amount: 0, expense: { amount: 5 } }).expense.amount, 5); // a note leaves it alone
});

test('a later edit (description, date) keeps the claim; unmarking removes the field', () => {
  const s = setup();
  let l = setExpense(s.ledger, s.fuel, { details: 'Trip' });
  l = updateTransaction(l, s.fuel, { description: 'Fuel — Shell', date: '2026-10-15' });
  assert.equal(txOf(l, s.fuel).expense.details, 'Trip');
  l = setExpense(l, s.fuel, null);
  assert.equal('expense' in txOf(l, s.fuel), false);
});

test('claim added days after the entry (Monday entry, Friday claim) — any stored entry works', () => {
  const s = setup();
  const l = setExpense(s.ledger, s.hotel, { details: 'Fri catch-up' });
  assert.equal(isExpense(txOf(l, s.hotel)), true);
  assert.equal(txOf(l, s.hotel).date, '2026-10-12');
});

// ------------------------------------------------------------ statuses and the list
console.log('statuses and the claim list');

test('tick on and untick back: To claim → Submitted → Paid, with times', () => {
  const s = setup();
  let l = setExpense(s.ledger, s.fuel, {});
  assert.equal(nextStatus('toClaim'), 'submitted');
  assert.equal(nextStatus('paid'), null);
  assert.equal(previousStatus('submitted'), 'toClaim');
  l = setClaimStatus(l, [s.fuel], 'submitted', '2026-10-20T10:00:00Z');
  assert.equal(txOf(l, s.fuel).expense.submittedAt, '2026-10-20T10:00:00Z');
  l = setClaimStatus(l, [s.fuel], 'paid', '2026-10-28T10:00:00Z');
  assert.deepEqual([txOf(l, s.fuel).expense.submittedAt, txOf(l, s.fuel).expense.paidAt], ['2026-10-20T10:00:00Z', '2026-10-28T10:00:00Z']);
  l = setClaimStatus(l, [s.fuel], 'submitted', '2026-10-29T10:00:00Z');
  assert.deepEqual([txOf(l, s.fuel).expense.submittedAt, txOf(l, s.fuel).expense.paidAt], ['2026-10-20T10:00:00Z', null]);
  l = setClaimStatus(l, [s.fuel], 'toClaim');
  assert.equal(txOf(l, s.fuel).expense.submittedAt, null);
});

test('sections: a count and a total of claim amounts each', () => {
  const s = setup();
  let l = setExpense(s.ledger, s.hotel, { amount: 14500 });
  l = setExpense(l, s.fuel, {});
  l = setClaimStatus(l, [s.fuel], 'submitted');
  const [toClaim, submitted, paid] = claimSections(l);
  assert.deepEqual([toClaim.count, toClaim.total], [1, 14500]);
  assert.deepEqual([submitted.count, submitted.total], [1, 2350]);
  assert.deepEqual([paid.count, paid.total, paid.label], [0, 0, 'Paid']);
  l = setClaimStatus(l, [s.hotel, s.fuel], 'paid');
  assert.deepEqual(claimSections(l).map((x) => x.total), [0, 0, 16850]);
});

test('untick the account: claims are kept but hidden; tick again and they are back', () => {
  const s = setup();
  let l = setExpense(s.ledger, s.fuel, { details: 'Keep me' });
  l = updateAccount(l, s.mbna.id, { expenseClaims: false });
  assert.equal(claimSections(l)[0].count, 0);
  assert.equal(txOf(l, s.fuel).expense.details, 'Keep me'); // still on the entry
  l = updateTransaction(l, s.fuel, { description: 'Fuel (edited while hidden)' });
  l = updateAccount(l, s.mbna.id, { expenseClaims: true });
  assert.equal(claimSections(l)[0].rows[0].tx.expense.details, 'Keep me');
});

test('add from recent: money-out entries on ticked accounts, not yet claims, last 60 days, newest first', () => {
  const s = setup();
  let l = setExpense(s.ledger, s.hotel, {});
  l = addTransaction(l, { accountId: s.mbna.id, date: '2026-07-01', amount: 900, direction: 'debit', description: 'Too old' });
  l = addTransaction(l, { accountId: s.mbna.id, date: '2026-11-01', amount: 900, direction: 'debit', description: 'Future' });
  l = addTransaction(l, { accountId: s.mbna.id, date: '2026-10-14', kind: 'note', description: 'A note' });
  assert.deepEqual(recentCandidates(l, '2026-10-22').map((t) => t.description), ['Fuel']);
});

test('share text: date, amount (of the full one if part), details, and a total for several', () => {
  const s = setup();
  let l = setExpense(s.ledger, s.hotel, { amount: 14500, details: 'Room only' });
  l = setExpense(l, s.fuel, {});
  const text = shareSummary([txOf(l, s.hotel), txOf(l, s.fuel)]);
  assert.equal(text, '12/10/2026 · £145.00 (of £189.00) · Premier Inn\nRoom only\n\n13/10/2026 · £23.50 · Fuel\n\nTotal: £168.50 (2 claims)');
  assert.equal(photoFileName(txOf(l, s.hotel), 2, 3), '2026-10-12-Premier-Inn-2.jpg');
});

// ------------------------------------------------------------ merge, sync, older versions
console.log('merge, sync and older versions');

test('three-way merge keeps the expense field and the account tick', () => {
  const s = setup();
  const base = setExpense(s.ledger, s.fuel, {});
  const local = setClaimStatus(base, [s.fuel], 'submitted');
  const remote = updateTransaction(base, s.hotel, { description: 'Premier Inn Leeds' });
  const { merged, conflicts } = mergeLedger({ base, local, remote });
  assert.equal(conflicts.length, 0);
  assert.equal(txOf(merged, s.fuel).expense.status, 'submitted');
  assert.equal(merged.accounts.find((a) => a.id === s.mbna.id).expenseClaims, true);
  const p = prepareMerge({ base, local, remote });
  assert.equal(txOf(p.merged, s.fuel).expense.status, 'submitted');
});

test('an older version (code that never touches the claim) keeps it through edits, repair, export and import', () => {
  const s = setup();
  let l = setExpense(s.ledger, s.fuel, { details: 'Kept' });
  // what an older version does: edit other fields, reorder, repair, export / import
  l = updateTransaction(l, s.fuel, { description: 'Fuel 2' });
  l = updateAccount(l, s.mbna.id, { name: 'MBNA card' });
  l = repairLedger(l);
  l = parseImport(JSON.stringify(buildExport(l, 'test'))).ledger;
  assert.equal(txOf(l, s.fuel).expense.details, 'Kept');
  assert.equal(l.accounts.find((a) => a.id === s.mbna.id).expenseClaims, true);
});

test('a change to a claim alone counts as a change worth syncing', () => {
  const s = setup();
  const a = setExpense(s.ledger, s.fuel, {});
  const b = setClaimStatus(a, [s.fuel], 'submitted');
  assert.notEqual(fingerprint(a), fingerprint(b));
});

test('two devices: a claim made on one reaches the other through sync', async () => {
  const s = setup();
  const drive = createFakeDrive();
  const dev = async (initial) => {
    const store = createFakeStore(initial);
    const engine = createSyncEngine({ auth: createFakeAuth(), drive, store });
    await engine.init();
    return { store, engine };
  };
  const phone = await dev(s.ledger);
  await phone.engine.connect();
  const desk = await dev(emptyLedger());
  await desk.engine.connect();
  phone.store.edit((l) => setExpense(l, s.fuel, { details: 'Synced' }));
  await phone.engine.sync();
  await desk.engine.sync();
  assert.equal(txOf(desk.store.getLocal(), s.fuel).expense.details, 'Synced');
});

test('joint account: the tick and the claim live in the joint file, not the personal one', () => {
  const s = setup();
  const joint = addJointAccount(emptyJointLedger(), { openingBalance: 50000, openingDate: '2026-10-01' });
  const jointAcc = joint.accounts[0];
  let c = combineLedgers(s.ledger, joint);
  c = updateAccount(c, jointAcc.id, { expenseClaims: true });
  c = addTransaction(c, { accountId: jointAcc.id, date: '2026-10-16', amount: 650, direction: 'debit', description: 'Parking' });
  const parking = c.transactions.at(-1).id;
  c = setExpense(c, parking, { details: 'Alison — client site' });
  const parts = splitLedger(c, { personal: s.ledger, joint });
  assert.equal(parts.personalChanged, false);
  assert.equal(parts.jointChanged, true);
  assert.equal(parts.joint.accounts[0].expenseClaims, true);
  assert.equal(txOf(parts.joint, parking).expense.details, 'Alison — client site');
});

// ------------------------------------------------------------ photos
console.log('photos (this device only)');

const blob = (n) => ({ size: n, type: 'image/jpeg' });

test('photos are kept through status changes', async () => {
  const s = setup();
  const lib = createPhotoLibrary(memoryPhotoBackend());
  let l = setExpense(s.ledger, s.fuel, {});
  await lib.add(s.fuel, blob(300000));
  await lib.add(s.fuel, blob(200000));
  l = setClaimStatus(l, [s.fuel], 'submitted');
  l = setClaimStatus(l, [s.fuel], 'paid');
  assert.equal((await lib.forEntry(s.fuel)).length, 2);
});

test('clean-up removes only photos of Paid claims — the claims themselves stay', async () => {
  const s = setup();
  const lib = createPhotoLibrary(memoryPhotoBackend());
  let l = setExpense(s.ledger, s.fuel, {});
  l = setExpense(l, s.hotel, {});
  await lib.add(s.fuel, blob(300000));
  await lib.add(s.hotel, blob(250000));
  l = setClaimStatus(l, [s.fuel], 'paid');
  l = setClaimStatus(l, [s.hotel], 'submitted');
  const plan = await lib.cleanupPlan(l);
  assert.deepEqual([plan.kind, plan.count, plan.bytes, plan.claims], ['some', 1, 300000, 1]);
  await lib.remove(plan.photoIds);
  assert.equal((await lib.forEntry(s.fuel)).length, 0);
  assert.equal((await lib.forEntry(s.hotel)).length, 1);
  assert.equal(txOf(l, s.fuel).expense.status, 'paid');
});

test('clean-up messages: none paid / nothing to delete / n photos', () => {
  const s = setup();
  let l = setExpense(s.ledger, s.fuel, {});
  const none = cleanupPlan(l, [{ id: 'p1', entryId: s.fuel, size: 1000 }]);
  assert.equal(none.kind, 'nonePaid');
  assert.match(cleanupMessage(none), /No claims are marked as paid yet — mark them Paid in the claim list first/);
  l = setClaimStatus(l, [s.fuel], 'paid');
  const nothing = cleanupPlan(l, [{ id: 'p1', entryId: 'some-other-entry', size: 1000 }]);
  assert.equal(nothing.kind, 'nothing');
  assert.match(cleanupMessage(nothing), /Nothing to delete/);
  const some = cleanupPlan(l, [{ id: 'p1', entryId: s.fuel, size: 2 * 1024 * 1024 }, { id: 'p2', entryId: s.fuel, size: 512 * 1024 }]);
  assert.match(cleanupMessage(some), /^Delete 2 receipts \(2\.5 MB\) of 1 paid claim from this device\?/);
});

test('nothing about photos is written to any synced file', async () => {
  const s = setup();
  const lib = createPhotoLibrary(memoryPhotoBackend());
  let l = setExpense(s.ledger, s.fuel, {});
  const before = JSON.stringify(l);
  const meta = await lib.add(s.fuel, blob(300000));
  l = setClaimStatus(l, [s.fuel], 'submitted');
  const after = JSON.stringify(l);
  assert.equal(after.includes(meta.id), false);
  assert.equal(/photo/i.test(after), false);
  assert.equal(before.length > 0, true);
  assert.deepEqual(Object.keys(txOf(l, s.fuel).expense).sort(), ['amount', 'details', 'paidAt', 'status', 'submittedAt']);
  assert.equal(/photo/i.test(JSON.stringify(buildExport(l, 'x'))), false);
});

test('deleting an entry: its photos can be removed by entry', async () => {
  const s = setup();
  const lib = createPhotoLibrary(memoryPhotoBackend());
  await lib.add(s.fuel, blob(1));
  await lib.add(s.fuel, blob(1));
  await lib.add(s.hotel, blob(1));
  deleteTransaction(s.ledger, s.fuel);
  assert.equal(await lib.removeForEntry(s.fuel), 2);
  assert.deepEqual([...(await lib.counts()).values()], [1]);
});

test('shrinking: long side to 1600 px, shape kept, small pictures untouched', () => {
  assert.deepEqual(fitWithin(4032, 3024), { width: 1600, height: 1200 });
  assert.deepEqual(fitWithin(3024, 4032), { width: 1200, height: 1600 });
  assert.deepEqual(fitWithin(800, 600), { width: 800, height: 600 });
});

// ------------------------------------------------------------ v0.15.9
console.log('v0.15.9: PDF receipts and the header line');

test('a PDF is a receipt like a photo: kept as it is, with its type and name', async () => {
  const s = setup();
  const lib = createPhotoLibrary(memoryPhotoBackend());
  const pdf = await lib.add(s.fuel, { size: 80000, type: PDF_TYPE }, undefined, 'Shell receipt.pdf');
  const jpg = await lib.add(s.fuel, blob(200000));
  assert.deepEqual([pdf.type, pdf.name], [PDF_TYPE, 'Shell receipt.pdf']);
  assert.equal(jpg.type, 'image/jpeg');
  assert.equal('name' in jpg, false);
  assert.equal((await lib.forEntry(s.fuel)).length, 2);
  // a picker that leaves the type blank: the name decides
  const blank = await lib.add(s.hotel, { size: 10, type: '' }, undefined, 'invoice.PDF');
  assert.equal(blank.type, PDF_TYPE);
});

test('PDF checks: by type or .pdf name; over 10 MB or empty is refused', () => {
  assert.equal(isPdf({ type: PDF_TYPE, name: 'x' }), true);
  assert.equal(isPdf({ type: '', name: 'Receipt.pdf' }), true);
  assert.equal(isPdf({ type: 'image/jpeg', name: 'photo.jpg' }), false);
  assert.equal(pdfProblem({ name: 'a.pdf', size: 5000 }), null);
  assert.match(pdfProblem({ name: 'big.pdf', size: MAX_PDF_BYTES + 1 }), /over 10 MB/);
  assert.match(pdfProblem({ name: 'e.pdf', size: 0 }), /empty/);
});

test('clean-up counts PDFs too (paid claims only)', async () => {
  const s = setup();
  const lib = createPhotoLibrary(memoryPhotoBackend());
  let l = setExpense(s.ledger, s.fuel, {});
  await lib.add(s.fuel, { size: 1024 * 1024, type: PDF_TYPE }, undefined, 'a.pdf');
  await lib.add(s.fuel, blob(1024 * 1024));
  l = setClaimStatus(l, [s.fuel], 'paid');
  const plan = await lib.cleanupPlan(l);
  assert.deepEqual([plan.kind, plan.count], ['some', 2]);
  assert.match(cleanupMessage(plan), /^Delete 2 receipts \(2\.0 MB\)/);
});

test('shared file names: .pdf for a PDF, .jpg for a photo', () => {
  const s = setup();
  const t = txOf(s.ledger, s.fuel);
  assert.equal(receiptFileName(t, 1, 2, 'pdf'), '2026-10-13-Fuel-1.pdf');
  assert.equal(photoFileName(t, 1, 1), '2026-10-13-Fuel.jpg');
});

test('header line only while claims are unpaid (to claim or submitted)', () => {
  const s = setup();
  let l = setExpense(s.ledger, s.fuel, {});
  assert.equal(unpaidSummary(l, s.mbna.id).any, true);
  l = setClaimStatus(l, [s.fuel], 'submitted');
  const sub = unpaidSummary(l, s.mbna.id);
  assert.deepEqual([sub.any, sub.toClaim.count, sub.submitted.count, sub.submitted.total], [true, 0, 1, 2350]);
  l = setClaimStatus(l, [s.fuel], 'paid');
  assert.equal(unpaidSummary(l, s.mbna.id).any, false);
  assert.equal(unpaidSummary(s.ledger, s.mbna.id).any, false); // no claims at all
});

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
