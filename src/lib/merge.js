/**
 * Three-way merge for shared/joint Ledgers.
 *
 * The problem this solves: two people can both have a shared Ledger file
 * open at once (e.g. you and your wife editing the joint account). Plain
 * "last save wins" means whoever saves second silently destroys the
 * other person's edits. But most concurrent edits aren't actually in
 * conflict — they're just two different new transactions, or edits to two
 * different existing transactions. Only a genuine same-record edit (or an
 * edit-vs-delete) is a real conflict that needs a human decision.
 *
 * This does a classic three-way merge (base / local / remote) at the level
 * of individual records (by id), not the whole file:
 *
 *   base   = the ledger as it was when you last loaded/synced it
 *   local  = your in-memory ledger, with whatever edits you've made since
 *   remote = the ledger as it currently is on Drive (someone else may have
 *            saved changes since your base)
 *
 * Additions/edits/deletions that only happened on one side are merged in
 * automatically. Only records changed differently on both sides come back
 * as conflicts for the caller (the UI) to resolve.
 *
 * (Not wired into the UI yet — the local-only test build doesn't need it.)
 */

/**
 * @typedef {Object} MergeConflict
 * @property {'transaction'|'account'|'scheduledItem'} entityType
 * @property {string} id
 * @property {'edit-edit'|'edit-delete'|'delete-edit'|'add-add'} reason
 * @property {*} base     - the common-ancestor version (null if it didn't exist yet)
 * @property {*} local    - your version (null if you deleted it)
 * @property {*} remote   - their version (null if they deleted it)
 */

/**
 * Merge one collection (transactions, accounts, or scheduledItems) that's
 * keyed by an `id` field.
 *
 * @param {Array<Object>} base
 * @param {Array<Object>} local
 * @param {Array<Object>} remote
 * @param {'transaction'|'account'|'scheduledItem'} entityType - for labeling conflicts
 * @returns {{ merged: Array<Object>, conflicts: MergeConflict[] }}
 */
export function mergeCollection(base, local, remote, entityType) {
  const baseMap = toMap(base);
  const localMap = toMap(local);
  const remoteMap = toMap(remote);

  const allIds = new Set([...baseMap.keys(), ...localMap.keys(), ...remoteMap.keys()]);

  const merged = [];
  const conflicts = [];

  for (const id of allIds) {
    const b = baseMap.get(id) ?? null;
    const l = localMap.get(id) ?? null;
    const r = remoteMap.get(id) ?? null;

    const localChanged = !deepEqual(b, l);
    const remoteChanged = !deepEqual(b, r);

    // Neither side changed it from base -> keep base version (or drop if
    // it never existed, which shouldn't happen given allIds construction).
    if (!localChanged && !remoteChanged) {
      if (b) merged.push(b);
      continue;
    }

    // Only local changed -> take local (covers local add, local edit, local delete)
    if (localChanged && !remoteChanged) {
      if (l) merged.push(l);
      continue;
    }

    // Only remote changed -> take remote
    if (!localChanged && remoteChanged) {
      if (r) merged.push(r);
      continue;
    }

    // Both changed. If they ended up identical, no conflict either way.
    if (deepEqual(l, r)) {
      if (l) merged.push(l);
      continue;
    }

    // Genuine conflict: both sides changed this id, and disagree.
    let reason;
    if (b === null) {
      reason = 'add-add'; // both created a record with the same id, different content
    } else if (l === null) {
      reason = 'delete-edit'; // you deleted it, they edited it
    } else if (r === null) {
      reason = 'edit-delete'; // you edited it, they deleted it
    } else {
      reason = 'edit-edit'; // both edited it differently
    }

    conflicts.push({ entityType, id, base: b, local: l, remote: r, reason });

    // Default resolution until the user decides: keep both sides visible by
    // preferring local in the merged output (so the app stays usable), but
    // the conflict is surfaced so the UI can prompt and let the user
    // override this choice.
    if (l) merged.push(l);
  }

  return { merged, conflicts };
}

/**
 * Merge a full Ledger three ways. Accounts, transactions, and scheduledItems
 * are each merged independently by id. Transfers are derived from their two
 * linked Transaction legs, so they're re-merged the same way as transactions
 * — a transfer "exists" as long as both its legs survive the merge.
 *
 * @param {Object} params
 * @param {import('../models/schema.js').Ledger} params.base
 * @param {import('../models/schema.js').Ledger} params.local
 * @param {import('../models/schema.js').Ledger} params.remote
 * @returns {{ merged: import('../models/schema.js').Ledger, conflicts: MergeConflict[] }}
 */
export function mergeLedger({ base, local, remote }) {
  const accounts = mergeCollection(base.accounts, local.accounts, remote.accounts, 'account');
  const transactions = mergeCollection(
    base.transactions,
    local.transactions,
    remote.transactions,
    'transaction'
  );
  const scheduledItems = mergeCollection(
    base.scheduledItems,
    local.scheduledItems,
    remote.scheduledItems,
    'scheduledItem'
  );

  const transferMap = new Map();
  for (const t of [...base.transfers, ...local.transfers, ...remote.transfers]) {
    transferMap.set(t.id, t);
  }
  // Keep a transfer only if at least one of its two legs survived the merge
  // (if a conflict resolution drops both legs, the transfer record becomes
  // orphaned and should be dropped too).
  const survivingTransferIds = new Set(
    transactions.merged.filter((t) => t.transferId).map((t) => t.transferId)
  );
  const transfers = [...transferMap.values()].filter((t) => survivingTransferIds.has(t.id));

  const merged = {
    id: local.id,
    name: local.name,
    accounts: accounts.merged,
    transactions: transactions.merged,
    transfers,
    scheduledItems: scheduledItems.merged,
    schemaVersion: local.schemaVersion,
    lastModified: new Date().toISOString(),
  };

  const conflicts = [...accounts.conflicts, ...transactions.conflicts, ...scheduledItems.conflicts];

  return { merged, conflicts };
}

/**
 * Apply a user's resolution to a specific conflict, choosing 'local',
 * 'remote', or a caller-supplied merged/edited record, and folding that
 * choice into an already-merged ledger (replacing whatever default was
 * picked in mergeLedger).
 *
 * @param {import('../models/schema.js').Ledger} mergedLedger
 * @param {MergeConflict} conflict
 * @param {'local'|'remote'|Object} resolution - 'local'/'remote' picks that side; an object uses it directly (e.g. a manually-edited version); null means "keep it deleted"
 * @returns {import('../models/schema.js').Ledger}
 */
export function resolveConflict(mergedLedger, conflict, resolution) {
  const collectionKey = {
    transaction: 'transactions',
    account: 'accounts',
    scheduledItem: 'scheduledItems',
  }[conflict.entityType];

  const resolved =
    resolution === 'local' ? conflict.local : resolution === 'remote' ? conflict.remote : resolution;

  const withoutOld = mergedLedger[collectionKey].filter((item) => item.id !== conflict.id);
  const nextCollection = resolved ? [...withoutOld, resolved] : withoutOld;

  return { ...mergedLedger, [collectionKey]: nextCollection };
}

function toMap(items) {
  const map = new Map();
  for (const item of items) map.set(item.id, item);
  return map;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return JSON.stringify(sortKeysDeep(a)) === JSON.stringify(sortKeysDeep(b));
}

// Ensures object key order doesn't cause false "changed" detections.
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = sortKeysDeep(value[key]);
        return acc;
      }, {});
  }
  return value;
}
