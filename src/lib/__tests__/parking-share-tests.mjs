// v0.15.25 — parking payments shared with the ticket tracker (parking-transactions.json).
// Run with: node src/lib/__tests__/parking-share-tests.mjs
import assert from 'node:assert/strict';
import { emptyLedger, addAccount, addTransaction, updateTransaction, deleteTransaction } from '../ops.js';
import { buildExport, parseImport } from '../transfer-file.js';
import { prepareMerge } from '../sync-core.js';
import { combineLedgers, splitLedger, addJointAccount, emptyJointLedger } from '../joint.js';
import {
  parkingSettingsRecord, parkingSharingOn, setParkingSharing, canBeParking, isParking, setParkingFlag,
  parkingTransactions, buildParkingFile, sameTransactions, parseParkingFile, publishParking, findParkingFile,
  PARKING_FILE_NAME, NO_FILE_MESSAGE,
} from '../parking-share.js';
import { createFakeDrive } from './fake-drive.mjs';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL - ${name}`);
    console.log(`    ${err.stack.split('\n').slice(0, 3).join('\n    ')}`);
  }
}

function base() {
  let l = emptyLedger();
  l = addAccount(l, { name: 'Current Account', type: 'current', openingBalance: 100000, openingDate: '2026-10-01' }).ledger;
  l = addAccount(l, { name: 'Barclaycard', type: 'credit', openingBalance: 0, openingDate: '2026-10-01' }).ledger;
  return l;
}
const acc = (l, name) => l.accounts.find((a) => a.name === name).id;
function spend(l, accountName, date, amount, extra = {}) {
  const next = addTransaction(l, { accountId: acc(l, accountName), date, description: 'Parking', kind: 'transaction', direction: 'debit', amount, ...extra });
  return { ledger: next, id: next.transactions.at(-1).id };
}
function trackerEmptyFile() {
  return JSON.stringify({ format: 'parking-transactions', version: 1, generatedAt: '2026-11-27T08:00:00Z', source: { app: 'ticket-tracker', appVersion: 'v2026-11-27.08:00' }, transactions: [] });
}
const fileJson = (drive) => JSON.parse([...drive.items.values()].find((f) => f.name === PARKING_FILE_NAME).text);

console.log('parking sharing');

await test('settings: off by default, on/off kept in one synced record', () => {
  let l = base();
  assert.equal(parkingSharingOn(l), false);
  l = setParkingSharing(l, true);
  assert.equal(parkingSharingOn(l), true);
  const rec = parkingSettingsRecord(l);
  assert.equal(rec.id, 'parking-sharing');
  assert.equal(rec.recordType, 'parkingSharing');
  l = setParkingSharing(l, false);
  assert.equal(parkingSharingOn(l), false);
  assert.equal(l.scheduledItems.filter((r) => r.recordType === 'parkingSharing').length, 1);
  assert.equal(parkingSettingsRecord(l).createdAt, rec.createdAt);
});

await test('flag: only on a plain payment out; removed (not false) when unticked', () => {
  let { ledger: l, id } = spend(base(), 'Barclaycard', '2026-11-26', 639);
  l = setParkingFlag(l, id, true);
  assert.equal(isParking(l.transactions.find((t) => t.id === id)), true);
  l = setParkingFlag(l, id, false);
  assert.equal('parking' in l.transactions.find((t) => t.id === id), false);
  // a credit, a note, a transfer leg can't be parking
  const credit = addTransaction(l, { accountId: acc(l, 'Barclaycard'), date: '2026-11-26', description: 'Refund', kind: 'transaction', direction: 'credit', amount: 639 });
  const cid = credit.transactions.at(-1).id;
  assert.equal(isParking(setParkingFlag(credit, cid, true).transactions.find((t) => t.id === cid)), false);
  const tr = addTransaction(l, { accountId: acc(l, 'Current Account'), counterpartAccountId: acc(l, 'Barclaycard'), date: '2026-11-26', description: 'Card payment', kind: 'transaction', direction: 'debit', amount: 5000 });
  const legs = tr.transactions.filter((t) => t.transferId);
  assert.equal(legs.length, 2);
  for (const leg of legs) assert.equal(canBeParking(leg), false);
  // unchanged ledger object when nothing changes
  assert.equal(setParkingFlag(l, id, false), l);
});

await test('flag does not untick a reconciled entry', () => {
  let { ledger: l, id } = spend(base(), 'Barclaycard', '2026-11-26', 639);
  l = updateTransaction(l, id, { reconciled: true });
  l = setParkingFlag(l, id, true);
  assert.equal(l.transactions.find((t) => t.id === id).reconciled, true);
});

await test('list: flagged payments out only, the full set, sorted; account name included', () => {
  let l = base();
  let a; let b; let c;
  ({ ledger: l, id: a } = spend(l, 'Barclaycard', '2026-11-26', 639));
  ({ ledger: l, id: b } = spend(l, 'Current Account', '2026-11-20', 450));
  ({ ledger: l, id: c } = spend(l, 'Barclaycard', '2026-11-26', 200));
  spend(l, 'Barclaycard', '2026-11-27', 999); // not kept in l, never flagged anyway
  l = setParkingFlag(setParkingFlag(setParkingFlag(l, a, true), b, true), c, true);
  const list = parkingTransactions(l);
  assert.deepEqual(list.map((e) => e.date), ['2026-11-20', '2026-11-26', '2026-11-26']);
  assert.deepEqual(list.find((e) => e.id === a), { id: a, date: '2026-11-26', amountPence: 639, account: 'Barclaycard' });
  assert.deepEqual(list.find((e) => e.id === b), { id: b, date: '2026-11-20', amountPence: 450, account: 'Current Account' });
  // two on one day → two entries
  assert.equal(list.filter((e) => e.date === '2026-11-26').length, 2);
});

await test('list: an edit keeps the id; a flagged entry turned into a credit drops out; delete drops out', () => {
  let { ledger: l, id } = spend(base(), 'Barclaycard', '2026-11-26', 639);
  l = setParkingFlag(l, id, true);
  l = updateTransaction(l, id, { amount: 700, date: '2026-11-25', accountId: acc(l, 'Current Account') });
  assert.deepEqual(parkingTransactions(l), [{ id, date: '2026-11-25', amountPence: 700, account: 'Current Account' }]);
  const asCredit = updateTransaction(l, id, { direction: 'credit' });
  assert.deepEqual(parkingTransactions(asCredit), []);
  assert.deepEqual(parkingTransactions(deleteTransaction(l, id)), []);
});

await test('file: the spec’s shape; generatedAt to the second', () => {
  const text = buildParkingFile([{ id: 'x', date: '2026-11-26', amountPence: 639, account: 'Barclaycard' }], { appVersion: 'v0.15.25', now: new Date('2026-11-27T08:02:11.456Z') });
  const f = JSON.parse(text);
  assert.deepEqual(Object.keys(f), ['format', 'version', 'generatedAt', 'source', 'transactions']);
  assert.equal(f.format, 'parking-transactions');
  assert.equal(f.version, 1);
  assert.equal(f.generatedAt, '2026-11-27T08:02:11Z');
  assert.deepEqual(f.source, { app: 'personal-finance', appVersion: 'v0.15.25' });
  assert.equal(parseParkingFile(text).ok, true);
});

await test('compare: order, generatedAt and source don’t count; any field does', () => {
  const x = { id: 'a', date: '2026-11-26', amountPence: 639, account: 'Barclaycard' };
  const y = { id: 'b', date: '2026-11-25', amountPence: 450 };
  assert.equal(sameTransactions([x, y], [y, x]), true);
  assert.equal(sameTransactions([x], [{ ...x, amountPence: 640 }]), false);
  assert.equal(sameTransactions([x], [{ ...x, account: 'Nationwide' }]), false);
  assert.equal(sameTransactions([x], [x, y]), false);
  assert.equal(sameTransactions([], []), true);
});

await test('reading Drive’s file: wrong format, bad JSON or a newer version are refused', () => {
  assert.equal(parseParkingFile('{').ok, false);
  assert.equal(parseParkingFile(JSON.stringify({ format: 'something-else', version: 1 })).ok, false);
  const newer = parseParkingFile(JSON.stringify({ format: 'parking-transactions', version: 2, transactions: [] }));
  assert.equal(newer.ok, false);
  assert.match(newer.error, /Update Personal Finance/);
  assert.deepEqual(parseParkingFile(trackerEmptyFile()), { ok: true, transactions: [] });
});

await test('publish: no file → never creates one, says turn it on in the tracker', async () => {
  const drive = createFakeDrive();
  let { ledger: l, id } = spend(base(), 'Barclaycard', '2026-11-26', 639);
  l = setParkingFlag(l, id, true);
  const rec = await publishParking({ drive, token: 't', ledger: l, cached: null, appVersion: 'v0.15.25' });
  assert.equal(rec.error, NO_FILE_MESSAGE);
  assert.equal(rec.uploaded, false);
  assert.equal(drive.items.size, 0);
  assert.equal(drive.calls.includes('create'), false);
  assert.equal(await findParkingFile({ drive, token: 't' }), null);
});

await test('publish: fills the tracker’s file in place, then does nothing while unchanged', async () => {
  const drive = createFakeDrive();
  const fid = drive.putForeignFile(PARKING_FILE_NAME, trackerEmptyFile());
  let { ledger: l, id } = spend(base(), 'Barclaycard', '2026-11-26', 639);
  l = setParkingFlag(l, id, true);
  let rec = await publishParking({ drive, token: 't', ledger: l, cached: null, appVersion: 'v0.15.25' });
  assert.equal(rec.uploaded, true);
  assert.equal(rec.fileId, fid);
  assert.deepEqual(fileJson(drive).transactions, [{ id, date: '2026-11-26', amountPence: 639, account: 'Barclaycard' }]);
  assert.equal(drive.items.size, 1);
  // unchanged: no download, no upload
  const calls = drive.calls.length;
  let downloads = 0;
  const realDownload = drive.download;
  drive.download = async (...a) => { downloads++; return realDownload.apply(drive, a); };
  rec = await publishParking({ drive, token: 't', ledger: l, cached: rec, appVersion: 'v0.15.26' }); // a new appVersion alone isn't a change
  assert.equal(rec.uploaded, false);
  assert.equal(downloads, 0);
  assert.equal(drive.calls.length, calls);
  // an edit → upload; a delete → empty list
  l = updateTransaction(l, id, { amount: 700 });
  rec = await publishParking({ drive, token: 't', ledger: l, cached: rec, appVersion: 'v0.15.25' });
  assert.equal(rec.uploaded, true);
  assert.equal(fileJson(drive).transactions[0].amountPence, 700);
  l = deleteTransaction(l, id);
  rec = await publishParking({ drive, token: 't', ledger: l, cached: rec, appVersion: 'v0.15.25' });
  assert.equal(rec.uploaded, true);
  assert.deepEqual(fileJson(drive).transactions, []);
});

await test('publish: the other device already wrote the same list → download, compare, no upload', async () => {
  const drive = createFakeDrive();
  drive.putForeignFile(PARKING_FILE_NAME, trackerEmptyFile());
  let { ledger: l, id } = spend(base(), 'Barclaycard', '2026-11-26', 639);
  l = setParkingFlag(l, id, true);
  await publishParking({ drive, token: 't', ledger: l, cached: null, appVersion: 'v0.15.25' }); // "phone"
  const before = drive.calls.filter((c) => c === 'update').length;
  const rec = await publishParking({ drive, token: 't', ledger: l, cached: null, appVersion: 'v0.15.25' }); // "desktop", never seen it
  assert.equal(rec.uploaded, false);
  assert.equal(drive.calls.filter((c) => c === 'update').length, before);
});

await test('publish: oldest file with the name wins; a foreign or newer file is left alone', async () => {
  const drive = createFakeDrive();
  const first = drive.putForeignFile(PARKING_FILE_NAME, trackerEmptyFile());
  const second = drive.putForeignFile(PARKING_FILE_NAME, trackerEmptyFile());
  let { ledger: l, id } = spend(base(), 'Barclaycard', '2026-11-26', 639);
  l = setParkingFlag(l, id, true);
  const rec = await publishParking({ drive, token: 't', ledger: l, cached: null, appVersion: 'v' });
  assert.equal(rec.fileId, first);
  assert.equal(JSON.parse(drive.items.get(second).text).transactions.length, 0);

  const d2 = createFakeDrive();
  const odd = d2.putForeignFile(PARKING_FILE_NAME, JSON.stringify({ hello: 'world' }));
  const r2 = await publishParking({ drive: d2, token: 't', ledger: l, cached: null, appVersion: 'v' });
  assert.equal(r2.uploaded, false);
  assert.match(r2.error, /left alone/);
  assert.equal(d2.items.get(odd).text, JSON.stringify({ hello: 'world' }));
});

await test('publish: a failed upload leaves the file and retries next time; auth errors pass through', async () => {
  const drive = createFakeDrive();
  drive.putForeignFile(PARKING_FILE_NAME, trackerEmptyFile());
  let { ledger: l, id } = spend(base(), 'Barclaycard', '2026-11-26', 639);
  l = setParkingFlag(l, id, true);
  let rec = await publishParking({ drive, token: 't', ledger: l, cached: null, appVersion: 'v' });
  l = updateTransaction(l, id, { amount: 800 });
  const realUpdate = drive.updateFile;
  drive.updateFile = async () => { throw new Error('network down'); };
  rec = await publishParking({ drive, token: 't', ledger: l, cached: rec, appVersion: 'v' });
  assert.equal(rec.uploaded, false);
  assert.match(rec.error, /network down/);
  assert.equal(fileJson(drive).transactions[0].amountPence, 639);
  drive.updateFile = realUpdate;
  rec = await publishParking({ drive, token: 't', ledger: l, cached: rec, appVersion: 'v' });
  assert.equal(rec.uploaded, true);
  assert.equal(rec.error, null);
  assert.equal(fileJson(drive).transactions[0].amountPence, 800);
  drive.authFail.on = true;
  await assert.rejects(publishParking({ drive, token: 't', ledger: l, cached: rec, appVersion: 'v' }), (e) => e.auth === true);
});

await test('the flag and the setting survive export/import and a two-device merge', () => {
  let l = setParkingSharing(base(), true);
  let id; let other;
  ({ ledger: l, id } = spend(l, 'Barclaycard', '2026-11-26', 639));
  ({ ledger: l, id: other } = spend(l, 'Current Account', '2026-11-25', 100));
  const baseL = l;
  const phone = setParkingFlag(l, id, true); // ticked on one device…
  const desktop = updateTransaction(l, other, { description: 'Coffee' }); // …another entry edited on the other
  const m = prepareMerge({ base: baseL, local: phone, remote: desktop });
  assert.equal((m.groups ?? []).length, 0);
  assert.equal(m.merged.transactions.find((x) => x.id === id).parking, true);
  assert.equal(m.merged.transactions.find((x) => x.id === other).description, 'Coffee');
  const back = parseImport(JSON.stringify(buildExport(phone)));
  assert.equal(parkingSharingOn(back.ledger), true);
  assert.equal(isParking(back.ledger.transactions.find((x) => x.id === id)), true);
});

await test('joint on: the setting belongs to your own file; joint entries never go in the list', () => {
  let personal = setParkingSharing(base(), true);
  let joint = addJointAccount(emptyJointLedger(), { openingBalance: 0, openingDate: '2026-10-01' });
  let combined = combineLedgers(personal, joint);
  const jointId = combined.accounts.find((a) => a.institution === 'joint').id;
  combined = addTransaction(combined, { accountId: jointId, date: '2026-11-26', description: 'Parking', kind: 'transaction', direction: 'debit', amount: 300 });
  const jid = combined.transactions.at(-1).id;
  combined = setParkingFlag(combined, jid, true);
  const parts = splitLedger(combined, { personal, joint });
  personal = parts.personal;
  assert.equal(parkingSharingOn(personal), true);
  assert.equal(parkingSettingsRecord(parts.joint), null);
  assert.deepEqual(parkingTransactions(personal), []);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
