// Run with: node src/lib/__tests__/finder-tests.mjs
// v0.15.0: the Finder — history linked to live accounts, live rows, internal
// moves, totals per year and a grand total (out and in apart). Made-up figures.
import assert from 'node:assert/strict';
import { emptyLedger, addAccount, addTransaction } from '../ops.js';
import { buildGridRows } from '../grid.js';
import { parseSheet, buildYear, emptyArchive, withYears } from '../archive.js';
import { withProjections } from '../schedule.js';
import { addRecurring } from '../schedule.js';
import {
  archiveLinks, setArchiveLinks, linksRecord, suggestLink, liveFinderRows, archiveFinderRows,
  findRows, finderColumns, archiveColumn, LINKS_RECORD_TYPE,
} from '../finder.js';
import { splitLedger, combineLedgers, emptyJointLedger, addJointAccount } from '../joint.js';
import { mergeLedger } from '../merge.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); } catch (err) { failed++; console.log(`  FAIL - ${name}`); console.log(`    ${err.message}`); }
}
const S = (y, m, d) => Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);

function live() {
  let l = emptyLedger();
  let r = addAccount(l, { name: 'Current Account', type: 'current', institution: 'other', openingBalance: 100000, openingDate: '2026-10-01' });
  const current = r.account;
  r = addAccount(r.ledger, { name: 'Nationwide', type: 'credit', institution: 'nationwide', openingBalance: 0, openingDate: '2026-10-01' });
  const nationwide = r.account;
  r = addAccount(r.ledger, { name: 'Barclaycard', type: 'credit', institution: 'barclaycard', openingBalance: 0, openingDate: '2026-10-01' });
  const barclaycard = r.account;
  l = r.ledger;
  l = addTransaction(l, { accountId: nationwide.id, date: '2026-10-05', amount: 1500, direction: 'debit', description: 'Car parking (on Nationwide)' });
  l = addTransaction(l, { accountId: current.id, date: '2026-10-06', amount: 2000, direction: 'debit', description: 'Pay Barclaycard', counterpartAccountId: barclaycard.id });
  l = addTransaction(l, { accountId: current.id, date: '2026-10-07', kind: 'note', description: 'In Spain (parking abroad)' });
  return { l, current, nationwide, barclaycard };
}

/** Two history accounts that are really Barclaycard: the main column and a balance-transfer column. */
function history() {
  const rows = [
    [null, null, 'NATIONWIDE', null, null, 'BARCLAYCARD', null, null, 'BARCLAYCARD BT'],
    ['Date', 'Description', 'Credit', 'Debit', 'Balance', 'Credit', 'Debit', 'Balance', 'Credit', 'Debit', 'Balance'],
    [S(2024, 1, 1), 'Brought forward', null, null, 0, null, null, 0, null, null, 0],
    [S(2024, 3, 2), 'Car parking', null, 10, 10, null, null, 0, null, null, 0],
    [S(2024, 4, 1), 'Balance transfer from MBNA', null, null, 10, null, null, 0, null, 500, 500],
    [S(2024, 5, 1), 'Move BT into main (out)', null, null, 10, null, null, 0, 200, null, 300],
    [S(2024, 5, 1), 'Move BT into main (in)', null, null, 10, null, 200, 200, null, null, 300],
    [S(2024, 6, 1), 'Same row move', null, null, 10, null, 50, 250, 50, null, 250],
    [S(2024, 7, 1), 'Car parking refund', 10, null, 0, null, null, 250, null, null, 250],
    [S(2024, 8, 1), 'Spend on Barclaycard', null, null, 0, null, 30, 280, null, null, 250],
  ];
  const y = buildYear(parseSheet({ name: '2024', rows }), ['Nationwide', 'Barclaycard', 'Barclaycard BT']);
  const rows2 = [
    [null, null, 'CHASE'],
    ['Date', 'Description', 'Credit', 'Debit', 'Balance'],
    [S(2025, 1, 1), 'Brought forward', null, null, 0],
    [S(2025, 2, 1), 'Hospital car parking', null, 3.5, -3.5],
  ];
  const y2 = buildYear(parseSheet({ name: '2025', rows: rows2 }), ['Chase']);
  return withYears(emptyArchive(), [y, y2]);
}

console.log('links');
test('stored as one settings record; links to deleted accounts are ignored', () => {
  const { l, nationwide, barclaycard } = live();
  const l2 = setArchiveLinks(l, { nationwide: nationwide.id, barclaycard: barclaycard.id, barclaycardbt: barclaycard.id, gone: 'no-such-account', chase: '' });
  assert.equal(l2.scheduledItems.filter((r) => r.recordType === LINKS_RECORD_TYPE).length, 1);
  assert.deepEqual(archiveLinks(l2), { nationwide: nationwide.id, barclaycard: barclaycard.id, barclaycardbt: barclaycard.id });
  const l3 = setArchiveLinks(l2, { nationwide: nationwide.id });
  assert.equal(l3.scheduledItems.filter((r) => r.recordType === LINKS_RECORD_TYPE).length, 1);
  assert.deepEqual(archiveLinks(l3), { nationwide: nationwide.id });
  assert.equal(linksRecord(l3).createdAt, linksRecord(l2).createdAt);
  assert.deepEqual(archiveLinks(l), {});
});
test('suggested only on an exact name (case and spaces ignored)', () => {
  const { l, nationwide } = live();
  assert.equal(suggestLink('NATIONWIDE', l.accounts), nationwide.id);
  assert.equal(suggestLink('Barclaycard BT', l.accounts), null);
  assert.equal(suggestLink('Chase', l.accounts), null);
});
test('the record is personal: the joint split keeps it in your own file, and a merge keeps it', () => {
  const { l, nationwide } = live();
  const linked = setArchiveLinks(l, { nationwide: nationwide.id });
  const joint = addJointAccount(emptyJointLedger(), { openingBalance: 0, openingDate: '2026-10-01' });
  const parts = splitLedger(combineLedgers(linked, joint), { personal: linked, joint });
  assert.ok(linksRecord(parts.personal));
  assert.equal(linksRecord(parts.joint), null);
  const merged = mergeLedger({ base: l, local: linked, remote: l });
  assert.deepEqual(archiveLinks(merged.ledger ?? merged.merged ?? merged), { nationwide: nationwide.id });
});

console.log('rows');
test('live: transfer is one row in two columns; notes kept; statement rows and skipped projections left out', () => {
  const { l, current, barclaycard } = live();
  const rows = liveFinderRows(buildGridRows(l, l.accounts));
  const pay = rows.find((r) => r.text === 'Pay Barclaycard');
  assert.deepEqual(pay.cells[current.id], [{ dir: 'out', amount: 2000 }]);
  assert.deepEqual(pay.cells[barclaycard.id], [{ dir: 'in', amount: 2000 }]);
  assert.ok(rows.find((r) => r.text.startsWith('In Spain')));
  assert.equal(liveFinderRows([{ date: '2026-10-20', statement: {}, cells: {}, txIds: [] }]).length, 0);
  assert.equal(liveFinderRows([{ date: '2026-10-20', projection: { skipped: true }, cells: { a: { credit: 5 } }, txIds: ['x'] }]).length, 0);
});
test('live: projected entries are included and marked', () => {
  const { l, current } = live();
  const l2 = addRecurring(l, { kind: 'out', accountId: current.id, description: 'Parking permit', amount: 2500, day: 20, everyMonths: 1, startDate: '2026-10-01' }).ledger;
  const view = withProjections(l2, '2026-12-31', new Set());
  const rows = liveFinderRows(buildGridRows(view, view.accounts)).filter((r) => r.text === 'Parking permit');
  assert.ok(rows.length >= 2 && rows.every((r) => r.projected));
});
test('history: lands in the linked live column, else its own; Brought forward left out', () => {
  const { l, nationwide, barclaycard } = live();
  const links = { nationwide: nationwide.id, barclaycard: barclaycard.id, barclaycardbt: barclaycard.id };
  const rows = archiveFinderRows(history(), links);
  assert.ok(!rows.some((r) => r.text === 'Brought forward'));
  assert.deepEqual(Object.keys(rows.find((r) => r.text === 'Car parking').cells), [nationwide.id]);
  assert.deepEqual(Object.keys(rows.find((r) => r.text === 'Hospital car parking').cells), ['arch:chase']);
  assert.equal(archiveColumn('chase', links), 'arch:chase');
  assert.deepEqual(rows.find((r) => r.text === 'Car parking').ref, { year: 2024, n: 4, sheet: '2024' });
  void l;
});

console.log('internal moves');
test('same day, same amount, out and in from two accounts linked to one card → internal (separate rows and same row)', () => {
  const { nationwide, barclaycard } = live();
  const rows = archiveFinderRows(history(), { nationwide: nationwide.id, barclaycard: barclaycard.id, barclaycardbt: barclaycard.id });
  const by = (t) => rows.find((r) => r.text === t);
  assert.ok(by('Move BT into main (out)').internal);
  assert.ok(by('Move BT into main (in)').internal);
  assert.ok(by('Same row move').internal);
  assert.ok(!by('Balance transfer from MBNA').internal);
  assert.ok(!by('Spend on Barclaycard').internal);
  // the refund (Nationwide in) and the parking (Nationwide out) are different days and the same account → not internal
  assert.ok(!by('Car parking refund').internal && !by('Car parking').internal);
});
test('not linked (or linked to different cards) → nothing is internal', () => {
  const { nationwide, barclaycard, current } = live();
  assert.ok(archiveFinderRows(history(), {}).every((r) => !r.internal));
  assert.ok(archiveFinderRows(history(), { barclaycard: barclaycard.id, barclaycardbt: current.id, nationwide: nationwide.id }).every((r) => !r.internal));
});

console.log('search and totals');
test('one search over history and live: per-year totals, grand total, out and in apart, internal moves left out', () => {
  const { l, nationwide, barclaycard, current } = live();
  const links = { nationwide: nationwide.id, barclaycard: barclaycard.id, barclaycardbt: barclaycard.id };
  const all = [...archiveFinderRows(history(), links), ...liveFinderRows(buildGridRows(l, l.accounts))];
  const r = findRows(all, { query: 'parking' });
  assert.deepEqual(r.years.map((y) => [y.year, y.rows.length]), [[2024, 2], [2025, 1], [2026, 2]]);
  assert.deepEqual(r.years[0].totals[nationwide.id], { in: 1000, out: 1000 });
  assert.deepEqual(r.years[2].totals[nationwide.id], { in: 0, out: 1500 }); // 5 Oct 2026 lands with 2024's Nationwide
  assert.deepEqual(r.totals[nationwide.id], { in: 1000, out: 2500 });
  assert.deepEqual(r.totals['arch:chase'], { in: 0, out: 350 });
  assert.ok(r.years[2].rows.some((x) => x.text.startsWith('In Spain'))); // a note matches by its text
  const moves = findRows(all, { query: 'move' });
  assert.equal(moves.count, 3);
  assert.deepEqual(moves.totals[barclaycard.id], { in: 0, out: 0 }); // all internal
  const bc = findRows(all, { query: '', columns: new Set([barclaycard.id]) });
  assert.ok(bc.rows === undefined && bc.count === 6, String(bc.count));
  assert.deepEqual(Object.keys(bc.totals), [barclaycard.id]);
  assert.deepEqual(bc.totals[barclaycard.id], { in: 2000, out: 53000 }); // MBNA BT £500 + spend £30; Pay Barclaycard 2000 in
  void current;
});
test('date order inside a year; history before live on a shared date', () => {
  const rows = [
    { source: 'live', date: '2026-10-02', text: 'b', cells: {} },
    { source: 'archive', date: '2026-03-01', text: 'b', cells: {} },
    { source: 'archive', date: '2026-01-05', text: 'b', cells: {} },
  ];
  assert.deepEqual(findRows(rows, { query: 'b' }).years[0].rows.map((x) => x.date), ['2026-01-05', '2026-03-01', '2026-10-02']);
});
test('columns: live accounts first in their order, then unlinked history accounts', () => {
  const { l, nationwide, barclaycard } = live();
  const liveCols = l.accounts.map((a) => ({ id: a.id, name: a.name, colour: '#000' }));
  const cols = finderColumns(liveCols, history(), { nationwide: nationwide.id, barclaycard: barclaycard.id });
  assert.deepEqual(cols.map((c) => c.name), ['Current Account', 'Nationwide', 'Barclaycard', 'Barclaycard BT', 'Chase']);
  assert.deepEqual(cols.filter((c) => c.history).map((c) => c.id), ['arch:barclaycardbt', 'arch:chase']);
  assert.equal(finderColumns(liveCols, null, {}).length, 3);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
