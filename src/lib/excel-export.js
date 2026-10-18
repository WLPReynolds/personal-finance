/**
 * v0.15.4: Export to Excel — a plain data dump laid out like Budget.xlsx.
 *
 * Wayne's choices (18 Oct 2026):
 *  - Any date range, from the earliest data (imported history included) to
 *    12 months ahead; projected (not yet confirmed) entries optional.
 *  - Any accounts, each one optional — the joint account too.
 *  - One sheet per calendar year, named by the year: Date, Description,
 *    then a Credit / Debit / Balance block per account, a vertical border
 *    between accounts. Values only, no formulas.
 *  - Where an account has no data — before it opened (e.g. the joint account
 *    in 2014) or after it closed — its cells are grey.
 *  - History accounts keep their original names (an old current account
 *    linked to today's one stays its own column). Only a history account with
 *    exactly the same name as a live one continues in that live column.
 *  - Notes, envelope tags (an Envelope column), reconciled ticks (a ✓
 *    column), statement rows in upper case.
 *
 * A sheet's first row is "Brought forward" with the balances carried in, so
 * an export can be imported back into History (rows from 1 Oct 2026 aside).
 *
 * Two steps, both pure: buildExport() → the rows and cells; exportWorkbook()
 * → the input for lib/xlsx-write.js. Money is integer pence until the sheet.
 */
import { yearsOf, archiveAccounts, accountKey } from './archive.js';

export const MAX_DATE = '9999-12-31';
export const GREY = 'D9D9D9';

// ---------------------------------------------------------------- columns

/**
 * The accounts to choose from: live accounts first (the app's order), then
 * history accounts not continued in a live column (oldest first).
 * liveAccounts: [{ id, name, colour, openingDate, opening, active, lastDate, envelopes }]
 * → [{ id, name, colour, liveId, histKey, envelopes, live, start, end }]
 *   start / end: the first and last dates the account has data (null start = none at all)
 */
export function exportColumns(liveAccounts, archive) {
  const hist = archiveAccounts(archive);
  const spans = historySpans(archive);
  const used = new Set();
  const cols = liveAccounts.map((a) => {
    const h = hist.find((x) => !used.has(x.key) && x.key === accountKey(a.name));
    if (h) used.add(h.key);
    const hs = h ? spans.get(h.key) : null;
    const liveEnd = a.active === false ? (a.lastDate && a.lastDate > a.openingDate ? a.lastDate : a.openingDate) : MAX_DATE;
    return {
      id: a.id, name: a.name, colour: a.colour, liveId: a.id, histKey: h?.key ?? null,
      envelopes: Boolean(a.envelopes), live: true,
      start: hs?.start && hs.start < a.openingDate ? hs.start : a.openingDate,
      end: liveEnd,
      opening: a.opening, openingDate: a.openingDate,
    };
  });
  for (const h of hist) {
    if (used.has(h.key)) continue;
    const s = spans.get(h.key);
    cols.push({ id: `arch:${h.key}`, name: h.name, colour: h.colour, liveId: null, histKey: h.key, envelopes: false, live: false, start: s?.start ?? null, end: s?.end ?? null });
  }
  return cols;
}

/** History account key → { start, end }: the first and last rows with any figure in its columns. */
function historySpans(archive) {
  const out = new Map();
  for (const y of yearsOf(archive)) {
    for (const r of y.rows) {
      for (const [k, v] of Object.entries(r.v)) {
        if (v[0] === null && v[1] === null && v[2] === null) continue;
        const s = out.get(k);
        if (!s) out.set(k, { start: r.d, end: r.d });
        else { if (r.d < s.start) s.start = r.d; if (r.d > s.end) s.end = r.d; }
      }
    }
  }
  return out;
}

/** The earliest date any of these columns has data (for the From box), or null. */
export function earliestDate(cols) {
  return cols.map((c) => c.start).filter(Boolean).sort()[0] ?? null;
}

const inSpan = (col, date) => Boolean(col.start) && date >= col.start && date <= col.end;

// ---------------------------------------------------------------- rows

/**
 * Live grid rows (lib/grid.js buildGridRows over the view ledger) → export
 * rows. Skipped projections are left out (they never count). The words come
 * from the app, which already knows how to say them:
 * opts: { reconciledIds: Set, envText(row, accountId) → string|null,
 *         statusText(row) → string, statementText(row) → string, colourOf(accountId) → '#rrggbb',
 *         textOf(row) → the description as the grid shows it }
 */
export function liveExportRows(gridRows, { reconciledIds = new Set(), envText = () => null, statusText = () => '', statementText = () => 'Statement', colourOf = () => null, textOf = (r) => r.description ?? '' } = {}) {
  const out = [];
  for (const r of gridRows) {
    if (r.skipped || r.projection?.skipped) continue;
    if (r.statement) {
      const accountId = Object.keys(r.cells)[0];
      out.push({ date: r.date, text: statementText(r), kind: 'statement', projected: false, status: statusText(r), statementOf: accountId, tint: colourOf(accountId), cells: {}, balances: r.balances });
      continue;
    }
    const cells = {};
    for (const [id, c] of Object.entries(r.cells)) {
      cells[id] = { credit: c.credit ?? null, debit: c.debit ?? null, rec: Boolean(c.txId && reconciledIds.has(c.txId)), env: envText(r, id) };
    }
    out.push({
      date: r.date, text: textOf(r), kind: r.kind === 'note' ? 'note' : 'entry',
      projected: Boolean(r.projection), status: statusText(r), statementOf: null, tint: null, cells, balances: r.balances,
    });
  }
  return out;
}

/**
 * The export, sheet by sheet.
 * opts: { archive, columns (from exportColumns), selected: [colId] (in order), liveRows, from, to }
 * liveRows (in the grid's order): [{ date, text, kind: 'entry'|'note'|'statement', projected, status,
 *   statementOf: accountId|null, tint: colour|null,
 *   cells: { accountId: { credit, debit, rec, env } }, balances: { accountId: pence } }]
 * → { columns: [chosen], sheets: [{ year, rows: [{ kind: 'bf'|'opening'|'row', date, text, status,
 *     projected, note, statement, tint, cells: { colId: { grey } | { credit, debit, balance, env, rec } } }] }] }
 */
export function buildExport({ archive = null, columns, selected, liveRows = [], from, to }) {
  if (!from || !to || from > to) throw new Error('Choose a From date on or before the To date');
  const byId = new Map(columns.map((c) => [c.id, c]));
  const cols = selected.map((id) => byId.get(id)).filter(Boolean);
  if (!cols.length) throw new Error('Choose at least one account');
  const selHist = new Map(cols.filter((c) => c.histKey).map((c) => [c.histKey, c]));
  const selLive = new Map(cols.filter((c) => c.liveId).map((c) => [c.liveId, c]));
  // every column's running balance, chosen or not (a balance is only ever carried, never added up here)
  const allHist = new Map(columns.filter((c) => c.histKey).map((c) => [c.histKey, c]));
  const liveCols = columns.filter((c) => c.liveId);
  const bal = {};

  const events = [];
  for (const y of yearsOf(archive)) {
    const keys = new Set(y.accounts.map((a) => a.key));
    for (const r of y.rows) events.push({ src: 'archive', year: y.year, date: r.d, row: r, keys });
  }
  // live: each account's opening balance goes in just before its first day's entries
  const openings = new Map();
  for (const c of liveCols) {
    const list = openings.get(c.openingDate) ?? [];
    list.push(c);
    openings.set(c.openingDate, list);
  }
  const openDates = [...openings.keys()].sort();
  let oi = 0;
  const pushOpenings = (until) => {
    while (oi < openDates.length && openDates[oi] <= until) {
      const d = openDates[oi++];
      events.push({ src: 'opening', year: Number(d.slice(0, 4)), date: d, cols: openings.get(d) });
    }
  };
  for (const r of liveRows) {
    pushOpenings(r.date);
    events.push({ src: 'live', year: Number(r.date.slice(0, 4)), date: r.date, row: r });
  }
  pushOpenings(MAX_DATE);

  const apply = (e) => {
    if (e.src === 'archive') {
      for (const [k, v] of Object.entries(e.row.v)) {
        const c = allHist.get(k);
        if (c && v[2] !== null) bal[c.id] = v[2];
      }
    } else if (e.src === 'opening') {
      for (const c of e.cols) bal[c.id] = c.opening;
    } else {
      for (const c of liveCols) {
        if (e.date >= c.openingDate && e.row.balances[c.liveId] !== undefined) bal[c.id] = e.row.balances[c.liveId];
      }
    }
  };
  const balanceCells = (date) => Object.fromEntries(cols.map((c) => [c.id, inSpan(c, date) ? { balance: bal[c.id] ?? null } : { grey: true }]));

  const fromYear = Number(from.slice(0, 4));
  const toYear = Number(to.slice(0, 4));
  const sheets = [];
  let cur = null;
  const openSheet = (year) => {
    const date = year === fromYear ? from : `${year}-01-01`;
    cur = { year, rows: [{ kind: 'bf', date, text: 'Brought forward', status: '', cells: balanceCells(date) }], emitted: 0 };
    sheets.push(cur);
  };
  const advanceTo = (year) => {
    if (!cur) openSheet(fromYear);
    while (cur.year < Math.min(year, toYear)) openSheet(cur.year + 1);
  };

  for (const e of events) {
    if (e.date < from) { apply(e); continue; }
    if (e.date > to) continue;
    advanceTo(e.year);
    const folds = (e.src === 'opening' || (e.src === 'archive' && e.row.bf)) && !cur.emitted && e.date <= cur.rows[0].date;
    apply(e);
    if (folds) { cur.rows[0].cells = balanceCells(cur.rows[0].date); continue; } // part of the sheet's own Brought forward
    const out = rowFor(e, cols, selHist, selLive, bal);
    if (out) { cur.rows.push(out); cur.emitted++; }
  }
  advanceTo(toYear);
  return { columns: cols, sheets: sheets.map(({ year, rows }) => ({ year, rows })) };
}

function rowFor(e, cols, selHist, selLive, bal) {
  const cellsWith = (fill) => {
    const cells = {};
    for (const c of cols) cells[c.id] = inSpan(c, e.date) ? { balance: bal[c.id] ?? null, ...fill(c) } : { grey: true };
    return cells;
  };
  if (e.src === 'archive') {
    const r = e.row;
    if (r.bf) return null; // a history sheet's own Brought forward: the balances live on in the carried figures
    const amounts = Object.values(r.v).some((v) => v[0] !== null || v[1] !== null);
    const mine = Object.entries(r.v).some(([k, v]) => selHist.has(k) && (v[0] !== null || v[1] !== null));
    // a row with no money anywhere (e.g. "In Greece") stays if one of the chosen history accounts is on that sheet
    const annotation = !amounts && r.t && [...e.keys].some((k) => selHist.has(k));
    if (!mine && !annotation) return null;
    return {
      kind: 'row', date: r.d, text: r.t ?? '', status: '', note: !amounts,
      cells: cellsWith((c) => {
        const v = c.histKey ? r.v[c.histKey] : null;
        return v ? { credit: v[0], debit: v[1] } : {};
      }),
    };
  }
  if (e.src === 'opening') {
    const mine = e.cols.filter((c) => cols.includes(c));
    if (!mine.length) return null;
    return { kind: 'opening', date: e.date, text: mine.length === 1 ? 'Opening balance' : 'Opening balances', status: '', cells: cellsWith(() => ({})) };
  }
  const r = e.row;
  if (r.kind === 'statement' ? !selLive.has(r.statementOf) : !Object.keys(r.cells).some((id) => selLive.has(id))) return null;
  return {
    kind: 'row', date: r.date, text: r.text ?? '', status: r.status ?? '', projected: Boolean(r.projected),
    note: r.kind === 'note', statement: r.kind === 'statement', tint: r.tint ?? null,
    cells: cellsWith((c) => {
      const x = c.liveId ? r.cells[c.liveId] : null;
      return x ? { credit: x.credit ?? null, debit: x.debit ?? null, env: x.env ?? null, rec: Boolean(x.rec) } : {};
    }),
  };
}

// ---------------------------------------------------------------- the sheet

/** A light tint of a colour (for a statement row), as RRGGBB. */
export function tint(hex, amount = 0.82) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? ''));
  if (!m) return 'EDEDED';
  const n = parseInt(m[1], 16);
  const mix = (c) => Math.round(c + (255 - c) * amount).toString(16).padStart(2, '0');
  return `${mix(n >> 16)}${mix((n >> 8) & 255)}${mix(n & 255)}`.toUpperCase();
}

const hex6 = (c) => (/^#?([0-9a-f]{6})$/i.exec(String(c ?? ''))?.[1] ?? '475569').toUpperCase();

/** What each account's block holds, left to right. */
export function blockFields(col) {
  return ['credit', 'debit', 'balance', ...(col.envelopes ? ['env'] : []), ...(col.live ? ['rec'] : [])];
}

const HEAD = { credit: 'Credit', debit: 'Debit', balance: 'Balance', env: 'Envelope', rec: '✓' };
const WIDTH = { credit: 11, debit: 11, balance: 12, env: 20, rec: 4 };

/** buildExport() → { sheets } for writeWorkbook (lib/xlsx-write.js). */
export function exportWorkbook(model) {
  const { columns } = model;
  const layout = [];
  let x = 2;
  for (const c of columns) {
    const fields = blockFields(c);
    layout.push({ c, fields, first: x, last: x + fields.length - 1 });
    x += fields.length;
  }
  const statusCol = x;
  const widths = [11, 42, ...layout.flatMap((b) => b.fields.map((f) => WIDTH[f])), 22];

  const sheets = model.sheets.map((sheet) => {
    const rows = [];
    // row 1: each account's name over its block (what the History import reads as the institution)
    const top = [null, null];
    const merges = [];
    for (const b of layout) {
      for (let i = b.first; i <= b.last; i++) {
        top[i] = { v: i === b.first ? b.c.name : null, s: { bold: true, color: 'FFFFFF', fill: hex6(b.c.colour), align: 'center', ...(i === b.last ? { right: 'medium' } : {}) } };
      }
      if (b.last > b.first) merges.push(`${col(b.first)}1:${col(b.last)}1`);
    }
    top[1] = { v: null, s: { right: 'medium' } };
    rows.push(top);
    // row 2: the headers
    const head = [{ v: 'Date', s: { bold: true, bottom: 'thin' } }, { v: 'Description', s: { bold: true, bottom: 'thin', right: 'medium' } }];
    for (const b of layout) {
      b.fields.forEach((f, i) => { head[b.first + i] = { v: HEAD[f], s: { bold: true, bottom: 'thin', align: f === 'env' ? 'left' : f === 'rec' ? 'center' : 'right', ...(i === b.fields.length - 1 ? { right: 'medium' } : {}) } }; });
    }
    head[statusCol] = { v: 'Status', s: { bold: true, bottom: 'thin' } };
    rows.push(head);

    let prevMonth = null;
    for (const r of sheet.rows) {
      const month = r.date.slice(0, 7);
      const line = r.kind !== 'bf' && prevMonth !== null && month !== prevMonth ? { top: 'thin' } : {};
      prevMonth = month;
      const font = r.projected ? { italic: true, color: '7F7F7F' } : r.note ? { italic: true } : r.kind === 'bf' || r.kind === 'opening' || r.statement ? { bold: true } : {};
      const rowFill = r.statement && r.tint ? { fill: tint(r.tint) } : {};
      const out = [
        { v: dateSerialOf(r.date), s: { numFmt: 'date', ...font, ...rowFill, ...line } },
        { v: r.statement ? String(r.text).toUpperCase() : r.text, s: { ...font, ...rowFill, ...line, right: 'medium' } },
      ];
      for (const b of layout) {
        const cell = r.cells[b.c.id] ?? { grey: true };
        b.fields.forEach((f, i) => {
          const edge = i === b.fields.length - 1 ? { right: 'medium' } : {};
          if (cell.grey) { out[b.first + i] = { v: null, s: { fill: GREY, ...line, ...edge } }; return; }
          let v = null;
          let fmt = null;
          if (f === 'credit' || f === 'debit' || f === 'balance') {
            const p = cell[f];
            if (p !== null && p !== undefined) { v = p / 100; fmt = 'money'; }
            else if (f === 'balance') fmt = 'money';
          } else if (f === 'env') v = cell.env ?? null;
          else if (f === 'rec') v = cell.rec ? '✓' : null;
          out[b.first + i] = { v, s: { ...(fmt ? { numFmt: fmt } : {}), ...font, ...rowFill, ...line, ...edge, ...(f === 'rec' ? { align: 'center' } : {}) } };
        });
      }
      out[statusCol] = { v: r.status || null, s: { ...font, ...rowFill, ...line } };
      rows.push(out);
    }
    return { name: String(sheet.year), cols: widths, rows, merges, freeze: { rows: 2, cols: 2 } };
  });
  return { sheets };
}

function col(i) {
  let s = '';
  let n = i + 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function dateSerialOf(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
}

/** "Personal Finance 2014-01-01 to 2027-10-31.xlsx" */
export function exportFileName(from, to) {
  return `Personal Finance ${from} to ${to}.xlsx`;
}
