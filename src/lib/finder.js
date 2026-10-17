/**
 * v0.15.0: the Finder — one search over the imported history AND the live
 * ledger (with projections up to the grid's horizon, and the joint account
 * when it's on). Design: Project doc claude/finder-design.md (Wayne, 17 Oct).
 *
 *  - History accounts can be LINKED to live accounts (by archive key), so a
 *    2024 Nationwide spend lands in the live Nationwide column. Several can
 *    link to one (split balance-transfer columns → Barclaycard). Unlinked ones
 *    get their own column.
 *  - The links are one settings record in ledger.scheduledItems
 *    (recordType 'archiveLinks'), so they sync like the ticket settings.
 *  - Within one live account, a history money-out and money-in of the same
 *    amount on the same day from two DIFFERENT linked history accounts is an
 *    "internal move": listed, tagged, left out of the totals.
 *  - Totals per calendar year and a grand total, out and in kept apart.
 *
 * Pure functions; money in integer pence.
 */
import { yearsOf, archiveAccounts, matches, accountKey } from './archive.js';

export const LINKS_RECORD_TYPE = 'archiveLinks';
export const LINKS_ID = 'archive-links';

// ---------------------------------------------------------------- links

export function linksRecord(ledger) {
  return (ledger?.scheduledItems ?? []).find((r) => r?.recordType === LINKS_RECORD_TYPE) ?? null;
}

/** { archiveKey: accountId } — only links to accounts that still exist. */
export function archiveLinks(ledger) {
  const raw = linksRecord(ledger)?.links ?? {};
  const ids = new Set((ledger?.accounts ?? []).map((a) => a.id));
  const out = {};
  for (const [k, id] of Object.entries(raw)) if (typeof id === 'string' && ids.has(id)) out[k] = id;
  return out;
}

/**
 * Every decision made so far: { archiveKey: accountId | null } — null = he chose
 * "not linked" (so no suggestion is offered again). Keys never decided are absent.
 */
export function linkDecisions(ledger) {
  return { ...(linksRecord(ledger)?.links ?? {}) };
}

/** Save the links ('' / null = decided: not linked). Returns a new ledger. */
export function setArchiveLinks(ledger, links) {
  const prev = linksRecord(ledger);
  const clean = {};
  for (const [k, id] of Object.entries(links ?? {})) if (k) clean[k] = typeof id === 'string' && id ? id : null;
  const rec = {
    id: LINKS_ID,
    recordType: LINKS_RECORD_TYPE,
    description: 'History links to your accounts', // shown if it ever clashes in a sync
    links: clean,
    createdAt: prev?.createdAt ?? new Date().toISOString(),
  };
  const others = (ledger.scheduledItems ?? []).filter((r) => r.recordType !== LINKS_RECORD_TYPE);
  return { ...ledger, scheduledItems: [...others, rec], lastModified: new Date().toISOString() };
}

/**
 * A suggested link for a history account: a live account with exactly the
 * same name (ignoring case and spaces), else null. `accounts` = the ones
 * that may be linked to.
 */
export function suggestLink(name, accounts) {
  const k = accountKey(name);
  return accounts.find((a) => accountKey(a.name) === k)?.id ?? null;
}

// ---------------------------------------------------------------- rows

/**
 * Live grid rows (lib/grid.js buildGridRows over the view ledger) → finder
 * rows. Statement rows and envelope moves (no money) are left out; notes stay
 * (they can be found by their text); skipped projections are left out.
 */
export function liveFinderRows(gridRows) {
  const out = [];
  for (const r of gridRows) {
    if (r.statement) continue;
    if (r.projection?.skipped || r.skipped) continue;
    const cells = {};
    let any = false;
    for (const [accId, c] of Object.entries(r.cells)) {
      const e = [];
      if (c.credit) e.push({ dir: 'in', amount: c.credit });
      if (c.debit) e.push({ dir: 'out', amount: c.debit });
      if (e.length) { cells[accId] = e; any = true; }
    }
    if (!any && r.kind !== 'note') continue; // e.g. an envelope move: nothing to show
    out.push({
      source: 'live',
      date: r.date,
      text: r.description ?? '',
      cells,
      projected: Boolean(r.projection),
      ref: { rowId: r.id, txId: r.txIds[0], accountIds: Object.keys(r.cells) },
    });
  }
  return out;
}

/** The column a history account lands in: its linked live account, else its own. */
export const archiveColumn = (key, links) => links[key] ?? `arch:${key}`;

/**
 * Every history row → finder rows (Brought forward rows left out), with
 * internal moves marked. links: { archiveKey: accountId }.
 */
export function archiveFinderRows(archive, links = {}) {
  const out = [];
  for (const y of yearsOf(archive)) {
    const rows = [];
    for (const row of y.rows) {
      if (row.bf) continue;
      const cells = {};
      for (const [key, v] of Object.entries(row.v)) {
        const col = archiveColumn(key, links);
        const e = cells[col] ?? [];
        if (v[0]) e.push({ dir: 'in', amount: v[0], key });
        if (v[1]) e.push({ dir: 'out', amount: v[1], key });
        if (e.length) cells[col] = e;
      }
      rows.push({
        source: 'archive',
        date: row.d,
        text: row.t ?? '',
        cells,
        projected: false,
        ref: { year: y.year, n: row.n, sheet: y.sheet },
      });
    }
    markInternalMoves(rows);
    out.push(...rows);
  }
  return out;
}

/**
 * Same live column, same day, same amount, one out and one in, from two
 * different history accounts → both entries `internal: true` (and the row
 * `internal`). Each entry pairs at most once, first come first served.
 */
export function markInternalMoves(rows) {
  const byKey = new Map(); // `${date}|${col}|${amount}` → { outs: [entry,row], ins: [...] }
  for (const r of rows) {
    if (r.source !== 'archive') continue;
    for (const [col, entries] of Object.entries(r.cells)) {
      if (!col || col.startsWith('arch:')) continue; // only linked columns can hold two history accounts
      for (const e of entries) {
        const k = `${r.date}|${col}|${e.amount}`;
        const g = byKey.get(k) ?? { out: [], in: [] };
        g[e.dir].push({ e, r });
        byKey.set(k, g);
      }
    }
  }
  for (const g of byKey.values()) {
    const ins = [...g.in];
    for (const o of g.out) {
      const i = ins.findIndex((x) => x.e.key !== o.e.key);
      if (i < 0) continue;
      const [m] = ins.splice(i, 1);
      o.e.internal = true; m.e.internal = true;
      o.r.internal = true; m.r.internal = true;
    }
  }
  return rows;
}

// ---------------------------------------------------------------- search

function addTotals(totals, row, cols) {
  for (const [col, entries] of Object.entries(row.cells)) {
    if (cols && !cols.has(col)) continue;
    const t = (totals[col] ??= { in: 0, out: 0 });
    for (const e of entries) if (!e.internal) t[e.dir] += e.amount;
  }
}

/**
 * The finder's search.
 * opts: { query, columns: Set|null }  (query already trimmed to what's active)
 * → { years: [{ year, rows, totals }], totals, count }  oldest first; inside a
 *   year by date (history before live on a shared date — they can't overlap).
 * With columns chosen, a row matches only if it has an amount in one of them,
 * and totals count only those columns.
 */
export function findRows(rows, { query = '', columns = null } = {}) {
  const cols = columns && columns.size ? columns : null;
  const hits = rows
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => matches(r.text, query) && (!cols || Object.keys(r.cells).some((c) => cols.has(c))))
    .sort((a, b) => a.r.date.localeCompare(b.r.date) || (a.r.source === b.r.source ? a.i - b.i : a.r.source === 'archive' ? -1 : 1))
    .map(({ r }) => r);
  const result = { years: [], totals: {}, count: hits.length };
  let cur = null;
  for (const r of hits) {
    const y = Number(r.date.slice(0, 4));
    if (!cur || cur.year !== y) { cur = { year: y, rows: [], totals: {} }; result.years.push(cur); }
    cur.rows.push(r);
    addTotals(cur.totals, r, cols);
    addTotals(result.totals, r, cols);
  }
  return result;
}

/**
 * The columns to choose from / show: live accounts first (in the app's order),
 * then unlinked history accounts (oldest first). → [{ id, name, colour, history: bool }]
 * liveAccounts: [{ id, name, colour }]
 */
export function finderColumns(liveAccounts, archive, links = {}) {
  const cols = liveAccounts.map((a) => ({ ...a, history: false }));
  for (const a of archiveAccounts(archive)) {
    if (links[a.key]) continue;
    cols.push({ id: `arch:${a.key}`, name: a.name, colour: a.colour, history: true });
  }
  return cols;
}
