// Run with: node src/lib/__tests__/archive-tests.mjs
// v0.14.8: history imported from Excel — the .xlsx reader, sheet parsing,
// names, checks, viewing and search. Figures in the fixture are made up.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readWorkbook, sheetRows, columnIndex, decodeXml } from '../xlsx-read.js';
import {
  cellPence, cellDate, isGenericLabel, suggestName, nameMemoryKey, accountKey, institutionFor,
  findLayout, parseSheet, buildYear, balanceConvention, mismatches, outOfOrderRows, checkYear, checkCount,
  emptyArchive, withYears, yearsOf, archiveAccounts, validYear, yearView, matches, searchArchive,
  closingBalances, openingBalances, archiveFileName, ARCHIVE_FILE_RE,
} from '../archive.js';
import { uploadArchiveYears, downloadArchiveYears, trashArchiveYears } from '../archive-drive.js';
import { createFakeDrive } from './fake-drive.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }

// Excel serial for a date (1900 system)
const S = (y, m, d) => Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);

/** A sheet laid out like Budget.xlsx: three triplets, labels in the two rows above the header. */
function budgetLike(rows, name = '2026') {
  return {
    name,
    rows: [
      [null, null, 'Current Account', null, null, 'Credit Card', null, null, 'Credit Card'],
      [null, null, null, null, null, 'NATIONWIDE', null, null, 'BARCLAYCARD'],
      ['Date', 'Description', 'Credit', 'Debit', 'Balance', 'Credit', 'Debit', 'Balance', 'Credit', 'Debit', 'Balance'],
      ...rows,
    ],
  };
}
const NAMES = ['Chase current account', 'Nationwide', 'Barclaycard'];

queue.push([null, 'values']);
test('pence: float noise from the spreadsheet is rounded away; -0 never appears', () => {
  assert.equal(cellPence(1366.0100000000002), 136601);
  assert.equal(cellPence(19.989999999999998), 1999);
  assert.equal(cellPence(0.1 + 0.2), 30);
  assert.equal(cellPence(-0.004), 0);
  assert.ok(!Object.is(cellPence(-0.004), -0));
  assert.equal(cellPence(-12.345), -1235);
  assert.equal(cellPence('£1,234.56'), 123456);
  assert.equal(cellPence(''), null);
  assert.equal(cellPence('n/a'), null);
  assert.equal(cellPence(true), null);
});
test('dates: Excel serials (1900 and 1904 systems) and typed dates', () => {
  assert.equal(cellDate(46022), '2025-12-31');
  assert.equal(cellDate(46023), '2026-01-01');
  assert.equal(cellDate(46023.75), '2026-01-01'); // a time part is ignored
  assert.equal(cellDate(S(2019, 2, 28)), '2019-02-28');
  assert.equal(cellDate(0, true), null);
  assert.equal(cellDate(44561, true), '2026-01-01'); // 1904 system is 1462 days behind
  assert.equal(cellDate('05/03/2021'), '2021-03-05'); // UK day/month
  assert.equal(cellDate('2021-03-05'), '2021-03-05');
  assert.equal(cellDate('31/02/2021'), null);
  assert.equal(cellDate('Brought forward'), null);
});

queue.push([null, 'names']);
test('generic labels are spotted (asked per sheet); bank names are not', () => {
  for (const l of ['Current Account', 'current', 'Credit Card', 'Savings', 'Savings account', '', 'Joint account']) assert.ok(isGenericLabel(l), l);
  for (const l of ['NATIONWIDE', 'BARCLAYCARD', 'Chase', 'Monzo pots']) assert.ok(!isGenericLabel(l), l);
});
test('suggested names: known banks get their proper name, the rest title case', () => {
  assert.equal(suggestName('NATIONWIDE'), 'Nationwide');
  assert.equal(suggestName('BARCLAYCARD'), 'Barclaycard');
  assert.equal(suggestName('MONZO FLEX'), 'Monzo Flex');
  assert.equal(suggestName('HALIFAX ISA'), 'Halifax Isa');
  assert.equal(suggestName('Current Account'), 'Current Account');
  assert.equal(institutionFor('Chase current account'), 'chase');
});
test('remembered names: per label, but per sheet for a generic label', () => {
  assert.equal(nameMemoryKey('2026', 'Nationwide'), 'NATIONWIDE');
  assert.equal(nameMemoryKey('2026', 'Current Account'), '2026::CURRENT ACCOUNT');
  assert.equal(accountKey('Barclay Card'), accountKey('barclaycard'));
});

queue.push([null, 'one sheet']);
test('layout: the header row, each triplet, and the label closest above it', () => {
  const l = findLayout(budgetLike([]).rows);
  assert.equal(l.headerRow, 2);
  assert.equal(l.dateCol, 0);
  assert.equal(l.descCol, 1);
  assert.deepEqual(l.groups.map((g) => [g.credit, g.debit, g.balance, g.label]), [
    [2, 3, 4, 'Current Account'], [5, 6, 7, 'NATIONWIDE'], [8, 9, 10, 'BARCLAYCARD'],
  ]);
  assert.deepEqual(l.groups[1].context, ['Credit Card']);
});
test('a sheet with no header is reported, not guessed', () => {
  const p = parseSheet({ name: 'Notes', rows: [['Some notes'], ['more']] });
  assert.ok(p.problem);
  assert.equal(p.rows.length, 0);
});
test('rows: blank rows dropped, Brought forward marked, Excel row numbers kept, a missing date takes the one above', () => {
  const p = parseSheet(budgetLike([
    [S(2026, 1, 1), 'Brought forward', null, null, 3600, null, null, 6, null, null, 1000],
    [],
    [S(2026, 1, 2), 'Lottery', null, 15, 3585, null, null, null, null, null, null],
    [null, 'Note without a date', null, null, null],
    [null, null, null, null, null], // blank
  ]));
  assert.equal(p.year, 2026);
  assert.equal(p.rows.length, 3);
  assert.deepEqual(p.rows.map((r) => r.n), [4, 6, 7]);
  assert.ok(p.rows[0].bf);
  assert.equal(p.rows[2].d, '2026-01-02');
  assert.ok(p.rows[2].noDate);
  assert.deepEqual(p.rows[1].vals[0], [null, 1500, 358500]);
});
test('the year comes from the sheet name, or else from its dates', () => {
  assert.equal(parseSheet(budgetLike([[S(2021, 5, 1), 'x', 1, null, 1]], '2022')).year, 2022);
  assert.equal(parseSheet(budgetLike([[S(2021, 5, 1), 'x', 1, null, 1], [S(2021, 6, 1), 'y', 1, null, 2]], 'Old')).year, 2021);
});

queue.push([null, 'building a year']);
const SAMPLE_2026 = budgetLike([
  [S(2026, 1, 1), 'Brought forward', null, null, 3600, null, null, 6, null, null, 1000],
  [S(2026, 1, 2), 'Loveholidays (on Barclaycard)', null, null, 3600, null, null, 6, null, 274.95, 1274.95],
  [S(2026, 1, 2), 'To bills account', null, 1850, 1750, null, null, 6, null, null, 1274.95],
  [S(2026, 1, 9), 'Dreaming Spanish (on Nationwide)', null, null, 1750, null, 5.98, 11.98, null, null, 1274.95],
  [S(2026, 1, 12), 'BARCLAYCARD STATEMENT', null, null, 1750, null, null, 11.98, null, null, 1274.95],
  [S(2026, 1, 15), 'Barclaycard direct debit', null, 700, 1050, null, null, 11.98, 700, null, 574.95],
  [S(2026, 1, 20), 'Claude Pro (on Barclaycard)', null, null, 1050, null, null, null, null, 18, 592.95], // blank Nationwide balance
  [S(2026, 2, 3), 'Car parking (on Barclaycard)', null, null, 1050, null, null, 11.98, null, 6.39, 599.34],
  [S(2026, 2, 5), 'Note row', null, null, 1050, null, null, 11.98, null, null, 599.34],
  [S(2026, 1, 25), 'Hospital car park (on Barclaycard)', null, null, 1050, null, null, 11.98, null, 3.5, 602.84], // out of order
  [S(2026, 2, 10), 'Typo row', null, 10, 1045, null, null, 11.98, null, null, 602.84], // 1050 - 10 = 1040: stored wrong
  [S(2026, 2, 28), 'Salary', 4000, null, 5045, null, null, 11.98, null, null, 602.84],
  [S(2026, 10, 2), 'Already in the app (live data)', null, 5, 5040, null, null, 11.98, null, null, 602.84],
  [S(2026, 12, 28), 'Forecast row', 4000, null, 9040, null, null, 11.98, null, null, 602.84],
]);

test('rows from the first live day on are left out and counted', () => {
  const y = buildYear(parseSheet(SAMPLE_2026), NAMES, { firstLiveDate: '2026-10-01' });
  assert.equal(y.leftOut, 2);
  assert.ok(y.rows.every((r) => r.d < '2026-10-01'));
  assert.equal(y.rows.length, 12);
});
test('accounts: keys from names, card convention found from the figures, colours from the bank', () => {
  const y = buildYear(parseSheet(SAMPLE_2026), NAMES, { firstLiveDate: '2026-10-01' });
  assert.deepEqual(y.accounts.map((a) => [a.key, a.name, a.card]), [
    ['chasecurrentaccount', 'Chase current account', false], ['nationwide', 'Nationwide', true], ['barclaycard', 'Barclaycard', true],
  ]);
  assert.equal(y.accounts[2].colour, '#037CC2');
  assert.equal(y.accounts[0].colour, '#117ACA'); // Chase
});
test('a column group can be left out; the same name twice on one sheet is refused', () => {
  const y = buildYear(parseSheet(SAMPLE_2026), ['Chase', '', 'Barclaycard'], {});
  assert.deepEqual(y.accounts.map((a) => a.key), ['chase', 'barclaycard']);
  assert.ok(y.rows.every((r) => !r.v.nationwide));
  assert.throws(() => buildYear(parseSheet(SAMPLE_2026), ['Chase', 'Chase', 'Barclaycard'], {}), /used twice/);
  assert.throws(() => buildYear(parseSheet(SAMPLE_2026), ['', '', ''], {}), /Nothing to import/);
});
test('stored values are kept exactly as the sheet shows them (balances not recalculated)', () => {
  const y = buildYear(parseSheet(SAMPLE_2026), NAMES, { firstLiveDate: '2026-10-01' });
  const typo = y.rows.find((r) => r.t === 'Typo row');
  assert.deepEqual(typo.v.chasecurrentaccount, [null, 1000, 104500]);
  const claude = y.rows.find((r) => r.t.startsWith('Claude'));
  assert.deepEqual(claude.v.nationwide, undefined); // nothing in Nationwide's columns on that row
});

queue.push([null, 'checks']);
test('balance check: a wrong stored balance is reported once, with what it should be', () => {
  const y = buildYear(parseSheet(SAMPLE_2026), NAMES, { firstLiveDate: '2026-10-01' });
  const c = checkYear(y);
  assert.equal(c.balances.length, 1);
  assert.deepEqual([c.balances[0].t, c.balances[0].expected, c.balances[0].stored], ['Typo row', 104000, 104500]);
  // the Salary row after it is right relative to the stored 1045 — no knock-on report
});
test('balance check: card convention (spends add to what is owed) vs bank', () => {
  const rows = [
    { n: 1, d: '2026-01-01', bf: true, v: { k: [null, null, 1000] } },
    { n: 2, d: '2026-01-02', v: { k: [null, 500, 1500] } },
    { n: 3, d: '2026-01-03', v: { k: [700, null, 800] } },
  ];
  assert.equal(mismatches(rows, 'k', 'card').length, 0);
  assert.equal(mismatches(rows, 'k', 'bank').length, 2);
  assert.equal(balanceConvention(rows, 'k'), 'card');
  // nothing moved: a tie → the label decides
  const flat = [{ n: 1, d: '2026-01-01', v: { k: [null, null, 5] } }];
  assert.equal(balanceConvention(flat, 'k', 'Credit Card'), 'card');
  assert.equal(balanceConvention(flat, 'k', 'Current Account'), 'bank');
});
test('balance check: a blank balance cell is carried, not reported', () => {
  const rows = [
    { n: 1, d: '2026-01-01', bf: true, v: { k: [null, null, 1000] } },
    { n: 2, d: '2026-01-02', v: { k: [null, 100, null] } },
    { n: 3, d: '2026-01-03', v: { k: [null, 100, 800] } },
  ];
  assert.deepEqual(mismatches(rows, 'k', 'bank'), []);
});
test('out of order: only the stray row is flagged, not its neighbours', () => {
  const d = (n, day) => ({ n, d: `2026-08-${String(day).padStart(2, '0')}` });
  const rows = [d(1, 1), d(2, 5), d(3, 9), d(4, 30), d(5, 10), d(6, 12), d(7, 15)];
  assert.deepEqual([...outOfOrderRows(rows)], [4]);
  const early = [d(1, 1), d(2, 10), d(3, 11), d(4, 2), d(5, 12), d(6, 13)];
  assert.deepEqual([...outOfOrderRows(early)], [4]);
  // same-day rows are fine in any order
  assert.deepEqual([...outOfOrderRows([d(1, 3), d(2, 3), d(3, 3)])], []);
  assert.deepEqual([...outOfOrderRows([])], []);
});
test('out of order: reported with the dates either side', () => {
  const y = buildYear(parseSheet(SAMPLE_2026), NAMES, { firstLiveDate: '2026-10-01' });
  const c = checkYear(y);
  assert.equal(c.outOfOrder.length, 1);
  assert.equal(c.outOfOrder[0].t, 'Hospital car park (on Barclaycard)');
  assert.deepEqual(c.outOfOrder[0].between, ['2026-02-05', '2026-02-10']);
});
test('brought forward chain: compared with last year’s closing balance for the same account', () => {
  const y2026 = buildYear(parseSheet(SAMPLE_2026), NAMES, { firstLiveDate: '2026-10-01' });
  const prev = buildYear(parseSheet(budgetLike([
    [S(2025, 12, 30), 'Something', null, 1, 3600, null, null, 6, null, null, 999],
  ], '2025')), NAMES, {});
  const c = checkYear(y2026, prev);
  assert.deepEqual(c.chain.map((x) => [x.name, x.opening, x.previousClosing]), [['Barclaycard', 100000, 99900]]);
  assert.equal(checkCount(c), c.balances.length + c.outOfOrder.length + 1);
  assert.deepEqual(closingBalances(prev), { chasecurrentaccount: 360000, nationwide: 600, barclaycard: 99900 });
  assert.deepEqual(openingBalances(y2026), { chasecurrentaccount: 360000, nationwide: 600, barclaycard: 100000 });
});

queue.push([null, 'viewing and search']);
test('year view: carried balances for blank cells; month lines only between in-order rows', () => {
  const y = buildYear(parseSheet(SAMPLE_2026), NAMES, { firstLiveDate: '2026-10-01' });
  const v = yearView(y);
  const claude = v.find((x) => x.row.t.startsWith('Claude'));
  assert.equal(claude.bal.nationwide.value, 1198); // carried from the row above
  assert.equal(claude.bal.nationwide.changed, false);
  assert.equal(claude.bal.barclaycard.changed, true);
  const starts = v.filter((x) => x.monthStart).map((x) => x.row.t);
  assert.deepEqual(starts, ['Car parking (on Barclaycard)']); // the stray 25 Jan row after it adds no line back
  const stray = v.find((x) => x.row.t.startsWith('Hospital'));
  assert.ok(stray.outOfOrder);
  assert.ok(!v.find((x) => x.row.t === 'Typo row').monthStart);
});
test('search words: all must appear, any case, any order', () => {
  assert.ok(matches('Car parking (on Barclaycard)', 'parking car'));
  assert.ok(matches('Car Park at hospital', 'car park'));
  assert.ok(!matches('Car insurance', 'car parking'));
  assert.ok(matches('anything', '  '));
});

function sampleArchive() {
  const y2026 = buildYear(parseSheet(SAMPLE_2026), NAMES, { firstLiveDate: '2026-10-01', importedAt: 'T' });
  const y2025 = buildYear(parseSheet(budgetLike([
    [S(2025, 1, 1), 'Brought forward', null, null, 100, null, null, 0, null, null, 0],
    [S(2025, 3, 1), 'Car parking (on Barclaycard)', null, null, 100, null, null, 0, null, 5, 5],
    [S(2025, 4, 1), 'Car parking refund', null, null, 100, null, null, 0, 2, null, 3],
    [S(2025, 5, 1), 'Car parking', null, 3, 97, null, null, 0, null, null, 3],
  ], '2025')), NAMES, { importedAt: 'T' });
  return withYears(emptyArchive(), [y2026, y2025], { NATIONWIDE: 'Nationwide' });
}

test('search across all years: rows per year, a total per year and a grand total; Brought forward never matches', () => {
  const r = searchArchive(sampleArchive(), { query: 'car park' });
  assert.deepEqual(r.years.map((y) => [y.year, y.count]), [[2025, 3], [2026, 2]]);
  assert.equal(r.count, 5);
  assert.deepEqual(r.years[0].totals.barclaycard, { credit: 200, debit: 500 });
  assert.deepEqual(r.years[0].totals.chasecurrentaccount, { credit: 0, debit: 300 });
  assert.deepEqual(r.years[1].totals.barclaycard, { credit: 0, debit: 989 });
  assert.deepEqual(r.totals.barclaycard, { credit: 200, debit: 1489 });
  assert.equal(searchArchive(sampleArchive(), { query: 'brought' }).count, 0);
});
test('search filtered to one account: only rows with an amount there, totals for it only', () => {
  const r = searchArchive(sampleArchive(), { query: 'car parking', accountKeys: new Set(['chasecurrentaccount']) });
  assert.equal(r.count, 1);
  assert.deepEqual(Object.keys(r.totals), ['chasecurrentaccount']);
});
test('date order: sorted by date within each year (same-day rows keep the sheet order)', () => {
  const sheet = searchArchive(sampleArchive(), { query: 'on barclaycard' }).years.find((y) => y.year === 2026).items.map((x) => x.row.d);
  const dated = searchArchive(sampleArchive(), { query: 'on barclaycard', order: 'date' }).years.find((y) => y.year === 2026).items.map((x) => x.row.d);
  assert.notDeepEqual(sheet, dated);
  assert.deepEqual(dated, [...dated].sort());
});
test('archive: importing a year again replaces it; names are remembered; accounts joined by name across years', () => {
  const a = sampleArchive();
  assert.deepEqual(yearsOf(a).map((y) => y.year), [2025, 2026]);
  const again = withYears(a, [{ ...a.years[2025], sheet: 'again' }], { '2025::CURRENT ACCOUNT': 'Chase current account' });
  assert.equal(again.years[2025].sheet, 'again');
  assert.equal(again.names.NATIONWIDE, 'Nationwide');
  assert.equal(again.names['2025::CURRENT ACCOUNT'], 'Chase current account');
  const accs = archiveAccounts(a);
  assert.deepEqual(accs.map((x) => [x.key, x.firstYear, x.lastYear]), [
    ['chasecurrentaccount', 2025, 2026], ['nationwide', 2025, 2026], ['barclaycard', 2025, 2026],
  ]);
  assert.ok(validYear(a.years[2026]));
  assert.ok(!validYear({ ...a.years[2026], version: 99 }));
  assert.ok(!validYear({ format: 'x' }));
  assert.ok(ARCHIVE_FILE_RE.test(archiveFileName(2019)));
});

queue.push([null, '.xlsx reader']);
test('columns and XML text: AB → 27, entities and Excel’s _x000D_ escape', () => {
  assert.equal(columnIndex('A1'), 0);
  assert.equal(columnIndex('Z9'), 25);
  assert.equal(columnIndex('AB12'), 27);
  assert.equal(decodeXml('M&amp;M &lt;3&gt; &#163;5 &#x41;_x000D_'), 'M&M <3> £5 A\r');
});
test('sheet XML: shared, inline and formula strings; cached formula values; errors empty; gaps kept', () => {
  const xml = `<worksheet><sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>Inline</t></is></c></row>
    <row r="3" spans="1:4"><c r="A3"><v>46023</v></c><c r="B3" t="str"><f>A1&amp;"x"</f><v>Datex</v></c>
      <c r="C3"><f>C2-D3</f><v>1366.0100000000002</v></c><c r="D3" t="e"><v>#REF!</v></c><c r="E3" s="2"/></row>
    <row r="4"/></sheetData></worksheet>`;
  const rows = sheetRows(xml, ['Date']);
  assert.deepEqual(rows[0], ['Date', null, 'Inline']);
  assert.deepEqual(rows[1], []);
  assert.deepEqual(rows[2], [46023, 'Datex', 1366.0100000000002, null, null]);
  assert.deepEqual(rows[3], []);
});
test('a real .xlsx (deflated zip) with two year sheets → imports, chains and searches', async () => {
  const wb = await readWorkbook(readFileSync(join(HERE, 'fixtures', 'history-sample.xlsx')));
  assert.equal(wb.date1904, false);
  assert.deepEqual(wb.sheets.map((s) => s.name), ['2024', '2025']);
  const [p24, p25] = wb.sheets.map((s) => parseSheet(s));
  assert.deepEqual(p24.groups.map((g) => g.label), ['CHASE', 'NATIONWIDE']);
  assert.deepEqual(p25.groups.map((g) => g.label), ['Current Account', 'NATIONWIDE']);
  assert.ok(isGenericLabel(p25.groups[0].label));
  const y24 = buildYear(p24, ['Chase', 'Nationwide']);
  const y25 = buildYear(p25, ['Chase', 'Nationwide']);
  assert.deepEqual(y24.accounts.map((a) => a.card), [false, true]);
  const c25 = checkYear(y25, y24);
  assert.deepEqual(c25.chain, []);
  assert.deepEqual(c25.balances, []);
  assert.deepEqual(c25.outOfOrder.map((x) => x.t), ['Late row (typed in the wrong place)']);
  const lottery = y25.rows.find((r) => r.t === 'Lottery');
  assert.deepEqual(lottery.v.chase, [null, 30, 291000]);
  const r = searchArchive(withYears(emptyArchive(), [y24, y25]), { query: 'parking' });
  assert.deepEqual(r.years.map((y) => [y.year, y.count]), [[2024, 1], [2025, 2]]);
  assert.deepEqual(r.totals, { chase: { credit: 0, debit: 1420 }, nationwide: { credit: 0, debit: 1200 } });
});
test('not an .xlsx → a plain message', async () => {
  await assert.rejects(readWorkbook(new TextEncoder().encode('hello, not a zip')), /isn’t an Excel/);
});

queue.push([null, 'on Drive']);
test('years go to Finance/Archive as one file each, apart from personal.json; importing again overwrites', async () => {
  const drive = createFakeDrive();
  const a = sampleArchive();
  await uploadArchiveYears(drive, 'tok', yearsOf(a));
  const files = [...drive.items.values()];
  const folder = files.find((f) => f.folder && f.name === 'Archive');
  const finance = files.find((f) => f.folder && f.name === 'Finance');
  assert.equal(folder.parent, finance.id);
  assert.deepEqual(files.filter((f) => !f.folder).map((f) => [f.name, f.parent]).sort(), [['archive-2025.json', folder.id], ['archive-2026.json', folder.id]]);
  await uploadArchiveYears(drive, 'tok', [{ ...a.years[2026], sheet: 'again' }]);
  assert.equal([...drive.items.values()].filter((f) => !f.folder).length, 2);
  const back = await downloadArchiveYears(drive, 'tok');
  assert.deepEqual(back.years.map((y) => [y.year, y.sheet]), [[2025, '2025'], [2026, 'again']]);
  assert.deepEqual(back.skipped, []);
});
test('another device reads them back; a damaged file is skipped and named', async () => {
  const drive = createFakeDrive();
  await uploadArchiveYears(drive, 'tok', yearsOf(sampleArchive()));
  const f = [...drive.items.values()].find((x) => x.name === 'archive-2025.json');
  f.text = '{not json';
  const back = await downloadArchiveYears(drive, 'tok');
  assert.deepEqual(back.years.map((y) => y.year), [2026]);
  assert.deepEqual(back.skipped, ['archive-2025.json']);
});
test('delete: the year files go to the bin (all, or chosen years); nothing else is touched', async () => {
  const drive = createFakeDrive();
  const other = await drive.createFile('tok', await drive.findOrCreateFolder('tok', 'Finance'), 'personal.json', '{}');
  await uploadArchiveYears(drive, 'tok', yearsOf(sampleArchive()));
  assert.equal(await trashArchiveYears(drive, 'tok', [2025]), 1);
  assert.deepEqual((await downloadArchiveYears(drive, 'tok')).years.map((y) => y.year), [2026]);
  assert.equal(await trashArchiveYears(drive, 'tok'), 1);
  assert.deepEqual((await downloadArchiveYears(drive, 'tok')).years, []);
  assert.equal(drive.items.get(other.id).trashed, false);
  assert.ok([...drive.items.values()].filter((x) => /^archive-/.test(x.name ?? '')).every((x) => x.trashed));
});
test('an expired sign-in while downloading is passed up, not swallowed as a bad file', async () => {
  const drive = createFakeDrive();
  await uploadArchiveYears(drive, 'tok', yearsOf(sampleArchive()));
  const real = drive.download;
  drive.download = async () => { const e = new Error('401'); e.auth = true; throw e; };
  await assert.rejects(downloadArchiveYears(drive, 'tok'), (e) => e.auth === true);
  drive.download = real;
});

for (const [name, fn] of queue) {
  if (name === null) { console.log(fn); continue; }
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL - ${name}`);
    console.log(`    ${err.message}`);
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
