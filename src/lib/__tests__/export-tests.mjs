// Run with: node src/lib/__tests__/export-tests.mjs
// v0.15.4: Export to Excel — columns, grey before/after an account's data,
// Brought forward per year, history + live in one sheet, and the written
// .xlsx read back by the app's own reader and History import. Made-up figures.
import assert from 'node:assert/strict';
import { emptyLedger, addAccount, addTransaction, updateAccount } from '../ops.js';
import { buildGridRows } from '../grid.js';
import { parseSheet, buildYear, emptyArchive, withYears } from '../archive.js';
import {
  exportColumns, earliestDate, buildExport, liveExportRows, exportWorkbook, blockFields, tint, GREY, MAX_DATE,
} from '../excel-export.js';
import { writeWorkbook, crc32, columnName, safeSheetNames, zip } from '../xlsx-write.js';
import { readWorkbook } from '../xlsx-read.js';

let passed = 0;
let failed = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }
const S = (y, m, d) => Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);

/** History: 2019 with Halifax (an old current account) and Nationwide; 2020 Nationwide only. */
function history() {
  const y1 = buildYear(parseSheet({ name: '2019', rows: [
    [null, null, 'HALIFAX', null, null, 'NATIONWIDE'],
    ['Date', 'Description', 'Credit', 'Debit', 'Balance', 'Credit', 'Debit', 'Balance'],
    [S(2019, 1, 1), 'Brought forward', null, null, 100, null, null, 0],
    [S(2019, 2, 3), 'Wages', 1000, null, 1100, null, null, 0],
    [S(2019, 3, 4), 'In Greece', null, null, null, null, null, null],
    [S(2019, 4, 5), 'Car parking', null, null, 1100, null, 5, 5],
    [S(2019, 12, 20), 'Close Halifax', null, 1100, 0, null, null, 5],
  ] }), ['Halifax', 'Nationwide']);
  const y2 = buildYear(parseSheet({ name: '2020', rows: [
    [null, null, 'NATIONWIDE'],
    ['Date', 'Description', 'Credit', 'Debit', 'Balance'],
    [S(2020, 1, 1), 'Brought forward', null, null, 5],
    [S(2020, 6, 1), 'Shopping', null, 20, 25],
  ] }), ['Nationwide']);
  return withYears(emptyArchive(), [y1, y2]);
}

function live() {
  let r = addAccount(emptyLedger(), { name: 'Current Account', type: 'current', institution: 'other', openingBalance: 50000, openingDate: '2026-10-01' });
  const current = r.account;
  r = addAccount(r.ledger, { name: 'Nationwide', type: 'credit', institution: 'nationwide', openingBalance: 2500, openingDate: '2026-10-01' });
  const nationwide = r.account;
  r = addAccount(r.ledger, { name: 'Joint', type: 'current', institution: 'other', openingBalance: 10000, openingDate: '2026-10-15' });
  const joint = r.account;
  let l = r.ledger;
  l = addTransaction(l, { accountId: current.id, date: '2026-10-02', amount: 1200, direction: 'debit', description: 'Groceries' });
  l = addTransaction(l, { accountId: nationwide.id, date: '2026-10-03', amount: 800, direction: 'debit', description: 'Fuel' });
  l = addTransaction(l, { accountId: current.id, date: '2026-10-20', amount: 5000, direction: 'debit', description: 'To bills account', counterpartAccountId: joint.id });
  l = addTransaction(l, { accountId: current.id, date: '2027-01-05', kind: 'note', description: 'New year' });
  return { l, current, nationwide, joint };
}

function liveAccounts(l) {
  return l.accounts.map((a) => ({
    id: a.id, name: a.name, colour: '#1d4ed8', openingDate: a.openingDate,
    opening: a.type === 'credit' ? a.openingBalance : a.openingBalance, active: a.active !== false,
    lastDate: l.transactions.filter((t) => t.accountId === a.id).map((t) => t.date).sort().pop() ?? null,
    envelopes: false,
  }));
}

function setup(range = {}) {
  const archive = history();
  const { l, current, nationwide, joint } = live();
  const columns = exportColumns(liveAccounts(l), archive);
  const liveRows = liveExportRows(buildGridRows(l, l.accounts));
  return { archive, l, current, nationwide, joint, columns, liveRows, ...range };
}

const cellsOf = (sheet, text) => sheet.rows.find((r) => r.text === text)?.cells;

queue.push([null, 'columns']);
test('live accounts first; a same-named history account continues in the live column; others keep their own names', () => {
  const { columns, nationwide } = setup();
  assert.deepEqual(columns.map((c) => c.name), ['Current Account', 'Nationwide', 'Joint', 'Halifax']);
  const nw = columns.find((c) => c.id === nationwide.id);
  assert.equal(nw.histKey, 'nationwide');
  assert.equal(nw.start, '2019-01-01'); // history start
  assert.equal(nw.end, MAX_DATE);
  const hx = columns.find((c) => c.name === 'Halifax');
  assert.equal(hx.id, 'arch:halifax');
  assert.deepEqual([hx.start, hx.end], ['2019-01-01', '2019-12-20']);
  assert.equal(earliestDate(columns), '2019-01-01');
});
test('a closed (inactive) live account ends at its last entry', () => {
  const { l, joint } = live();
  const l2 = updateAccount(l, joint.id, { active: false });
  const cols = exportColumns(liveAccounts(l2), null);
  assert.equal(cols.find((c) => c.id === joint.id).end, '2026-10-20');
});
test('block: Credit, Debit, Balance, then Envelope on envelope accounts and ✓ on live ones', () => {
  assert.deepEqual(blockFields({ live: false, envelopes: false }), ['credit', 'debit', 'balance']);
  assert.deepEqual(blockFields({ live: true, envelopes: true }), ['credit', 'debit', 'balance', 'env', 'rec']);
});

queue.push([null, 'rows']);
test('one sheet per year with a Brought forward row; history and live in the same column', () => {
  const s = setup();
  const m = buildExport({ ...s, selected: s.columns.map((c) => c.id), from: '2019-01-01', to: '2027-01-31' });
  assert.deepEqual(m.sheets.map((x) => x.year), [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026, 2027]);
  for (const sh of m.sheets) assert.equal(sh.rows[0].kind, 'bf');
  // 2019's own Brought forward is folded into ours: Halifax 100.00, Nationwide 0
  const bf19 = m.sheets[0].rows[0].cells;
  assert.equal(bf19['arch:halifax'].balance, 10000);
  assert.equal(bf19[s.nationwide.id].balance, 0);
  assert.equal(m.sheets[0].rows.filter((r) => r.text === 'Brought forward').length, 1);
  // 2021 brings forward Nationwide's 2020 closing balance; Halifax closed in 2019 → grey
  const bf21 = m.sheets[2].rows[0].cells;
  assert.equal(bf21[s.nationwide.id].balance, 2500);
  assert.equal(bf21['arch:halifax'].grey, true);
  // the live opening balance sits in the same Nationwide column on 1 Oct 2026
  const open = m.sheets[7].rows.find((r) => r.kind === 'opening');
  assert.equal(open.date, '2026-10-01');
  assert.equal(open.text, 'Opening balances');
  assert.equal(open.cells[s.nationwide.id].balance, 2500);
  assert.equal(cellsOf(m.sheets[7], 'Fuel')[s.nationwide.id].debit, 800);
});
test('grey before an account has data (the joint account in 2019) and after it closed', () => {
  const s = setup();
  const m = buildExport({ ...s, selected: s.columns.map((c) => c.id), from: '2019-01-01', to: '2026-12-31' });
  const wages = cellsOf(m.sheets[0], 'Wages');
  assert.equal(wages[s.joint.id].grey, true);
  assert.equal(wages[s.current.id].grey, true);
  assert.equal(wages['arch:halifax'].credit, 100000);
  const groceries = cellsOf(m.sheets[7], 'Groceries');
  assert.equal(groceries[s.joint.id].grey, true); // joint opens 15 Oct
  assert.equal(groceries['arch:halifax'].grey, true);
  assert.equal(groceries[s.current.id].balance, 48800);
  const bills = cellsOf(m.sheets[7], 'To bills account');
  assert.equal(bills[s.joint.id].credit, 5000);
  assert.equal(bills[s.joint.id].balance, 15000);
  assert.equal(bills[s.current.id].debit, 5000);
});
test('only the chosen accounts: rows with nothing in them are left out, balances still run', () => {
  const s = setup();
  const m = buildExport({ ...s, selected: [s.joint.id], from: '2026-10-01', to: '2026-12-31' });
  assert.deepEqual(m.columns.map((c) => c.id), [s.joint.id]);
  const texts = m.sheets[0].rows.map((r) => r.text);
  assert.deepEqual(texts, ['Brought forward', 'Opening balance', 'To bills account']);
  assert.equal(m.sheets[0].rows[0].cells[s.joint.id].grey, true);
});
test('a range starting mid-way brings forward the balance as of that day', () => {
  const s = setup();
  const m = buildExport({ ...s, selected: [s.current.id, s.nationwide.id], from: '2026-10-10', to: '2026-10-31' });
  const bf = m.sheets[0].rows[0];
  assert.equal(bf.date, '2026-10-10');
  assert.equal(bf.cells[s.current.id].balance, 48800);
  assert.equal(bf.cells[s.nationwide.id].balance, 3300);
  assert.equal(m.sheets[0].rows.some((r) => r.kind === 'opening'), false);
});
test('an opening on the first day folds into Brought forward', () => {
  const s = setup();
  const m = buildExport({ ...s, selected: [s.current.id], from: '2026-10-01', to: '2026-10-31' });
  assert.equal(m.sheets[0].rows[0].cells[s.current.id].balance, 50000);
  assert.equal(m.sheets[0].rows.some((r) => r.kind === 'opening'), false);
});
test('a history note row (no money) stays when one of its sheet’s accounts is chosen', () => {
  const s = setup();
  const m = buildExport({ ...s, selected: ['arch:halifax'], from: '2019-01-01', to: '2019-12-31' });
  assert.ok(m.sheets[0].rows.some((r) => r.text === 'In Greece' && r.note));
  const m2 = buildExport({ ...s, selected: [s.joint.id], from: '2019-01-01', to: '2019-12-31' });
  assert.deepEqual(m2.sheets[0].rows.map((r) => r.text), ['Brought forward']);
});
test('a bad range or no accounts is refused', () => {
  const s = setup();
  assert.throws(() => buildExport({ ...s, selected: [s.current.id], from: '2026-11-01', to: '2026-10-01' }), /From date/);
  assert.throws(() => buildExport({ ...s, selected: [], from: '2026-10-01', to: '2026-10-31' }), /at least one/);
});
test('live rows: skipped projections out; statement rows named by the app; reconciled and envelopes per cell', () => {
  const rows = [
    { date: '2026-10-02', description: 'A', kind: 'expense', cells: { a: { txId: 't1', credit: null, debit: 100 } }, balances: { a: -100 }, projection: null },
    { date: '2026-10-03', description: 'B', kind: 'expense', cells: { a: { txId: 't2', credit: null, debit: 5 } }, balances: { a: -105 }, projection: { skipped: true } },
    { date: '2026-10-17', description: 'Statement', kind: 'note', cells: { a: { txId: 's', credit: null, debit: null, note: true } }, balances: { a: -100 }, statement: { owed: 100 } },
  ];
  const out = liveExportRows(rows, { reconciledIds: new Set(['t1']), envText: () => 'Transport', statementText: () => 'Barclaycard statement', colourOf: () => '#00aeef' });
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].cells.a, { credit: null, debit: 100, rec: true, env: 'Transport' });
  assert.equal(out[1].kind, 'statement');
  assert.equal(out[1].text, 'Barclaycard statement');
  assert.equal(out[1].statementOf, 'a');
});

queue.push([null, 'the workbook']);
test('sheet layout: names over the blocks, headers, borders between accounts, grey fills, money in pounds', () => {
  const s = setup();
  const m = buildExport({ ...s, selected: [s.current.id, s.joint.id], from: '2026-10-01', to: '2026-10-31' });
  const wb = exportWorkbook(m);
  const sh = wb.sheets[0];
  assert.equal(sh.name, '2026');
  assert.equal(sh.rows[0][2].v, 'Current Account');
  assert.deepEqual(sh.merges, ['C1:F1', 'G1:J1']);
  assert.deepEqual(sh.rows[1].map((c) => c.v), ['Date', 'Description', 'Credit', 'Debit', 'Balance', '✓', 'Credit', 'Debit', 'Balance', '✓', 'Status']);
  // the last column of each block has the vertical border, on every row
  for (const row of sh.rows) { assert.equal(row[5].s.right, 'medium'); assert.equal(row[9].s.right, 'medium'); assert.equal(row[1].s.right, 'medium'); }
  const groceries = sh.rows.find((r) => r[1].v === 'Groceries');
  assert.equal(groceries[3].v, 12);
  assert.equal(groceries[4].v, 488);
  assert.equal(groceries[3].s.numFmt, 'money');
  assert.equal(groceries[6].s.fill, GREY); // joint not open yet
  assert.equal(groceries[0].v, S(2026, 10, 2));
  assert.equal(groceries[0].s.numFmt, 'date');
});
test('statement rows: upper case and tinted with the card’s colour; projected rows italic grey', () => {
  const model = {
    columns: [{ id: 'a', name: 'Barclaycard', colour: '#00aeef', live: true, envelopes: false }],
    sheets: [{ year: 2026, rows: [
      { kind: 'row', date: '2026-10-17', text: 'Barclaycard statement · 120.00 owed', statement: true, tint: '#00aeef', status: 'Estimate', cells: { a: { balance: 12000 } } },
      { kind: 'row', date: '2026-11-28', text: 'Salary', projected: true, status: 'Projected', cells: { a: { credit: 100, balance: 12100 } } },
    ] }],
  };
  const rows = exportWorkbook(model).sheets[0].rows;
  assert.equal(rows[2][1].v, 'BARCLAYCARD STATEMENT · 120.00 OWED');
  assert.equal(rows[2][1].s.fill, tint('#00aeef'));
  assert.equal(rows[3][1].s.italic, true);
  assert.equal(rows[3][6].v, 'Projected');
  assert.equal(rows[3][0].s.top, 'thin'); // a new month: a line across, like the grid
});
test('writer basics: CRC-32, column names, sheet names Excel accepts', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.deepEqual([0, 25, 26, 27, 701, 702].map(columnName), ['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
  assert.deepEqual(safeSheetNames(['2026', '2026', 'a/b']), ['2026', '2026 (2)', 'a b']);
});
test('round trip: the app’s own reader opens the file, compressed or not', async () => {
  const s = setup();
  const m = buildExport({ ...s, selected: s.columns.map((c) => c.id), from: '2019-01-01', to: '2027-01-31' });
  for (const compress of [true, false]) {
    const bytes = await writeWorkbook(exportWorkbook(m), { compress });
    const wb = await readWorkbook(bytes);
    assert.deepEqual(wb.sheets.map((x) => x.name), ['2019', '2020', '2021', '2022', '2023', '2024', '2025', '2026', '2027']);
    const rows = wb.sheets[0].rows;
    assert.equal(rows[0][2], 'Current Account');
    assert.equal(rows[1][0], 'Date');
    assert.equal(rows[3][1], 'Wages');
    assert.equal(rows[3][0], S(2019, 2, 3));
  }
});
test('round trip: an exported history year imports back into History with the same figures', async () => {
  const s = setup();
  const m = buildExport({ ...s, selected: ['arch:halifax', s.nationwide.id], from: '2019-01-01', to: '2019-12-31' });
  const wb = await readWorkbook(await writeWorkbook(exportWorkbook(m)));
  const parsed = parseSheet(wb.sheets[0]);
  assert.equal(parsed.problem, null);
  assert.equal(parsed.year, 2019);
  assert.deepEqual(parsed.groups.map((g) => g.label), ['Halifax', 'Nationwide']);
  const y = buildYear(parsed, ['Halifax', 'Nationwide']);
  const orig = s.archive.years[2019];
  const strip = (rows) => rows.map((r) => [r.d, r.t, JSON.stringify(Object.fromEntries(Object.entries(r.v).map(([k, v]) => [k, v.slice(0, 2)])))]);
  // same rows and amounts (balances are carried on every row in the export, so compare amounts)
  assert.deepEqual(strip(y.rows.filter((r) => !r.bf && Object.values(r.v).some((v) => v[0] !== null || v[1] !== null))),
    strip(orig.rows.filter((r) => !r.bf && Object.values(r.v).some((v) => v[0] !== null || v[1] !== null))));
  assert.deepEqual(y.rows.find((r) => r.bf).v, { halifax: [null, null, 10000], nationwide: [null, null, 0] });
});
test('zip: an empty file and a stored entry are fine', async () => {
  const bytes = await zip([{ name: 'a.txt', data: new Uint8Array(0) }], { compress: false });
  assert.equal(new DataView(bytes.buffer).getUint32(0, true), 0x04034b50);
});

let section = null;
for (const [name, fn] of queue) {
  if (name === null) { section = fn; console.log(section); continue; }
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
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
