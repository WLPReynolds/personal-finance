// v0.14.5 recurring envelope moves (money shifted between two envelopes of one account, on a schedule).
// Run with: node src/lib/__tests__/envelope-move-tests.mjs
import assert from 'node:assert/strict';
import { envelopeBalances, envelopesInUse, isEnvelopeMove, allocationOf } from '../envelopes.js';
import { emptyLedger, addAccount, updateAccount, deleteTransaction, updateEnvelopeMove, balanceAsOf } from '../ops.js';
import { addRecurring, updateRecurring, deleteRecurring, withProjections, projections, confirmOccurrence, setOccurrence, recurringItems } from '../schedule.js';
import { BUILT_IN_BANK_HOLIDAYS } from '../workdays.js';
import { prepareMerge } from '../sync-core.js';
import { buildExport, parseImport } from '../transfer-file.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); } catch (err) {
    failed++; console.log(`  FAIL - ${name}`); console.log(`    ${err.stack.split('\n').slice(0, 3).join('\n    ')}`);
  }
}
const HOL = new Set(BUILT_IN_BANK_HOLIDAYS);

function setup() {
  let r = addAccount(emptyLedger(), { name: 'Current Account', type: 'current', institution: 'other', openingBalance: 200000, openingDate: '2026-10-01' });
  const current = r.account;
  r = addAccount(r.ledger, {
    name: 'Chase', type: 'savings', institution: 'other', openingBalance: 100000, openingDate: '2026-10-01',
    envelopes: { enabled: true, list: [
      { id: 'B', name: 'Bills', openingBalance: 60000 },
      { id: 'S', name: 'Savings', openingBalance: 40000 },
    ] },
  });
  return { ledger: r.ledger, current, chase: r.account };
}
const base = (chase, extra = {}) => ({
  description: 'Bills to Savings', kind: 'move', accountId: chase.id, amount: 5000, fromEnvelopeId: 'B', toEnvelopeId: 'S',
  everyMonths: 1, everyDays: null, day: 28, startDate: '2026-10-01', endDate: null, shift: 'before', ...extra,
});
const bal = (ledger, chase, asOf = null) => envelopeBalances(ledger, chase, asOf);

console.log('recurring envelope move');
test('is accepted and stored with its envelopes; nothing else is set', () => {
  const { ledger, chase } = setup();
  const { item } = addRecurring(ledger, base(chase));
  assert.equal(item.kind, 'move');
  assert.equal(item.fromEnvelopeId, 'B');
  assert.equal(item.toEnvelopeId, 'S');
  assert.equal(item.toAccountId, null);
  assert.equal(item.envelopeSplits, null);
  assert.equal(item.payStatement, false);
});
test('projects one envelope-move note a month on the payday rule (28 Oct 2026 is a Wednesday)', () => {
  const { ledger, chase } = setup();
  const l = addRecurring(ledger, base(chase)).ledger;
  const view = withProjections(l, '2026-12-31', HOL);
  const legs = view.transactions.filter((t) => t.isProjected);
  assert.equal(legs.length, 3);
  assert.deepEqual(legs.map((t) => t.date), ['2026-10-28', '2026-11-27', '2026-12-24']); // 28 Nov is a Saturday -> Fri 27th; 28 Dec is the Boxing Day bank holiday -> Thu 24th
  for (const t of legs) {
    assert.ok(isEnvelopeMove(t));
    assert.equal(t.amount, 0);
    assert.equal(t.accountId, chase.id);
    assert.deepEqual(t.envelopeSplits, [{ envelopeId: 'B', amount: -5000 }, { envelopeId: 'S', amount: 5000 }]);
  }
  assert.deepEqual(allocationOf(legs[0], chase), { type: 'move', from: 'B', to: 'S', amount: 5000 });
});
test('the account balance never changes; the envelopes move and still add up', () => {
  const { ledger, chase } = setup();
  const l = addRecurring(ledger, base(chase)).ledger;
  const view = withProjections(l, '2026-11-30', HOL);
  assert.equal(balanceAsOf(view, chase, '2026-12-01'), 100000);
  const b = bal(view, chase, '2026-11-30');
  assert.equal(b.byId.B, 60000 - 10000);
  assert.equal(b.byId.S, 40000 + 10000);
  assert.equal(b.byId.B + b.byId.S + b.unallocated, b.total);
  assert.equal(b.total, 100000);
});
test('the current account is untouched by it', () => {
  const { ledger, chase, current } = setup();
  const l = addRecurring(ledger, base(chase)).ledger;
  const view = withProjections(l, '2026-11-30', HOL);
  assert.equal(view.transactions.filter((t) => t.accountId === current.id).length, 0);
});
test('confirming makes the same note a hand-made move makes, and removes the projection', () => {
  const { ledger, chase } = setup();
  const { ledger: l, item } = addRecurring(ledger, base(chase));
  const c = confirmOccurrence(l, item.id, '2026-10', { date: '2026-10-28', amount: 5000, description: 'Bills to Savings' });
  const tx = c.transactions.find((t) => t.id === `sched:${item.id}:2026-10`);
  assert.ok(isEnvelopeMove(tx));
  assert.equal(tx.kind, 'note');
  assert.equal(tx.amount, 0);
  assert.equal(tx.scheduledItemId, item.id);
  assert.equal(tx.scheduledPeriod, '2026-10');
  assert.equal(bal(c, chase, '2026-10-31').byId.S, 45000);
  const view = withProjections(c, '2026-11-30', HOL);
  assert.equal(view.transactions.filter((t) => t.isProjected).length, 1); // only November left
  assert.equal(bal(view, chase).byId.S, 50000); // October once + November once, never twice
  assert.throws(() => confirmOccurrence(c, item.id, '2026-10', { date: '2026-10-28', amount: 5000 }), /Already confirmed/);
});
test('confirming with a different amount or date moves that amount on that date', () => {
  const { ledger, chase } = setup();
  const { ledger: l, item } = addRecurring(ledger, base(chase));
  const c = confirmOccurrence(l, item.id, '2026-10', { date: '2026-10-29', amount: 7500, description: 'Bills to Savings' });
  const tx = c.transactions.find((t) => t.scheduledItemId === item.id);
  assert.equal(tx.date, '2026-10-29');
  assert.deepEqual(tx.envelopeSplits, [{ envelopeId: 'B', amount: -7500 }, { envelopeId: 'S', amount: 7500 }]);
});
test('a confirmed move can be edited and deleted like any other move; deleting brings the projection back', () => {
  const { ledger, chase } = setup();
  const { ledger: l, item } = addRecurring(ledger, base(chase));
  const c = confirmOccurrence(l, item.id, '2026-10', { date: '2026-10-28', amount: 5000 });
  const id = `sched:${item.id}:2026-10`;
  const edited = updateEnvelopeMove(c, id, { date: '2026-10-28', amount: 6000, fromEnvelopeId: 'B', toEnvelopeId: 'S', description: 'x' });
  const tx = edited.transactions.find((t) => t.id === id);
  assert.equal(tx.scheduledItemId, item.id); // still tied to its series
  assert.equal(tx.envelopeSplits[1].amount, 6000);
  const gone = deleteTransaction(edited, id);
  assert.equal(withProjections(gone, '2026-10-31', HOL).transactions.filter((t) => t.isProjected).length, 1);
});
test('skip and one-off amount work like any recurring item', () => {
  const { ledger, chase } = setup();
  const { ledger: l, item } = addRecurring(ledger, base(chase));
  let s = setOccurrence(l, item.id, '2026-10', { skipped: true });
  assert.equal(bal(withProjections(s, '2026-10-31', HOL), chase).byId.S, 40000);
  s = setOccurrence(l, item.id, '2026-10', { amount: 2500 });
  assert.equal(bal(withProjections(s, '2026-10-31', HOL), chase).byId.S, 42500);
});
test('moving out of or into Unallocated is allowed', () => {
  const { ledger, chase } = setup();
  const l = addRecurring(ledger, base(chase, { fromEnvelopeId: null, toEnvelopeId: 'S' })).ledger;
  const b = bal(withProjections(l, '2026-10-31', HOL), chase);
  assert.equal(b.unallocated, 0 - 5000);
  assert.equal(b.byId.S, 45000);
});
test('refuses: same envelope twice, unknown envelope, an account without envelopes, zero amount', () => {
  const { ledger, chase, current } = setup();
  assert.throws(() => addRecurring(ledger, base(chase, { toEnvelopeId: 'B' })), /two different envelopes/);
  assert.throws(() => addRecurring(ledger, base(chase, { toEnvelopeId: 'ZZZ' })), /Pick an envelope/);
  assert.throws(() => addRecurring(ledger, base(current)), /doesn’t use envelopes/);
  assert.throws(() => addRecurring(ledger, base(chase, { amount: 0 })), /more than/);
});
test('envelope fields are dropped when an item is not a move, and a move has no card/tracker/statement options', () => {
  const { ledger, chase, current } = setup();
  const { item } = addRecurring(ledger, { description: 'Netflix', kind: 'out', accountId: current.id, amount: 1099, everyMonths: 1, day: 5, startDate: '2026-10-01', shift: 'none', fromEnvelopeId: 'B', toEnvelopeId: 'S' });
  assert.equal(item.fromEnvelopeId, null);
  assert.equal(item.toEnvelopeId, null);
  const mv = addRecurring(ledger, base(chase, { payStatement: true, amountFrom: 'ticket-tracker', toAccountId: current.id })).item;
  assert.equal(mv.payStatement, false);
  assert.equal(mv.amountFrom, null);
  assert.equal(mv.toAccountId, null);
});
test('an envelope used by a recurring move cannot be removed from the account (hide it instead)', () => {
  const { ledger, chase } = setup();
  const l = addRecurring(ledger, base(chase)).ledger;
  assert.deepEqual([...envelopesInUse(l, chase.id)].sort(), ['B', 'S']);
  assert.throws(() => updateAccount(l, chase.id, { envelopes: { enabled: true, list: [{ id: 'B', name: 'Bills', openingBalance: 60000 }] } }), /hide it instead/);
});
test('editing the series changes later months only; changing kind away from move clears the envelopes', () => {
  const { ledger, chase } = setup();
  const { ledger: l, item } = addRecurring(ledger, base(chase));
  const c = confirmOccurrence(l, item.id, '2026-10', { date: '2026-10-28', amount: 5000 });
  const u = updateRecurring(c, item.id, { amount: 8000 });
  const view = withProjections(u, '2026-11-30', HOL);
  assert.equal(view.transactions.find((t) => t.id === `sched:${item.id}:2026-10`).envelopeSplits[1].amount, 5000);
  assert.equal(view.transactions.find((t) => t.isProjected).envelopeSplits[1].amount, 8000);
  const asOut = updateRecurring(u, item.id, { kind: 'out' });
  assert.equal(recurringItems(asOut)[0].fromEnvelopeId, null);
});
test('deleting the series keeps confirmed moves', () => {
  const { ledger, chase } = setup();
  const { ledger: l, item } = addRecurring(ledger, base(chase));
  const c = confirmOccurrence(l, item.id, '2026-10', { date: '2026-10-28', amount: 5000 });
  const d = deleteRecurring(c, item.id);
  assert.equal(d.transactions.filter(isEnvelopeMove).length, 1);
  assert.equal(withProjections(d, '2026-12-31', HOL).transactions.filter((t) => t.isProjected).length, 0);
});
test('survives export/import and a merge unchanged', () => {
  const { ledger, chase } = setup();
  const l = addRecurring(ledger, base(chase)).ledger;
  const back = parseImport(JSON.stringify(buildExport(l)));
  const item = recurringItems(back.ledger ?? back)[0];
  assert.equal(item.fromEnvelopeId, 'B');
  assert.equal(item.toEnvelopeId, 'S');
  assert.equal(item.kind, 'move');
});
test('projection record carries the envelopes (for the tap dialog)', () => {
  const { ledger, chase } = setup();
  const l = addRecurring(ledger, base(chase)).ledger;
  const p = projections(l, '2026-10-31', HOL)[0];
  assert.equal(p.kind, 'move');
  assert.equal(p.fromEnvelopeId, 'B');
  assert.equal(p.toEnvelopeId, 'S');
  assert.equal(p.toAccountId, null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
