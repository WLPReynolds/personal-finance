// Run with: node src/lib/__tests__/joint-tests.mjs
// v0.14 joint account: combine/split between the two ledgers, the rules that
// keep the files apart, one shared sign-in, and two sync engines side by side.
import assert from 'node:assert/strict';
import {
  emptyLedger, addAccount, addTransaction, updateTransaction, deleteTransaction, moveAccount, updateAccount, deleteAccount,
} from '../ops.js';
import { addRecurring, setOccurrence, confirmOccurrence } from '../schedule.js';
import { setTicketSettings } from '../tickets.js';
import { setReconciled } from '../reconcile.js';
import {
  JOINT_FOLDER_NAME, JOINT_FILE_NAME, CrossLedgerError, emptyJointLedger, isJointLedger, addJointAccount,
  combineLedgers, splitLedger, sameLedgerAccounts,
} from '../joint.js';
import { shareTokenRequests } from '../shared-auth.js';
import { fingerprint } from '../sync-core.js';
import { createSyncEngine } from '../sync-engine.js';
import { buildExport, parseImport } from '../transfer-file.js';
import { createFakeDrive, createFakeAuth, createFakeStore } from './fake-drive.mjs';

let passed = 0;
let failed = 0;
const queue = [];
const test = (name, fn) => queue.push([name, fn]);

function setup() {
  let p = emptyLedger();
  let r = addAccount(p, { name: 'Current Account', type: 'current', institution: 'other', openingBalance: 360000, openingDate: '2026-10-01' });
  const current = r.account;
  r = addAccount(r.ledger, { name: 'Barclaycard', type: 'credit', institution: 'barclaycard', openingBalance: 100000, openingDate: '2026-10-01' });
  const card = r.account;
  p = addTransaction(r.ledger, { accountId: current.id, date: '2026-10-03', amount: 50000, direction: 'debit', description: 'To bills account' });
  const j = addJointAccount(emptyJointLedger(), { openingBalance: 120000, openingDate: '2026-10-01' });
  return { personal: p, joint: j, current, card, jointAcc: j.accounts[0] };
}
const split = (combined, s) => splitLedger(combined, { personal: s.personal, joint: s.joint });
const jointTx = (s, extra = {}) => addTransaction(combineLedgers(s.personal, s.joint), { accountId: s.jointAcc.id, date: '2026-10-05', amount: 6500, direction: 'debit', description: 'Council tax', ...extra });

console.log('combine / split');
test('the joint file is its own ledger: named Joint, one purple account, can’t get a second', () => {
  const s = setup();
  assert.equal(isJointLedger(s.joint), true);
  assert.equal(isJointLedger(s.personal), false);
  assert.equal(s.jointAcc.institution, 'joint');
  assert.equal(s.jointAcc.name, 'Joint account');
  assert.throws(() => addJointAccount(s.joint, { openingBalance: 0, openingDate: '2026-10-01' }), /already/);
  assert.equal(JOINT_FOLDER_NAME, 'Finance Joint');
  assert.equal(JOINT_FILE_NAME, 'joint.json');
});

test('switched off, the display ledger IS the personal ledger (same object)', () => {
  const s = setup();
  assert.equal(combineLedgers(s.personal, null), s.personal);
});

test('combined: joint account first, everything from both files', () => {
  const s = setup();
  const c = combineLedgers(s.personal, s.joint);
  assert.deepEqual(c.accounts.map((a) => a.name), ['Joint account', 'Current Account', 'Barclaycard']);
  assert.equal(c.id, s.personal.id);
  assert.equal(c.transactions.length, 1);
});

test('nothing changed → neither file changes (same objects back)', () => {
  const s = setup();
  const r = split(combineLedgers(s.personal, s.joint), s);
  assert.equal(r.personalChanged, false);
  assert.equal(r.jointChanged, false);
  assert.equal(r.personal, s.personal);
  assert.equal(r.joint, s.joint);
});

test('an entry on the joint account goes to the joint file only', () => {
  const s = setup();
  const r = split(jointTx(s), s);
  assert.equal(r.personalChanged, false);
  assert.equal(r.jointChanged, true);
  assert.equal(r.personal, s.personal);
  assert.deepEqual(r.joint.transactions.map((t) => t.description), ['Council tax']);
  assert.equal(r.joint.id, s.joint.id);
  assert.equal(r.joint.name, 'Joint');
});

test('an entry on your own account goes to the personal file only', () => {
  const s = setup();
  const c = addTransaction(combineLedgers(s.personal, s.joint), { accountId: s.current.id, date: '2026-10-06', amount: 300, direction: 'debit', description: 'Coffee' });
  const r = split(c, s);
  assert.equal(r.jointChanged, false);
  assert.equal(r.joint, s.joint);
  assert.equal(r.personal.transactions.length, 2);
  assert.ok(r.personal.accounts.every((a) => a.institution !== 'joint'));
});

test('editing, ticking and deleting a joint entry stay in the joint file', () => {
  let s = setup();
  s = { ...s, joint: split(jointTx(s), s).joint };
  const id = s.joint.transactions[0].id;
  for (const change of [
    (c) => updateTransaction(c, id, { amount: 7000 }),
    (c) => setReconciled(c, id, true),
    (c) => deleteTransaction(c, id),
  ]) {
    const r = split(change(combineLedgers(s.personal, s.joint)), s);
    assert.equal(r.personalChanged, false);
    assert.equal(r.jointChanged, true);
  }
});

test('a transfer between two of your own accounts stays personal', () => {
  const s = setup();
  const c = addTransaction(combineLedgers(s.personal, s.joint), { accountId: s.current.id, date: '2026-10-07', amount: 5000, direction: 'debit', description: 'Card DD', counterpartAccountId: s.card.id });
  const r = split(c, s);
  assert.equal(r.jointChanged, false);
  assert.equal(r.personal.transfers.length, 1);
});

test('recurring bills on the joint account, their skips and confirmed months go to the joint file', () => {
  const s = setup();
  let c = combineLedgers(s.personal, s.joint);
  let item;
  ({ ledger: c, item } = addRecurring(c, { description: 'Council tax', kind: 'out', accountId: s.jointAcc.id, toAccountId: null, amount: 18500, everyMonths: 1, day: 1, startDate: '2026-10-01', endDate: null, shift: 'after' }));
  c = setOccurrence(c, item.id, '2026-12', { skipped: true });
  c = confirmOccurrence(c, item.id, '2026-10', { date: '2026-10-01', amount: 18500 });
  ({ ledger: c } = addRecurring(c, { description: 'From Alison', kind: 'in', accountId: s.jointAcc.id, toAccountId: null, amount: 60000, everyMonths: 1, day: 28, startDate: '2026-10-01', endDate: null, shift: 'before' }));
  const r = split(c, s);
  assert.equal(r.personalChanged, false);
  assert.equal(r.joint.scheduledItems.length, 3); // two items + one skip
  assert.equal(r.joint.transactions.length, 1);
});

test('reordering your own accounts changes the personal file only', () => {
  const s = setup();
  const r = split(moveAccount(combineLedgers(s.personal, s.joint), s.card.id, -1), s);
  assert.equal(r.jointChanged, false);
  assert.deepEqual(r.personal.accounts.map((a) => a.name), ['Barclaycard', 'Current Account']);
  // trying to move one past the pinned joint account changes nothing at all
  const r2 = split(moveAccount(combineLedgers(s.personal, s.joint), s.current.id, -1), s);
  assert.equal(r2.personalChanged, false);
  assert.equal(r2.jointChanged, false);
});

test('renaming the joint account / its opening balance changes the joint file only', () => {
  const s = setup();
  const r = split(updateAccount(combineLedgers(s.personal, s.joint), s.jointAcc.id, { openingBalance: 99900 }), s);
  assert.equal(r.personalChanged, false);
  assert.equal(r.joint.accounts[0].openingBalance, 99900);
});

console.log('the two files are never linked in v0.14');
test('REFUSED: a transfer between your account and the joint account', () => {
  const s = setup();
  const c = addTransaction(combineLedgers(s.personal, s.joint), { accountId: s.current.id, date: '2026-10-03', amount: 50000, direction: 'debit', description: 'To bills', counterpartAccountId: s.jointAcc.id });
  assert.throws(() => split(c, s), CrossLedgerError);
});

test('REFUSED: a recurring transfer from your account to the joint account (and the other way)', () => {
  const s = setup();
  const base = { description: 'To bills account', kind: 'transfer', amount: 50000, everyMonths: 1, day: 3, startDate: '2026-10-01', endDate: null, shift: 'none' };
  const a = addRecurring(combineLedgers(s.personal, s.joint), { ...base, accountId: s.current.id, toAccountId: s.jointAcc.id }).ledger;
  assert.throws(() => split(a, s), CrossLedgerError);
  const b = addRecurring(combineLedgers(s.personal, s.joint), { ...base, accountId: s.jointAcc.id, toAccountId: s.current.id }).ledger;
  assert.throws(() => split(b, s), CrossLedgerError);
});

test('REFUSED: personal settings (ticket purchases) pointing at the joint account', () => {
  const s = setup();
  const c = { ...combineLedgers(s.personal, s.joint) };
  const rec = { id: 'ticket-purchases', recordType: 'ticketPurchases', enabled: false, cardAccountId: s.card.id, envelopeAccountId: null, envelopeId: null, safeAccountId: s.jointAcc.id, returnAccountId: s.current.id, startDate: null };
  assert.throws(() => split({ ...c, scheduledItems: [...c.scheduledItems, rec] }, s), CrossLedgerError);
  assert.doesNotThrow(() => split(setTicketSettings(c, { enabled: false, cardAccountId: s.card.id, returnAccountId: s.current.id }), s));
});

test('REFUSED: removing the joint account itself', () => {
  const s = setup();
  const c = deleteAccount(combineLedgers(s.personal, s.joint), s.jointAcc.id);
  assert.throws(() => split(c, s), /can’t be removed/);
});

test('pickers: transfer choices stay within the same file', () => {
  const s = setup();
  const c = combineLedgers(s.personal, s.joint);
  const ids = new Set([s.jointAcc.id]);
  assert.deepEqual(sameLedgerAccounts(c.accounts, s.current.id, ids).map((a) => a.name), ['Current Account', 'Barclaycard']);
  assert.deepEqual(sameLedgerAccounts(c.accounts, s.jointAcc.id, ids).map((a) => a.name), ['Joint account']);
});

test('a joint export says it is the joint file; a personal one doesn’t', () => {
  const s = setup();
  assert.equal(isJointLedger(parseImport(JSON.stringify(buildExport(s.joint))).ledger), true);
  assert.equal(isJointLedger(parseImport(JSON.stringify(buildExport(s.personal))).ledger), false);
});

console.log('one sign-in for two engines');
test('two sign-in requests in the same tap → one request to Google, both get the token', async () => {
  let calls = 0;
  let release;
  const raw = { getToken: ({ interactive }) => { if (!interactive) return Promise.resolve(null); calls++; return new Promise((r) => { release = r; }); }, hasValidToken: () => false, name: 'raw' };
  const shared = shareTokenRequests(raw);
  const a = shared.getToken({ interactive: true });
  const b = shared.getToken({ interactive: true });
  const c = shared.getToken({ interactive: false }); // a background check meanwhile waits too
  assert.equal(calls, 1);
  release('tok');
  assert.deepEqual(await Promise.all([a, b, c]), ['tok', 'tok', 'tok']);
  shared.getToken({ interactive: true });
  assert.equal(calls, 2, 'a later tap asks again');
  assert.equal(shared.name, 'raw');
  assert.equal(shared.hasValidToken(), false);
});

test('the shared wrapper keeps `this` for auth objects with methods', async () => {
  const fake = createFakeAuth({ valid: false });
  const shared = shareTokenRequests(fake);
  assert.equal(await shared.getToken({ interactive: true }), 'tok');
  assert.equal(fake.interactiveCalls, 1);
  shared.setLoginHint('x@y');
  assert.equal(fake.hint, 'x@y');
});

console.log('two engines, one Drive');
const fileText = (drive, name) => [...drive.items.values()].find((f) => !f.folder && f.name === name)?.text ?? null;
const folderOf = (drive, name) => { const f = [...drive.items.values()].find((x) => !x.folder && x.name === name); return drive.items.get(f.parent)?.name; };

async function device(drive, personal, joint) {
  const auth = shareTokenRequests(createFakeAuth());
  const pStore = createFakeStore(personal);
  const jStore = createFakeStore(joint);
  const pEngine = createSyncEngine({ auth, drive, store: pStore });
  const jEngine = createSyncEngine({ auth, drive, store: jStore, folderName: JOINT_FOLDER_NAME, fileName: JOINT_FILE_NAME });
  await pEngine.init();
  await jEngine.init();
  return { pStore, jStore, pEngine, jEngine };
}

test('each file in its own folder; the personal file never holds joint data', async () => {
  const drive = createFakeDrive();
  const s = setup();
  const d = await device(drive, s.personal, s.joint);
  await d.pEngine.connect();
  await d.jEngine.connect();
  assert.equal(folderOf(drive, 'personal.json'), 'Finance');
  assert.equal(folderOf(drive, 'joint.json'), 'Finance Joint');
  const p = parseImport(fileText(drive, 'personal.json')).ledger;
  const j = parseImport(fileText(drive, 'joint.json')).ledger;
  assert.ok(p.accounts.every((a) => a.institution !== 'joint'));
  assert.deepEqual(j.accounts.map((a) => a.name), ['Joint account']);
});

test('a joint change syncs the joint file only; its backup goes in the joint folder', async () => {
  const drive = createFakeDrive();
  const s = setup();
  const d = await device(drive, s.personal, s.joint);
  await d.pEngine.connect();
  await d.jEngine.connect();
  const personalBefore = fileText(drive, 'personal.json');
  d.jStore.edit((l) => addTransaction(l, { accountId: s.jointAcc.id, date: '2026-10-05', amount: 6500, direction: 'debit', description: 'Council tax' }));
  await d.pEngine.sync();
  await d.jEngine.sync();
  assert.equal(fileText(drive, 'personal.json'), personalBefore, 'personal file untouched');
  assert.equal(parseImport(fileText(drive, 'joint.json')).ledger.transactions.length, 1);
  const parentName = (f) => drive.items.get(f.parent)?.name;
  const backups = [...drive.items.values()].filter((f) => !f.folder && parentName(f) === 'backups');
  assert.equal(backups.length, 1, 'one backup, made before the joint change');
  assert.equal(drive.items.get(drive.items.get(backups[0].parent).parent).name, 'Finance Joint');
  assert.equal(parseImport(backups[0].text).ledger.transactions.length, 0, 'it holds the joint file as it was before');
});

test('a joint sync failure stays on the joint status; personal syncs on regardless', async () => {
  const drive = createFakeDrive();
  const s = setup();
  const d = await device(drive, s.personal, s.joint);
  await d.pEngine.connect();
  await d.jEngine.connect();
  d.pStore.edit((l) => addTransaction(l, { accountId: s.current.id, date: '2026-10-06', amount: 300, direction: 'debit', description: 'Coffee' }));
  d.jStore.edit((l) => addTransaction(l, { accountId: s.jointAcc.id, date: '2026-10-06', amount: 900, direction: 'debit', description: 'Milk' }));
  drive.hooks.failNext = new Error('Drive said no');
  const jr = await d.jEngine.sync();
  const pr = await d.pEngine.sync();
  assert.equal(jr.status, 'error');
  assert.equal(d.jEngine.getState().status, 'error');
  assert.equal(pr.status, 'pushed');
  assert.equal(d.pEngine.getState().status, 'idle');
  assert.equal(parseImport(fileText(drive, 'personal.json')).ledger.transactions.length, 2);
  assert.equal((await d.jEngine.sync()).status, 'pushed', 'and the joint file catches up next time');
});

test('second device: turning the joint account on there brings the joint file down', async () => {
  const drive = createFakeDrive();
  const s = setup();
  const desk = await device(drive, s.personal, s.joint);
  await desk.pEngine.connect();
  await desk.jEngine.connect();
  const phone = await device(drive, emptyLedger(), emptyJointLedger());
  await phone.pEngine.connect();
  await phone.jEngine.connect();
  assert.equal(fingerprint(phone.jStore.getLocal()), fingerprint(desk.jStore.getLocal()));
  phone.jStore.edit((l) => addTransaction(l, { accountId: s.jointAcc.id, date: '2026-10-08', amount: 4000, direction: 'debit', description: 'Water' }));
  await phone.jEngine.sync();
  await desk.jEngine.sync();
  assert.deepEqual(desk.jStore.getLocal().transactions.map((t) => t.description), ['Water']);
  assert.equal(desk.pStore.getLocal().transactions.length, 1, 'desk personal data unchanged');
});

test('a clash in the joint file is reported by the joint engine only', async () => {
  const drive = createFakeDrive();
  const s = setup();
  const desk = await device(drive, s.personal, s.joint);
  await desk.pEngine.connect();
  await desk.jEngine.connect();
  desk.jStore.edit((l) => addTransaction(l, { accountId: s.jointAcc.id, date: '2026-10-08', amount: 4000, direction: 'debit', description: 'Water' }));
  await desk.jEngine.sync();
  const phone = await device(drive, emptyLedger(), emptyJointLedger());
  await phone.pEngine.connect();
  await phone.jEngine.connect();
  const id = desk.jStore.getLocal().transactions[0].id;
  desk.jStore.edit((l) => updateTransaction(l, id, { amount: 4100 }));
  phone.jStore.edit((l) => updateTransaction(l, id, { amount: 4200 }));
  await desk.jEngine.sync();
  const r = await phone.jEngine.sync();
  assert.equal(r.status, 'conflicts');
  assert.notEqual(phone.pEngine.getState().status, 'conflicts');
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
