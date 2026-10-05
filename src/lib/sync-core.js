/**
 * Pure helpers for Drive sync: deciding what changed, merging two devices'
 * copies against their last common version, grouping genuine clashes for the
 * user to decide, and repairing anything a merge can leave inconsistent.
 * No I/O here, so it's all testable in plain Node.
 */
import { mergeLedger } from './merge.js';

/** An empty ledger used as the "common ancestor" when a device joins for the first time. */
export const EMPTY_BASE = Object.freeze({
  id: 'empty-base',
  name: 'Personal',
  accounts: [],
  transactions: [],
  transfers: [],
  scheduledItems: [],
  schemaVersion: '2',
  lastModified: '1970-01-01T00:00:00.000Z',
});

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * A fingerprint of the ledger's content. Ignores lastModified (which merging
 * rewrites) so "did anything actually change?" compares real data only.
 * Includes account order, so a reorder counts as a change worth syncing.
 */
export function fingerprint(ledger) {
  if (!ledger) return 'null';
  return stableStringify({
    accounts: ledger.accounts,
    transactions: ledger.transactions,
    transfers: ledger.transfers,
    scheduledItems: ledger.scheduledItems,
  });
}

export function isEmptyLedger(ledger) {
  return !ledger || (ledger.accounts.length === 0 && ledger.transactions.length === 0 && ledger.scheduledItems.length === 0);
}

/**
 * Clashes that must be decided together share a key: both legs of a
 * transfer are always edited together, so choosing "this device" for one leg
 * and "Drive" for the other would leave a lopsided transfer.
 */
export function groupKey(conflict) {
  if (conflict.entityType === 'transaction') {
    const transferId = conflict.local?.transferId ?? conflict.remote?.transferId ?? conflict.base?.transferId;
    return transferId ? `tr:${transferId}` : `tx:${conflict.id}`;
  }
  return `${conflict.entityType}:${conflict.id}`;
}

export function groupConflicts(conflicts) {
  const groups = new Map();
  for (const c of conflicts) {
    const key = groupKey(c);
    if (!groups.has(key)) groups.set(key, { key, entityType: c.entityType, conflicts: [] });
    groups.get(key).conflicts.push(c);
  }
  return [...groups.values()];
}

/**
 * Account display order isn't a per-record property, so the record merge
 * can't carry it. Rule: if this device reordered since the last sync, its
 * order wins; otherwise Drive's order is taken. Accounts new to both sides
 * are kept in merge order at the end.
 */
export function mergeAccountOrder(accounts, { base, local, remote }) {
  const ids = new Set(accounts.map((a) => a.id));
  const restrict = (ledger) => ledger.accounts.map((a) => a.id).filter((id) => ids.has(id));
  const baseOrder = restrict(base);
  const localOrder = restrict(local);
  const common = localOrder.filter((id) => baseOrder.includes(id));
  const commonInBase = baseOrder.filter((id) => common.includes(id));
  const localReordered = common.join('|') !== commonInBase.join('|');
  const preferred = localReordered ? localOrder : restrict(remote);
  const rank = new Map(preferred.map((id, i) => [id, i]));
  return accounts
    .map((a, i) => ({ a, i }))
    .sort((x, y) => (rank.get(x.a.id) ?? 1e9 + x.i) - (rank.get(y.a.id) ?? 1e9 + y.i))
    .map(({ a }) => a);
}

/**
 * Make a merged ledger internally consistent:
 *  - a transaction whose account was deleted on the other device brings that
 *    account back (data is never silently orphaned);
 *  - Transfer records are rebuilt from their two legs (the legs are the
 *    source of truth; the record is derived);
 *  - a lone transfer leg (its partner gone) becomes an ordinary entry.
 */
export function repairLedger(ledger, sources = []) {
  const accounts = [...ledger.accounts];
  const accountIds = new Set(accounts.map((a) => a.id));
  for (const t of ledger.transactions) {
    if (accountIds.has(t.accountId)) continue;
    for (const src of sources) {
      const found = src?.accounts.find((a) => a.id === t.accountId);
      if (found) {
        accounts.push(found);
        accountIds.add(found.id);
        break;
      }
    }
  }

  const legsByTransfer = new Map();
  for (const t of ledger.transactions) {
    if (!t.transferId) continue;
    if (!legsByTransfer.has(t.transferId)) legsByTransfer.set(t.transferId, []);
    legsByTransfer.get(t.transferId).push(t);
  }
  const transfers = [];
  const brokenTransferIds = new Set();
  for (const [transferId, legs] of legsByTransfer) {
    const debit = legs.find((l) => l.direction === 'debit');
    const credit = legs.find((l) => l.direction === 'credit');
    if (legs.length === 2 && debit && credit) {
      transfers.push({
        id: transferId,
        fromAccountId: debit.accountId,
        toAccountId: credit.accountId,
        amount: debit.amount,
        date: debit.date,
        note: debit.description,
      });
    } else {
      brokenTransferIds.add(transferId);
    }
  }
  const transactions = brokenTransferIds.size
    ? ledger.transactions.map((t) => (brokenTransferIds.has(t.transferId) ? { ...t, transferId: null, category: t.category === 'Transfer' ? null : t.category } : t))
    : ledger.transactions;

  return { ...ledger, accounts, transactions, transfers };
}

/**
 * Three-way merge of two devices' copies.
 * @returns {{ merged: object, groups: Array<{key: string, entityType: string, conflicts: object[]}> }}
 *   merged has every clash provisionally resolved as "this device"; groups
 *   lists the clashes for the user to confirm or flip.
 */
export function prepareMerge({ base, local, remote }) {
  const { merged, conflicts } = mergeLedger({ base, local, remote });
  const ordered = { ...merged, accounts: mergeAccountOrder(merged.accounts, { base, local, remote }) };
  return {
    merged: repairLedger(ordered, [local, remote, base]),
    groups: groupConflicts(conflicts),
  };
}

/**
 * Apply the user's choices. choices: { [groupKey]: 'local' | 'remote' };
 * anything not chosen stays as this device's version.
 */
export function applyResolutions(merged, groups, choices, sources = []) {
  const COLLECTION = { transaction: 'transactions', account: 'accounts', scheduledItem: 'scheduledItems' };
  let ledger = merged;
  for (const group of groups) {
    const side = choices[group.key] === 'remote' ? 'remote' : 'local';
    for (const conflict of group.conflicts) {
      const key = COLLECTION[conflict.entityType];
      const chosen = conflict[side];
      const list = ledger[key];
      const at = list.findIndex((item) => item.id === conflict.id);
      let next;
      if (at >= 0) {
        // replace in place, so a record keeps its position (same-day order, account order)
        next = chosen ? list.map((item, i) => (i === at ? chosen : item)) : list.filter((_, i) => i !== at);
      } else {
        next = chosen ? [...list, chosen] : list;
      }
      ledger = { ...ledger, [key]: next };
    }
  }
  return repairLedger(ledger, sources);
}
