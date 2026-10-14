/**
 * Desktop grid model: mirrors Budget.xlsx — one row per entry, one
 * Credit/Debit/Balance triplet per account, balance carried forward on
 * every row. A transfer is ONE row with a value in both accounts' columns
 * (like "Barclaycard direct debit" in the spreadsheet).
 */
import { toDisplay, signedOpening } from './ops.js';

/**
 * @param {import('../models/schema.js').Ledger} ledger
 * @param {import('../models/schema.js').Account[]} accounts - columns, in display order
 * @returns {{ id: string, date: string, description: string, kind: string, txIds: string[],
 *             cells: Object.<string, { txId: string, credit: number|null, debit: number|null }>,
 *             balances: Object.<string, number> }[]}
 */
export function buildGridRows(ledger, accounts) {
  const rowsByKey = new Map();
  const order = [];

  ledger.transactions.forEach((t, index) => {
    const key = t.transferId ? `tr:${t.transferId}` : `tx:${t.id}`;
    let row = rowsByKey.get(key);
    if (!row) {
      row = {
        id: key,
        date: t.date,
        description: t.description,
        kind: t.kind,
        isTransfer: Boolean(t.transferId),
        projection: t.isProjected ? t.projection : null, // set on projected rows (schedule.js)
        seriesNo: t.seriesNo ?? null, // { n, of } on entries of a fixed-end recurring series (schedule.js)
        skipped: Boolean(t.skipped),
        txIds: [],
        cells: {},
        balances: {},
        _index: index,
        _credits: new Set(), // accounts this row pays money into
        _debits: new Set(), // accounts this row takes money out of
        _stmt: 0,
        statement: t.isStatement ? t.statement : null, // derived statement row (statements.js)
        stmtTag: null,
      };
      rowsByKey.set(key, row);
      order.push(row);
    }
    row.txIds.push(t.id);
    row.cells[t.accountId] = {
      txId: t.id,
      credit: t.kind !== 'note' && t.direction === 'credit' ? t.amount : null,
      debit: t.kind !== 'note' && t.direction === 'debit' ? t.amount : null,
      note: t.kind === 'note',
    };
    if (t.kind !== 'note') (t.direction === 'credit' ? row._credits : row._debits).add(t.accountId);
    row._stmt = Math.max(row._stmt, t.stmtOrder ?? 0);
    if (t.stmtTag) row.stmtTag = { tag: t.stmtTag, month: t.stmtMonth };
  });

  // Same rule as balances.js — in EVERY account column, a day's credits come
  // before its debits. A transfer row is a credit in one column and a debit in
  // another, so it can't simply sort as "a credit" (v0.14.6 fix: a transfer
  // out of the current account sorted ahead of the salary landing that day).
  // Within a day: money in only, then transfers, then money out only; and
  // transfers among themselves so that money arrives in an account before
  // a transfer takes it out again.
  for (const row of order) row._rank = row._debits.size === 0 ? 0 : row._credits.size === 0 ? 2 : 1;
  order.sort((a, b) => a.date.localeCompare(b.date) || a._stmt - b._stmt || a._rank - b._rank || a._index - b._index);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j < order.length && order[j].date === order[i].date && order[j]._stmt === order[i]._stmt && order[j]._rank === order[i]._rank) j++;
    if (order[i]._rank === 1 && j - i > 1) order.splice(i, j - i, ...creditsFirst(order.slice(i, j)));
    i = j;
  }

  const running = Object.fromEntries(accounts.map((a) => [a.id, signedOpening(a)]));
  for (const row of order) {
    for (const account of accounts) {
      const cell = row.cells[account.id];
      if (cell && !row.skipped) running[account.id] += (cell.credit ?? 0) - (cell.debit ?? 0);
      row.balances[account.id] = toDisplay(account, running[account.id]);
    }
    delete row._index;
    delete row._rank;
    delete row._stmt;
    delete row._credits;
    delete row._debits;
  }
  return order;
}

/**
 * One day's transfer rows, reordered so a transfer that takes money out of an
 * account comes after any transfer paying into it; otherwise insertion order.
 * A loop (A→B and B→A the same day) falls back to insertion order.
 */
function creditsFirst(rows) {
  const left = [...rows];
  const out = [];
  while (left.length) {
    const k = left.findIndex((r) => !left.some((o) => o !== r && [...r._debits].some((acc) => o._credits.has(acc))));
    out.push(...left.splice(k < 0 ? 0 : k, 1));
  }
  return out;
}
