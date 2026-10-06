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
        _rank: t.direction === 'credit' ? 0 : 1,
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
    // a transfer row with a credit leg sorts with the credits, same rule as sortForBalance
    if (t.direction === 'credit') row._rank = 0;
    row._stmt = Math.max(row._stmt, t.stmtOrder ?? 0);
    if (t.stmtTag) row.stmtTag = { tag: t.stmtTag, month: t.stmtMonth };
  });

  // Same ordering rule as balances.js: date, statement order, credits first, then insertion.
  order.sort((a, b) => a.date.localeCompare(b.date) || a._stmt - b._stmt || a._rank - b._rank || a._index - b._index);

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
  }
  return order;
}
