/**
 * v0.14.8: history imported from Budget.xlsx — a READ-ONLY archive.
 *
 * Wayne's choices (16 Oct 2026):
 *  - One worksheet per year in one workbook, back to 2019. Each sheet is wide:
 *    Date, Description, then a Credit/Debit/Balance triplet per institution,
 *    with the institution's name in the rows above the header. Which
 *    institutions appear changes from year to year.
 *  - The importer suggests a name for each triplet from those header rows and
 *    he confirms it. A generic label ("Current Account") is asked per sheet,
 *    because which bank it was can change between years.
 *  - Archive accounts are their OWN thing: never linked to the live accounts,
 *    never in the ledger, the merge or personal.json. Same name = same
 *    archive account across years.
 *  - Balances are stored exactly as the spreadsheet shows them (formulas
 *    aren't kept). The import recalculates them only as a CHECK.
 *  - The spreadsheet's row order is kept (balances follow it). Rows whose
 *    date is out of order are flagged, not moved; he fixes real typos in
 *    the spreadsheet and imports again (a year's import replaces it).
 *  - Rows from the day the live data starts (1 Oct 2026) are left out.
 *  - Browse like the spreadsheet; search across all years with a total per
 *    year and a grand total. No trends.
 *
 * Money is integer pence, as everywhere else. Pure functions only.
 */
import { INSTITUTIONS } from './institutions.js';

export const ARCHIVE_FORMAT = 'personal-finance-archive';
export const ARCHIVE_VERSION = 1;
export const ARCHIVE_FOLDER_NAME = 'Archive';
export const archiveFileName = (year) => `archive-${year}.json`;
export const ARCHIVE_FILE_RE = /^archive-(\d{4})\.json$/;

// ---------------------------------------------------------------- values

/** A cell → pence (null if empty / not a number). Spreadsheet float noise is rounded away. */
export function cellPence(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  let n = v;
  if (typeof v === 'string') {
    const s = v.trim().replace(/^£/, '').replace(/,/g, '');
    if (!/^-?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
    n = Number(s);
  }
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const p = Math.sign(n) * Math.round(Math.abs(n) * 100);
  return p === 0 ? 0 : p; // never -0
}

const pad = (n) => String(n).padStart(2, '0');

/** Excel date serial (or "dd/mm/yyyy", "yyyy-mm-dd") → "YYYY-MM-DD", or null. */
export function cellDate(v, date1904 = false) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 2958466) {
    const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
    const d = new Date(base + Math.floor(v) * 86400000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  if (typeof v === 'string') {
    const s = v.trim();
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
    if (m) return valid(+m[1], +m[2], +m[3]);
    m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s);
    if (m) return valid(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2], +m[1]);
  }
  return null;
}
function valid(y, mo, d) {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? `${y}-${pad(mo)}-${pad(d)}` : null;
}

const norm = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

// ---------------------------------------------------------------- names

/** Labels that don't say which bank — asked per sheet, never assumed across years. */
export function isGenericLabel(label) {
  return /^(current( account)?|credit card|savings?( account)?|account|bank( account)?|joint( account)?|bills( account)?|card|isa|loan)?$/i.test(String(label ?? '').trim());
}

export function titleCase(s) {
  return String(s ?? '').trim().toLowerCase().replace(/(^|[\s(/&-])([a-z])/g, (m, p, c) => p + c.toUpperCase());
}

const squash = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** The app's institution for a name, if it plainly is one ("NATIONWIDE" → nationwide). */
export function institutionFor(name) {
  const s = squash(name);
  if (!s) return null;
  let best = null;
  for (const [key, inst] of Object.entries(INSTITUTIONS)) {
    if (key === 'other' || key === 'joint') continue;
    const l = squash(inst.label);
    // the longest label that fits wins: "Monzo Flex" over "Monzo"
    if ((s === l || s.startsWith(l)) && (!best || l.length > best.len)) best = { key, len: l.length };
  }
  return best?.key ?? null;
}

/** A first guess at the name, from the header label. */
export function suggestName(label) {
  // v0.15: only when the label IS the bank's name — "BARCLAYCARD BT" must stay its own name,
  // or two columns on one sheet (a card and its balance-transfer column) would clash
  const inst = institutionFor(label);
  if (inst && squash(INSTITUTIONS[inst].label) === squash(label)) return INSTITUTIONS[inst].label;
  return titleCase(label) || 'Account';
}

/** Key used to remember a name: per label, or per sheet + label for a generic one. */
export function nameMemoryKey(sheet, label) {
  const l = String(label ?? '').trim().toUpperCase();
  return isGenericLabel(label) ? `${sheet}::${l}` : l;
}

/** Archive account key: same name (ignoring case/spaces) = same account across years. */
export function accountKey(name) {
  return squash(name) || 'account';
}

const FALLBACK_COLOURS = ['#0f766e', '#7c3aed', '#b45309', '#be185d', '#1d4ed8', '#4d7c0f', '#9f1239', '#475569'];
export function colourFor(name) {
  const inst = institutionFor(name);
  if (inst) return INSTITUTIONS[inst].colour;
  let h = 0;
  for (const ch of squash(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return FALLBACK_COLOURS[h % FALLBACK_COLOURS.length];
}

// ---------------------------------------------------------------- one sheet

/**
 * Find the header row (the one with "Date" and "Description") and every
 * Credit/Debit/Balance triplet in it, with the label(s) above each.
 * → { headerRow, dateCol, descCol, groups: [{ credit, debit, balance, label, context }] } or null.
 */
export function findLayout(rows) {
  for (let r = 0; r < Math.min(rows.length, 25); r++) {
    const row = rows[r] ?? [];
    const dateCol = row.findIndex((v) => norm(v) === 'date');
    const descCol = row.findIndex((v) => norm(v) === 'description');
    if (dateCol < 0 || descCol < 0) continue;
    const groups = [];
    let from = Math.max(dateCol, descCol) + 1;
    for (let c = from; c < row.length; c++) {
      if (norm(row[c]) !== 'balance') continue;
      let credit = -1;
      let debit = -1;
      for (let k = c - 1; k >= from; k--) {
        if (credit < 0 && norm(row[k]) === 'credit') credit = k;
        if (debit < 0 && norm(row[k]) === 'debit') debit = k;
      }
      const cols = [credit, debit, c].filter((x) => x >= 0);
      const lo = Math.min(...cols);
      // labels above, closest first (e.g. "NATIONWIDE" under "Credit Card")
      const labels = [];
      for (let k = r - 1; k >= 0; k--) {
        const above = rows[k] ?? [];
        for (let x = lo; x <= c; x++) {
          const v = above[x];
          if (typeof v === 'string' && v.trim()) { labels.push(v.trim()); break; }
        }
      }
      groups.push({ credit, debit, balance: c, label: labels[0] ?? '', context: labels.slice(1) });
      from = c + 1;
    }
    if (groups.length) return { headerRow: r, dateCol, descCol, groups };
  }
  return null;
}

/** The year a sheet is for: its name if that's a year, else the most common year among its dates. */
function sheetYear(name, dates) {
  const m = /^\s*((?:19|20)\d{2})\s*$/.exec(String(name));
  if (m) return Number(m[1]);
  const counts = new Map();
  for (const d of dates) counts.set(d.slice(0, 4), (counts.get(d.slice(0, 4)) ?? 0) + 1);
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return best ? Number(best[0]) : null;
}

/**
 * One worksheet → { sheet, year, groups, rows, problem }.
 * rows: [{ n (Excel row), d, t, bf, noDate, vals: [[credit, debit, balance] per group] }]
 * Empty rows are dropped; nothing else is changed.
 */
export function parseSheet(sheet, { date1904 = false } = {}) {
  const layout = findLayout(sheet.rows);
  if (!layout) return { sheet: sheet.name, year: null, groups: [], rows: [], problem: 'No “Date / Description / Credit / Debit / Balance” header found' };
  const out = [];
  let lastDate = null;
  for (let r = layout.headerRow + 1; r < sheet.rows.length; r++) {
    const row = sheet.rows[r] ?? [];
    const rawDesc = row[layout.descCol];
    const t = rawDesc === null || rawDesc === undefined ? '' : String(rawDesc).trim();
    const vals = layout.groups.map((g) => [
      g.credit >= 0 ? cellPence(row[g.credit]) : null,
      g.debit >= 0 ? cellPence(row[g.debit]) : null,
      cellPence(row[g.balance]),
    ]);
    const any = vals.some((v) => v.some((x) => x !== null));
    const d0 = cellDate(row[layout.dateCol], date1904);
    if (!t && !any && !d0) continue; // blank row
    out.push({
      n: r + 1,
      d: d0 ?? lastDate,
      t,
      bf: /^brought\s*forward/i.test(t),
      noDate: !d0,
      vals,
    });
    if (d0) lastDate = d0;
  }
  const dated = out.filter((x) => x.d);
  return {
    sheet: sheet.name,
    year: sheetYear(sheet.name, dated.map((x) => x.d)),
    groups: layout.groups.map((g, i) => ({ index: i, label: g.label, context: g.context })),
    rows: out,
    problem: out.length ? null : 'No rows below the header',
  };
}

// ---------------------------------------------------------------- build a year

/**
 * A parsed sheet + the names he chose (one per group; '' = leave it out) →
 * the archive year as stored. Rows on/after `firstLiveDate` are left out
 * (his live data starts then), and counted in `leftOut`.
 */
export function buildYear(parsed, names, { firstLiveDate = null, importedAt = new Date().toISOString(), sourceFile = '' } = {}) {
  const used = [];
  const seen = new Map();
  parsed.groups.forEach((g, i) => {
    const name = String(names[i] ?? '').trim();
    if (!name) return;
    const key = accountKey(name);
    if (seen.has(key)) throw new Error(`“${name}” is used twice on sheet ${parsed.sheet} — give each column group its own name`);
    seen.set(key, i);
    used.push({ i, key, name, label: g.label });
  });
  if (!used.length) throw new Error(`Nothing to import from sheet ${parsed.sheet} — every column group is left out`);

  const rows = [];
  let leftOut = 0;
  for (const r of parsed.rows) {
    if (!r.d) continue; // no date at all, even above it
    if (firstLiveDate && r.d >= firstLiveDate) { leftOut++; continue; }
    const v = {};
    for (const u of used) {
      const [c, d, b] = r.vals[u.i];
      if (c !== null || d !== null || b !== null) v[u.key] = [c, d, b];
    }
    const row = { n: r.n, d: r.d, t: r.t, v };
    if (r.bf) row.bf = true;
    if (r.noDate) row.noDate = true;
    rows.push(row);
  }
  const accounts = used.map((u) => {
    const conv = balanceConvention(rows, u.key, u.label);
    return { key: u.key, name: u.name, label: u.label, card: conv === 'card', colour: colourFor(u.name) };
  });
  return {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    year: parsed.year,
    sheet: parsed.sheet,
    importedAt,
    sourceFile,
    accounts,
    rows,
    leftOut,
  };
}

// ---------------------------------------------------------------- checks

/**
 * Which way the balance moves: 'bank' (credit adds) or 'card' (debit adds —
 * a card's balance is what's owed). Whichever fits more of the rows; on a
 * tie, a "Credit Card" label decides.
 */
export function balanceConvention(rows, key, label = '') {
  const bank = mismatches(rows, key, 'bank').length;
  const card = mismatches(rows, key, 'card').length;
  if (card < bank) return 'card';
  if (bank < card) return 'bank';
  return /credit\s*card/i.test(label) ? 'card' : 'bank';
}

/** Rows where the stored balance isn't (previous balance ± this row). Each mismatch re-syncs, so one slip isn't repeated on every row after it. */
export function mismatches(rows, key, conv) {
  const out = [];
  let run = null;
  for (const r of rows) {
    const v = r.v?.[key];
    if (!v) continue;
    const [c, d, b] = v;
    if (r.bf || run === null) { if (b !== null) run = b; continue; }
    const delta = conv === 'card' ? (d ?? 0) - (c ?? 0) : (c ?? 0) - (d ?? 0);
    const expected = run + delta;
    if (b === null) { run = expected; continue; }
    if (b !== expected) out.push({ n: r.n, d: r.d, t: r.t, key, expected, stored: b });
    run = b;
  }
  return out;
}

/**
 * Rows whose date is out of step with the rows around them. The longest run
 * of rows already in date order stays; whatever sits outside it is flagged,
 * so one stray row gets one flag, not its neighbours too.
 * → Set of Excel row numbers.
 */
export function outOfOrderRows(rows) {
  const dates = rows.map((r) => r.d);
  // longest non-decreasing subsequence (patience sorting), with back-links
  const tails = []; // index into rows of the smallest tail for each length
  const prev = new Array(rows.length).fill(-1);
  for (let i = 0; i < rows.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) { // first tail whose date is > dates[i]
      const mid = (lo + hi) >> 1;
      if (dates[tails[mid]] <= dates[i]) lo = mid + 1; else hi = mid;
    }
    prev[i] = lo > 0 ? tails[lo - 1] : -1;
    tails[lo] = i;
  }
  const keep = new Set();
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) keep.add(i);
  const out = new Set();
  rows.forEach((r, i) => { if (!keep.has(i)) out.add(r.n); });
  return out;
}

/** Last stored balance per account in a year → { key: pence }. */
export function closingBalances(year) {
  const out = {};
  for (const r of year.rows) for (const [k, v] of Object.entries(r.v)) if (v[2] !== null) out[k] = v[2];
  return out;
}
/** Brought-forward balances → { key: pence } (empty if the sheet has no Brought forward row). */
export function openingBalances(year) {
  const bf = year.rows.find((r) => r.bf);
  const out = {};
  if (bf) for (const [k, v] of Object.entries(bf.v)) if (v[2] !== null) out[k] = v[2];
  return out;
}

/**
 * Every check for one year (prev = the year before, if imported):
 *  outOfOrder: [{ n, d, t, between: [dateBefore, dateAfter] }]
 *  balances:   [{ n, d, t, key, name, expected, stored }]
 *  chain:      [{ key, name, opening, previousClosing }]  (Brought forward ≠ last year's close)
 *  noDate:     [{ n, t, d }]  (no date in the row; the date above it was used)
 */
export function checkYear(year, prev = null) {
  const names = Object.fromEntries(year.accounts.map((a) => [a.key, a.name]));
  const ooo = outOfOrderRows(year.rows);
  const outOfOrder = year.rows.filter((r) => ooo.has(r.n)).map((r) => {
    const i = year.rows.indexOf(r);
    const before = [...year.rows.slice(0, i)].reverse().find((x) => !ooo.has(x.n))?.d ?? null;
    const after = year.rows.slice(i + 1).find((x) => !ooo.has(x.n))?.d ?? null;
    return { n: r.n, d: r.d, t: r.t, between: [before, after] };
  });
  const balances = year.accounts.flatMap((a) => mismatches(year.rows, a.key, a.card ? 'card' : 'bank').map((m) => ({ ...m, name: a.name })));
  const chain = [];
  if (prev) {
    const open = openingBalances(year);
    const close = closingBalances(prev);
    for (const [k, v] of Object.entries(open)) {
      if (close[k] !== undefined && close[k] !== v) chain.push({ key: k, name: names[k], opening: v, previousClosing: close[k] });
    }
  }
  const noDate = year.rows.filter((r) => r.noDate).map((r) => ({ n: r.n, t: r.t, d: r.d }));
  return { outOfOrder, balances, chain, noDate };
}

export function checkCount(c) {
  return c.outOfOrder.length + c.balances.length + c.chain.length + c.noDate.length;
}

// ---------------------------------------------------------------- the stored archive

export function emptyArchive() {
  return { format: ARCHIVE_FORMAT, version: ARCHIVE_VERSION, years: {}, names: {} };
}

export function yearsOf(archive) {
  return Object.values(archive?.years ?? {}).sort((a, b) => a.year - b.year);
}

/** Every archive account across the years, oldest first, one per key (latest name/colour wins). */
export function archiveAccounts(archive) {
  const out = new Map();
  for (const y of yearsOf(archive)) {
    for (const a of y.accounts) out.set(a.key, { ...(out.get(a.key) ?? {}), ...a, firstYear: out.get(a.key)?.firstYear ?? y.year, lastYear: y.year });
  }
  return [...out.values()];
}

/** Check a year file read back from Drive or IndexedDB. */
export function validYear(y) {
  return Boolean(y && y.format === ARCHIVE_FORMAT && Number.isInteger(y.year) && Array.isArray(y.accounts) && Array.isArray(y.rows))
    && (y.version ?? 1) <= ARCHIVE_VERSION;
}

/** Put imported years into the archive (a year already there is replaced) and remember the names. */
export function withYears(archive, years, names = {}) {
  const next = { ...(archive ?? emptyArchive()), years: { ...(archive?.years ?? {}) }, names: { ...(archive?.names ?? {}), ...names } };
  for (const y of years) next.years[y.year] = y;
  return next;
}

// ---------------------------------------------------------------- viewing

/**
 * One year laid out for the screen, in the spreadsheet's order:
 * [{ row, year, bal: { key: { value, changed } }, monthStart, outOfOrder }]
 * A balance cell left blank in the sheet shows the last balance above it
 * (carried). Month lines go where the month changes among the in-order rows,
 * so a stray September row in August makes no line.
 */
export function yearView(year) {
  const ooo = outOfOrderRows(year.rows);
  const last = {};
  let lastMonth = null;
  return year.rows.map((row) => {
    const bal = {};
    for (const a of year.accounts) {
      const v = row.v[a.key];
      const changed = Boolean(v && (v[0] !== null || v[1] !== null));
      if (v && v[2] !== null) last[a.key] = v[2];
      bal[a.key] = { value: last[a.key] ?? null, changed: changed || Boolean(row.bf) };
    }
    const outOfOrder = ooo.has(row.n);
    let monthStart = false;
    if (!outOfOrder) {
      const m = row.d.slice(0, 7);
      monthStart = lastMonth !== null && m !== lastMonth;
      lastMonth = m;
    }
    return { row, year: year.year, bal, monthStart, outOfOrder };
  });
}

/** Search words: every word must appear in the description (any case). */
export function matches(text, query) {
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const t = String(text ?? '').toLowerCase();
  return words.every((w) => t.includes(w));
}

function addTotals(totals, row, keys) {
  for (const [k, v] of Object.entries(row.v)) {
    if (keys && !keys.has(k)) continue;
    const t = (totals[k] ??= { credit: 0, debit: 0 });
    t.credit += v[0] ?? 0;
    t.debit += v[1] ?? 0;
  }
}

/**
 * Search every year. Brought-forward rows never match.
 * opts: { query, accountKeys (Set|null = all), order: 'sheet' | 'date' }
 * → { years: [{ year, items: yearView items, totals: { key: { credit, debit } }, count }], totals, count }
 * With accounts chosen, a row matches only if it has an amount in one of
 * them, and totals count only those accounts.
 */
export function searchArchive(archive, { query = '', accountKeys = null, order = 'sheet' } = {}) {
  const keys = accountKeys && accountKeys.size ? accountKeys : null;
  const result = { years: [], totals: {}, count: 0 };
  for (const y of yearsOf(archive)) {
    let items = yearView(y).filter(({ row }) => !row.bf && matches(row.t, query)
      && (!keys || Object.entries(row.v).some(([k, v]) => keys.has(k) && (v[0] !== null || v[1] !== null))));
    if (!items.length) continue;
    if (order === 'date') items = items.map((x, i) => ({ x, i })).sort((a, b) => a.x.row.d.localeCompare(b.x.row.d) || a.i - b.i).map(({ x }) => x);
    const totals = {};
    for (const { row } of items) { addTotals(totals, row, keys); addTotals(result.totals, row, keys); }
    result.years.push({ year: y.year, items, totals, count: items.length });
    result.count += items.length;
  }
  return result;
}
