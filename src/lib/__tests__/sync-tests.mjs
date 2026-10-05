// Run with: node src/lib/__tests__/sync-tests.mjs
// Two simulated devices (phone + desktop) sharing one fake Drive.
import assert from 'node:assert/strict';
import { emptyLedger, addAccount, addTransaction, updateTransaction, deleteTransaction, moveAccount, deleteAccount, accountBalances } from '../ops.js';
import { fingerprint, prepareMerge, applyResolutions, repairLedger, mergeAccountOrder } from '../sync-core.js';
import { createSyncEngine } from '../sync-engine.js';
import { parseImport } from '../transfer-file.js';
import { createFakeDrive, createFakeAuth, createFakeStore } from './fake-drive.mjs';

let passed = 0;
let failed = 0;
const queue = [];
const test = (name, fn) => queue.push([name, fn]);

function seed() {
  let l = emptyLedger();
  let r = addAccount(l, { name: 'Current Account', type: 'current', institution: 'other', openingBalance: 360000, openingDate: '2026-10-01' });
  const current = r.account;
  r = addAccount(r.ledger, { name: 'Barclaycard', type: 'credit', institution: 'barclaycard', openingBalance: 100000, openingDate: '2026-10-01' });
  return { ledger: r.ledger, current, card: r.account };
}
const tx = (ledger, accountId, description, amount, date = '2026-10-05', direction = 'debit', extra = {}) =>
  addTransaction(ledger, { accountId, date, amount, direction, description, ...extra });
const descs = (l) => l.transactions.map((t) => t.description).sort();

async function device(drive, initial) {
  const auth = createFakeAuth();
  const store = createFakeStore(initial);
  const engine = createSyncEngine({ auth, drive, store });
  await engine.init();
  return { auth, store, engine };
}

/** Phone sets up, connects; desktop joins empty. Returns both devices. */
async function twoDevices() {
  const drive = createFakeDrive();
  const { ledger, current, card } = seed();
  const phone = await device(drive, ledger);
  await phone.engine.connect();
  const desk = await device(drive, emptyLedger());
  await desk.engine.connect();
  return { drive, phone, desk, current, card };
}

// ---------------------------------------------------------------- core
test('fingerprint ignores lastModified but sees content and order', () => {
  const { ledger, current } = seed();
  assert.equal(fingerprint(ledger), fingerprint({ ...ledger, lastModified: 'x' }));
  assert.notEqual(fingerprint(ledger), fingerprint(moveAccount(ledger, current.id, 1)));
});

test('repair: transaction on an account deleted elsewhere brings the account back', () => {
  const { ledger, current } = seed();
  const withTx = tx(ledger, current.id, 'Lottery', 1500);
  const broken = { ...withTx, accounts: withTx.accounts.filter((a) => a.id !== current.id) };
  const fixed = repairLedger(broken, [ledger]);
  assert.ok(fixed.accounts.some((a) => a.id === current.id));
});

test('repair: lone transfer leg becomes an ordinary entry; transfers rebuilt from legs', () => {
  const { ledger, current, card } = seed();
  const l = tx(ledger, current.id, 'Card DD', 5000, '2026-10-07', 'debit', { counterpartAccountId: card.id });
  const oneLeg = { ...l, transactions: [l.transactions[0]] };
  const fixed = repairLedger(oneLeg);
  assert.equal(fixed.transactions[0].transferId, null);
  assert.equal(fixed.transfers.length, 0);
  const stale = { ...l, transfers: [{ ...l.transfers[0], amount: 1 }] };
  assert.equal(repairLedger(stale).transfers[0].amount, 5000);
});

test('account order: local reorder wins, otherwise remote order is taken', () => {
  const { ledger, current } = seed();
  const reordered = moveAccount(ledger, current.id, 1);
  assert.deepEqual(mergeAccountOrder(ledger.accounts, { base: ledger, local: reordered, remote: ledger }).map((a) => a.name), ['Barclaycard', 'Current Account']);
  assert.deepEqual(mergeAccountOrder(ledger.accounts, { base: ledger, local: ledger, remote: reordered }).map((a) => a.name), ['Barclaycard', 'Current Account']);
});

test('clashing edits to a transfer are grouped so both legs are decided together', () => {
  const { ledger, current, card } = seed();
  const base = tx(ledger, current.id, 'Card DD', 5000, '2026-10-07', 'debit', { counterpartAccountId: card.id });
  const leg = base.transactions[0].id;
  const local = updateTransaction(base, leg, { amount: 6000 });
  const remote = updateTransaction(base, leg, { amount: 7000 });
  const { merged, groups } = prepareMerge({ base, local, remote });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].conflicts.length, 2);
  const resolved = applyResolutions(merged, groups, { [groups[0].key]: 'remote' });
  assert.deepEqual(resolved.transactions.map((t) => t.amount), [7000, 7000]);
  assert.equal(resolved.transfers[0].amount, 7000);
});

// ---------------------------------------------------------------- engine
test('first device uploads; second (empty) device joins and receives everything', async () => {
  const { drive, phone, desk } = await twoDevices();
  assert.equal(drive.calls.filter((c) => c === 'create').length, 1);
  assert.equal(fingerprint(desk.store.getLocal()), fingerprint(phone.store.getLocal()));
  assert.equal(parseImport(drive.fileText()).ledger.accounts.length, 2);
  assert.equal(desk.auth.hint, 'wayne@example.com');
});

test('nothing changed → no write', async () => {
  const { drive, phone } = await twoDevices();
  const before = drive.calls.length;
  const r = await phone.engine.sync();
  assert.equal(r.status, 'unchanged');
  assert.equal(drive.calls.length, before);
});

test('edit on phone → push; desktop pulls it (fast-forward)', async () => {
  const { phone, desk, current } = await twoDevices();
  phone.store.edit((l) => tx(l, current.id, 'Lottery', 1500));
  assert.equal(phone.engine.getState().dirty, true);
  assert.equal((await phone.engine.sync()).status, 'pushed');
  assert.equal(phone.engine.getState().dirty, false);
  assert.equal((await desk.engine.sync()).status, 'merged');
  assert.deepEqual(descs(desk.store.getLocal()), ['Lottery']);
});

test('different edits on both devices between syncs → merged on both, no clash', async () => {
  const { phone, desk, current, card } = await twoDevices();
  phone.store.edit((l) => tx(l, current.id, 'Lottery', 1500));
  desk.store.edit((l) => tx(l, card.id, 'Loveholidays', 2749));
  await phone.engine.sync();
  assert.equal((await desk.engine.sync()).status, 'merged');
  await phone.engine.sync();
  assert.deepEqual(descs(desk.store.getLocal()), ['Lottery', 'Loveholidays']);
  assert.equal(fingerprint(phone.store.getLocal()), fingerprint(desk.store.getLocal()));
});

test('delete on one device, unrelated add on the other → both applied', async () => {
  const { phone, desk, current } = await twoDevices();
  phone.store.edit((l) => tx(l, current.id, 'Mistake', 100));
  await phone.engine.sync();
  await desk.engine.sync();
  const id = desk.store.getLocal().transactions[0].id;
  desk.store.edit((l) => deleteTransaction(l, id));
  phone.store.edit((l) => tx(l, current.id, 'Netflix', 599));
  await desk.engine.sync();
  await phone.engine.sync();
  await desk.engine.sync();
  assert.deepEqual(descs(phone.store.getLocal()), ['Netflix']);
  assert.deepEqual(descs(desk.store.getLocal()), ['Netflix']);
});

test('same entry edited differently → clash reported; choosing Drive applies it everywhere', async () => {
  const { phone, desk, current } = await twoDevices();
  phone.store.edit((l) => tx(l, current.id, 'Gym', 5799));
  await phone.engine.sync();
  await desk.engine.sync();
  const id = phone.store.getLocal().transactions[0].id;
  phone.store.edit((l) => updateTransaction(l, id, { amount: 6000 }));
  desk.store.edit((l) => updateTransaction(l, id, { amount: 6500 }));
  await phone.engine.sync(); // phone wins the race to Drive (6000)
  const r = await desk.engine.sync();
  assert.equal(r.status, 'conflicts');
  assert.equal(desk.engine.getState().status, 'conflicts');
  await desk.engine.resolveConflicts({ [r.groups[0].key]: 'remote' });
  assert.equal(desk.store.getLocal().transactions[0].amount, 6000);
  assert.equal(desk.engine.getState().dirty, false);
});

test('clash resolved as "this device" is pushed and reaches the other device', async () => {
  const { phone, desk, current } = await twoDevices();
  phone.store.edit((l) => tx(l, current.id, 'Gym', 5799));
  await phone.engine.sync();
  await desk.engine.sync();
  const id = phone.store.getLocal().transactions[0].id;
  phone.store.edit((l) => updateTransaction(l, id, { amount: 6000 }));
  desk.store.edit((l) => updateTransaction(l, id, { amount: 6500 }));
  await phone.engine.sync();
  const r = await desk.engine.sync();
  await desk.engine.resolveConflicts({ [r.groups[0].key]: 'local' });
  await phone.engine.sync();
  assert.equal(phone.store.getLocal().transactions[0].amount, 6500);
});

test('another device writes between our check and our save → we retry and merge, nothing lost', async () => {
  const { drive, phone, desk, current } = await twoDevices();
  phone.store.edit((l) => tx(l, current.id, 'From phone', 100));
  desk.store.edit((l) => tx(l, current.id, 'From desk', 200));
  // The phone has passed its "unchanged?" check and is about to write when
  // the desktop's save lands — the phone's write then overwrites it on Drive.
  drive.hooks.beforeUpdate = async () => { await desk.engine.sync(); };
  const r = await phone.engine.sync();
  assert.notEqual(r.status, 'error');
  assert.ok(!descs(parseImport(drive.fileText()).ledger).includes('From desk')); // the loss really happened on Drive
  const recovery = await desk.engine.sync();
  assert.equal(recovery.recoveredOverwrite, true);
  await phone.engine.sync();
  assert.deepEqual(descs(phone.store.getLocal()), ['From desk', 'From phone']);
  assert.deepEqual(descs(desk.store.getLocal()), ['From desk', 'From phone']);
});

test('person edits while a merge is in progress → their edit is kept', async () => {
  const { drive, phone, desk, current } = await twoDevices();
  desk.store.edit((l) => tx(l, current.id, 'From desk', 200));
  await desk.engine.sync();
  phone.store.edit((l) => tx(l, current.id, 'Before sync', 100));
  const realDownload = drive.download.bind(drive);
  let once = true;
  drive.download = async (...a) => {
    const text = await realDownload(...a);
    if (once) { once = false; phone.store.edit((l) => tx(l, current.id, 'Typed during sync', 300)); }
    return text;
  };
  await phone.engine.sync();
  assert.deepEqual(descs(phone.store.getLocal()), ['Before sync', 'From desk', 'Typed during sync']);
});

test('no token → needs-tap without trying to open Google; a tap then syncs', async () => {
  const { phone, current } = await twoDevices();
  phone.auth.expire();
  phone.store.edit((l) => tx(l, current.id, 'Lottery', 1500));
  const r = await phone.engine.sync();
  assert.equal(r.status, 'needs-tap');
  assert.equal(phone.auth.interactiveCalls, 0); // never asked Google without a tap
  assert.equal((await phone.engine.sync({ interactive: true })).status, 'pushed');
  assert.equal(phone.auth.interactiveCalls, 1);
});

test('token rejected by Drive mid-sync → needs-tap, local data untouched', async () => {
  const { drive, phone, current } = await twoDevices();
  phone.store.edit((l) => tx(l, current.id, 'Lottery', 1500));
  drive.authFail.on = true;
  const r = await phone.engine.sync();
  assert.equal(r.status, 'needs-tap');
  assert.equal(phone.auth.hasValidToken(), false);
  assert.deepEqual(descs(phone.store.getLocal()), ['Lottery']);
});

test('network error → error status, retry later works', async () => {
  const { drive, phone, current } = await twoDevices();
  phone.store.edit((l) => tx(l, current.id, 'Lottery', 1500));
  drive.hooks.failNext = new Error('Failed to fetch');
  const r = await phone.engine.sync();
  assert.equal(r.status, 'error');
  assert.equal(phone.engine.getState().lastError, 'Failed to fetch');
  assert.equal((await phone.engine.sync()).status, 'pushed');
});

test('Drive file deleted by hand → recreated from this device', async () => {
  const { drive, phone } = await twoDevices();
  drive.trashAll();
  const r = await phone.engine.sync();
  assert.equal(r.status, 'pushed');
  assert.ok(drive.fileText());
});

test('device with its own data joining existing Drive file → union (shared history from an export kept once)', async () => {
  const drive = createFakeDrive();
  const { ledger, current } = seed();
  const shared = tx(ledger, current.id, 'Shared', 100);
  const phone = await device(drive, tx(shared, current.id, 'Phone only', 200));
  await phone.engine.connect();
  const desk = await device(drive, tx(shared, current.id, 'Desk only', 300));
  await desk.engine.connect();
  await phone.engine.sync();
  assert.deepEqual(descs(desk.store.getLocal()), ['Desk only', 'Phone only', 'Shared']);
  assert.equal(fingerprint(phone.store.getLocal()), fingerprint(desk.store.getLocal()));
});

test('disconnect leaves local data and Drive file alone; sync is then a no-op', async () => {
  const { drive, phone } = await twoDevices();
  const text = drive.fileText();
  await phone.engine.disconnect();
  assert.equal((await phone.engine.sync()).status, 'off');
  assert.equal(drive.fileText(), text);
  assert.equal(phone.store.getLocal().accounts.length, 2);
});

test('account deleted on one device while the other adds to it → account survives with the entry', async () => {
  const drive = createFakeDrive();
  const { ledger } = seed();
  let r = addAccount(ledger, { name: 'Spare', type: 'current', institution: 'other', openingBalance: 0, openingDate: '2026-10-01' });
  const phone = await device(drive, r.ledger);
  await phone.engine.connect();
  const desk = await device(drive, emptyLedger());
  await desk.engine.connect();
  phone.store.edit((l) => deleteAccount(l, r.account.id));
  desk.store.edit((l) => tx(l, r.account.id, 'Into spare', 100));
  await phone.engine.sync();
  const res = await desk.engine.sync();
  if (res.status === 'conflicts') await desk.engine.resolveConflicts({});
  const l = desk.store.getLocal();
  assert.ok(l.accounts.some((a) => a.id === r.account.id));
  assert.equal(accountBalances(l)[r.account.id], -100);
});

test('stress: 300 random edits/syncs on two devices with forced same-moment saves → converge, nothing lost', async () => {
  for (let seedNo = 1; seedNo <= 5; seedNo++) {
    let s = seedNo * 9301;
    const rand = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
    const { drive, phone, desk, current } = await twoDevices();
    const devices = { phone, desk };
    const expected = new Map(); // description -> amount, for entries that should exist at the end
    let n = 0;
    for (let step = 0; step < 300; step++) {
      const name = rand() < 0.5 ? 'phone' : 'desk';
      const d = devices[name];
      const other = devices[name === 'phone' ? 'desk' : 'phone'];
      const roll = rand();
      const mine = d.store.getLocal().transactions.filter((t) => t.description.startsWith(name) && expected.has(t.description));
      if (roll < 0.35) {
        const desc = `${name}-${n++}`;
        const amount = 1 + Math.floor(rand() * 10000);
        d.store.edit((l) => tx(l, current.id, desc, amount));
        expected.set(desc, amount);
      } else if (roll < 0.45 && mine.length) {
        const t = mine[Math.floor(rand() * mine.length)];
        const amount = 1 + Math.floor(rand() * 10000);
        d.store.edit((l) => updateTransaction(l, t.id, { amount }));
        expected.set(t.description, amount);
      } else if (roll < 0.52 && mine.length) {
        const t = mine[Math.floor(rand() * mine.length)];
        d.store.edit((l) => deleteTransaction(l, t.id));
        expected.delete(t.description);
      } else {
        if (rand() < 0.15) drive.hooks.beforeUpdate = async () => { await other.engine.sync(); };
        const r = await d.engine.sync();
        assert.notEqual(r.status, 'conflicts', `unexpected clash at seed ${seedNo} step ${step}`);
        assert.notEqual(r.status, 'error', `error at seed ${seedNo} step ${step}: ${r.error?.message}`);
        drive.hooks.beforeUpdate = null;
      }
    }
    for (let i = 0; i < 3; i++) { await phone.engine.sync(); await desk.engine.sync(); }
    for (const d of [phone, desk]) {
      const got = new Map(d.store.getLocal().transactions.map((t) => [t.description, t.amount]));
      assert.deepEqual([...got.entries()].sort(), [...expected.entries()].sort(), `seed ${seedNo}`);
    }
    assert.equal(fingerprint(phone.store.getLocal()), fingerprint(desk.store.getLocal()));
  }
});

// ---------------------------------------------------------------- run
for (const [name, fn] of queue) {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL - ${name}\n    ${err.stack?.split('\n').slice(0, 3).join('\n    ')}`);
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
