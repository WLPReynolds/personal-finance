// Run with: node src/lib/__tests__/backup-tests.mjs
// v0.9 automatic backups: naming, what's kept, and the engine's daily copy + restore.
import assert from 'node:assert/strict';
import { emptyLedger, addAccount, addTransaction } from '../ops.js';
import { createSyncEngine } from '../sync-engine.js';
import { parseImport } from '../transfer-file.js';
import { parseBackupName, backupsToDelete, describeBackups, dailyBackupName, restoreBackupName, monthlyKeeperIds } from '../backups.js';
import { createFakeDrive, createFakeAuth, createFakeStore } from './fake-drive.mjs';

let passed = 0;
let failed = 0;
const queue = [];
const test = (name, fn) => queue.push([name, fn]);

// ---------------------------------------------------------------- pure rules

const day = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const files = (days) => days.map((d, i) => ({ id: `id-${d}`, name: dailyBackupName(d), createdTime: `c${String(i).padStart(4, '0')}` }));
const kept = (list, today) => { const del = new Set(backupsToDelete(list, today)); return list.filter((f) => !del.has(f.id)).map((f) => f.name.slice(9, 19)).sort(); };

test('names: daily and before-restore parse; anything else is ignored', () => {
  assert.deepEqual(parseBackupName('personal-2026-10-06.json'), { kind: 'daily', day: '2026-10-06', time: null });
  assert.deepEqual(parseBackupName('personal-2026-10-06-before-restore-1512.json'), { kind: 'before-restore', day: '2026-10-06', time: '15:12' });
  assert.equal(parseBackupName('personal.json'), null);
  assert.equal(parseBackupName('notes.txt'), null);
  assert.equal(restoreBackupName(new Date(2026, 9, 6, 9, 5)), 'personal-2026-10-06-before-restore-0905.json');
});

test('keeps the 30 most recent daily backups', () => {
  const days = Array.from({ length: 40 }, (_, i) => day('2026-10-06', -i)); // 6 Oct back to 28 Aug
  const k = kept(files(days), '2026-10-06');
  // newest 30 = 7 Sep..6 Oct; plus first of Aug (28 Aug) and first of Sep (1 Sep) as monthly keepers
  assert.equal(k.length, 32);
  assert.ok(k.includes('2026-09-07') && !k.includes('2026-09-06'));
  assert.ok(k.includes('2026-09-01') && k.includes('2026-08-28'));
});

test('gaps: 30 backups reach back further than 30 days when days were skipped', () => {
  const days = Array.from({ length: 35 }, (_, i) => day('2026-10-06', -i * 2)); // every other day
  const k = kept(files(days), '2026-10-06');
  assert.ok(k.includes(day('2026-10-06', -58)));
});

test('monthly: the first backup of each month is kept for 12 months, then goes', () => {
  // one backup on the 3rd and 20th of each month, Oct 2025 .. Oct 2026
  const days = [];
  for (let i = 0; i <= 12; i++) {
    const m = new Date(Date.UTC(2025, 9 + i, 1)).toISOString().slice(0, 7);
    days.push(`${m}-03`, `${m}-20`);
  }
  const k = kept(files(days.filter((d) => d <= '2026-10-06')), '2026-10-06');
  // all 25 dailies fit inside "30 most recent", so test with a later "today" too
  assert.equal(k.length, 25);
  const many = Array.from({ length: 30 }, (_, i) => day('2026-12-31', -i)); // fills the 30 slots in Dec
  const all = files([...days, ...many]);
  const k2 = kept(all, '2026-12-31');
  for (const m of ['2026-01', '2026-02', '2026-06', '2026-10']) assert.ok(k2.includes(`${m}-03`), m);
  assert.ok(!k2.includes('2025-12-03'), '13 months back is gone');
  assert.ok(!k2.includes('2026-06-20'), 'second backup of a month goes');
});

test('before-restore copies are kept 30 days; duplicates keep the oldest; other files never touched', () => {
  const list = [
    { id: 'r1', name: 'personal-2026-09-01-before-restore-1000.json', createdTime: 'a' },
    { id: 'r2', name: 'personal-2026-09-20-before-restore-1000.json', createdTime: 'b' },
    { id: 'd1', name: 'personal-2026-10-06.json', createdTime: 'b' },
    { id: 'd2', name: 'personal-2026-10-06.json', createdTime: 'a' },
    { id: 'x', name: 'my notes.json', createdTime: 'a' },
  ];
  assert.deepEqual(backupsToDelete(list, '2026-10-06').sort(), ['d1', 'r1']);
});

test('listing order: newest day first, a before-restore copy above that day\'s daily one', () => {
  const list = describeBackups([
    { id: 'a', name: 'personal-2026-10-05.json' },
    { id: 'b', name: 'personal-2026-10-06.json' },
    { id: 'c', name: 'personal-2026-10-06-before-restore-1512.json' },
    { id: 'z', name: 'other.json' },
  ]);
  assert.deepEqual(list.map((f) => f.id), ['c', 'b', 'a']);
  assert.deepEqual([...monthlyKeeperIds([{ id: 'a', name: 'personal-2026-10-05.json' }, { id: 'b', name: 'personal-2026-10-06.json' }])], ['a']);
});

// ---------------------------------------------------------------- engine

function seed() {
  const r = addAccount(emptyLedger(), { name: 'Current Account', type: 'current', institution: 'other', openingBalance: 100000, openingDate: '2026-10-01' });
  return { ledger: r.ledger, acc: r.account };
}
const spend = (l, acc, description, amount = 1000, date = '2026-10-05') => addTransaction(l, { accountId: acc.id, date, amount, direction: 'debit', description });
const descs = (l) => l.transactions.map((t) => t.description).sort();

async function device(drive, initial, clock) {
  const auth = createFakeAuth();
  const store = createFakeStore(initial);
  const engine = createSyncEngine({ auth, drive, store, now: () => clock.now });
  await engine.init();
  return { auth, store, engine };
}

test('first save of the day copies Drive BEFORE the change; later saves that day do not', async () => {
  const drive = createFakeDrive();
  const clock = { now: new Date(2026, 9, 6, 9, 0) };
  const { ledger, acc } = seed();
  const phone = await device(drive, ledger, clock);
  await phone.engine.connect(); // creates the file: nothing to back up yet
  assert.deepEqual(drive.backups(), []);
  phone.store.edit((l) => spend(l, acc, 'Coffee'));
  await phone.engine.sync();
  assert.deepEqual(drive.backups(), ['personal-2026-10-06.json']);
  assert.deepEqual(descs(parseImport(drive.backupText('personal-2026-10-06.json')).ledger), [], 'backup is the state before Coffee');
  phone.store.edit((l) => spend(l, acc, 'Lunch'));
  await phone.engine.sync();
  assert.equal(drive.calls.filter((c) => c === 'copy').length, 1);
  assert.ok(phone.engine.getState().lastBackupAt);
});

test('the other device finds today\'s backup and does not make a second', async () => {
  const drive = createFakeDrive();
  const clock = { now: new Date(2026, 9, 6, 9, 0) };
  const { ledger, acc } = seed();
  const phone = await device(drive, ledger, clock);
  await phone.engine.connect();
  const desk = await device(drive, emptyLedger(), clock);
  await desk.engine.connect();
  phone.store.edit((l) => spend(l, acc, 'Coffee'));
  await phone.engine.sync();
  await desk.engine.sync();
  desk.store.edit((l) => spend(l, acc, 'Train'));
  await desk.engine.sync();
  assert.deepEqual(drive.backups(), ['personal-2026-10-06.json']);
  assert.equal(drive.calls.filter((c) => c === 'copy').length, 1);
  clock.now = new Date(2026, 9, 7, 8, 0);
  desk.store.edit((l) => spend(l, acc, 'Paper', 200, '2026-10-07'));
  await desk.engine.sync();
  assert.deepEqual(drive.backups(), ['personal-2026-10-06.json', 'personal-2026-10-07.json']);
  assert.deepEqual(descs(parseImport(drive.backupText('personal-2026-10-07.json')).ledger), ['Coffee', 'Train']);
});

test('a day with no changes makes no backup (only a save triggers one)', async () => {
  const drive = createFakeDrive();
  const clock = { now: new Date(2026, 9, 6, 9, 0) };
  const { ledger } = seed();
  const phone = await device(drive, ledger, clock);
  await phone.engine.connect();
  clock.now = new Date(2026, 9, 8, 9, 0);
  await phone.engine.sync();
  assert.deepEqual(drive.backups(), []);
});

test('old backups are pruned as part of the daily backup', async () => {
  const drive = createFakeDrive();
  const clock = { now: new Date(2026, 9, 6, 9, 0) };
  const { ledger, acc } = seed();
  const phone = await device(drive, ledger, clock);
  await phone.engine.connect();
  for (let i = 0; i < 45; i++) {
    clock.now = new Date(2026, 9, 6 + i, 9, 0);
    phone.store.edit((l) => spend(l, acc, `Day ${i}`));
    await phone.engine.sync();
  }
  const b = drive.backups();
  // 30 newest (6 Oct + 15..44 → 21 Oct..19 Nov) + first of Oct (6 Oct) + first of Nov (1 Nov, already in the 30)
  assert.equal(b.length, 31);
  assert.ok(b.includes('personal-2026-10-06.json'), 'first of October kept as the monthly');
  assert.ok(!b.includes('personal-2026-10-07.json'));
  assert.ok(b.includes('personal-2026-11-19.json'));
});

test('a backup failure never stops the sync, is reported, and is retried', async () => {
  const drive = createFakeDrive();
  const clock = { now: new Date(2026, 9, 6, 9, 0) };
  const { ledger, acc } = seed();
  const phone = await device(drive, ledger, clock);
  await phone.engine.connect();
  drive.hooks.failCopy = true;
  phone.store.edit((l) => spend(l, acc, 'Coffee'));
  const r = await phone.engine.sync();
  assert.equal(r.status, 'pushed');
  assert.deepEqual(descs(parseImport(drive.fileText()).ledger), ['Coffee']);
  assert.match(phone.engine.getState().backupError, /copy refused/);
  drive.hooks.failCopy = false;
  phone.store.edit((l) => spend(l, acc, 'Lunch'));
  await phone.engine.sync();
  assert.deepEqual(drive.backups(), ['personal-2026-10-06.json']);
  assert.equal(phone.engine.getState().backupError, null);
});

test('list, read and restore: before-restore copy made, data replaced, other device follows', async () => {
  const drive = createFakeDrive();
  const clock = { now: new Date(2026, 9, 6, 9, 0) };
  const { ledger, acc } = seed();
  const phone = await device(drive, ledger, clock);
  await phone.engine.connect();
  const desk = await device(drive, emptyLedger(), clock);
  await desk.engine.connect();
  phone.store.edit((l) => spend(l, acc, 'Coffee'));
  await phone.engine.sync();
  clock.now = new Date(2026, 9, 7, 9, 0);
  phone.store.edit((l) => spend(l, acc, 'Mistake', 99999));
  await phone.engine.sync(); // 7 Oct backup holds Coffee only

  const list = await phone.engine.listBackups();
  assert.deepEqual(list.map((f) => f.name), ['personal-2026-10-07.json', 'personal-2026-10-06.json']);
  assert.equal(list[1].monthly, true);
  const chosen = await phone.engine.readBackup(list[0].id);
  assert.deepEqual(descs(chosen.ledger), ['Coffee']);

  clock.now = new Date(2026, 9, 7, 15, 12);
  const r = await phone.engine.restoreBackup(chosen.ledger);
  assert.equal(r.status, 'restored');
  assert.deepEqual(descs(phone.store.getLocal()), ['Coffee']);
  assert.deepEqual(descs(parseImport(drive.fileText()).ledger), ['Coffee']);
  assert.ok(drive.backups().includes('personal-2026-10-07-before-restore-1512.json'));
  assert.deepEqual(descs(parseImport(drive.backupText('personal-2026-10-07-before-restore-1512.json')).ledger), ['Coffee', 'Mistake']);
  await desk.engine.sync();
  assert.deepEqual(descs(desk.store.getLocal()), ['Coffee']);
});

test('restore keeps this device\'s unsynced edits safe in the before-restore copy', async () => {
  const drive = createFakeDrive();
  const clock = { now: new Date(2026, 9, 6, 9, 0) };
  const { ledger, acc } = seed();
  const phone = await device(drive, ledger, clock);
  await phone.engine.connect();
  phone.store.edit((l) => spend(l, acc, 'Coffee'));
  await phone.engine.sync();
  const [b] = await phone.engine.listBackups();
  const chosen = await phone.engine.readBackup(b.id); // empty (before Coffee)
  phone.store.edit((l) => spend(l, acc, 'Not synced yet'));
  clock.now = new Date(2026, 9, 6, 10, 30);
  await phone.engine.restoreBackup(chosen.ledger);
  assert.deepEqual(descs(phone.store.getLocal()), []);
  assert.deepEqual(descs(parseImport(drive.backupText('personal-2026-10-06-before-restore-1030.json')).ledger), ['Coffee', 'Not synced yet']);
});

test('restore refuses (and changes nothing) if the safety copy cannot be made', async () => {
  const drive = createFakeDrive();
  const clock = { now: new Date(2026, 9, 6, 9, 0) };
  const { ledger, acc } = seed();
  const phone = await device(drive, ledger, clock);
  await phone.engine.connect();
  phone.store.edit((l) => spend(l, acc, 'Coffee'));
  await phone.engine.sync();
  const [b] = await phone.engine.listBackups();
  const chosen = await phone.engine.readBackup(b.id);
  drive.hooks.failCopy = true;
  const r = await phone.engine.restoreBackup(chosen.ledger);
  assert.equal(r.status, 'error');
  assert.deepEqual(descs(phone.store.getLocal()), ['Coffee']);
  assert.deepEqual(descs(parseImport(drive.fileText()).ledger), ['Coffee']);
});

test('listing with an expired sign-in asks for a tap (interactive) and works', async () => {
  const drive = createFakeDrive();
  const clock = { now: new Date(2026, 9, 6, 9, 0) };
  const { ledger } = seed();
  const phone = await device(drive, ledger, clock);
  await phone.engine.connect();
  phone.auth.expire();
  const before = phone.auth.interactiveCalls;
  const list = await phone.engine.listBackups();
  assert.deepEqual(list, []);
  assert.equal(phone.auth.interactiveCalls, before + 1);
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
