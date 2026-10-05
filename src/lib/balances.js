/**
 * Balance calculation.
 *
 * All amounts are INTEGER PENCE (see schema.js). Integer addition is exact,
 * so there is no rounding step here — this removes the float drift seen in
 * the spreadsheets (e.g. 1366.0100000000002).
 *
 * Key rule from how Wayne actually tracks money: on any single day, credits
 * are always applied before debits, so the running balance never dips
 * negative just because of display/processing order when it wouldn't in
 * reality. This is purely a *display/calculation* ordering — the stored
 * transaction date doesn't carry a time, so we don't guess at real intra-day
 * ordering, we just apply the rule consistently.
 */

/**
 * Sort transactions for balance calculation / display:
 * 1. By date, ascending
 * 2. Within the same date, credits before debits
 * 3. Within the same date + direction, stable (keep insertion order)
 *
 * @param {import('../models/schema.js').Transaction[]} transactions
 * @returns {import('../models/schema.js').Transaction[]} new sorted array
 */
export function sortForBalance(transactions) {
  return transactions
    .map((tx, index) => ({ tx, index })) // preserve original order for stability
    .sort((a, b) => {
      const dateCompare = a.tx.date.localeCompare(b.tx.date);
      if (dateCompare !== 0) return dateCompare;

      const dirRank = (direction) => (direction === 'credit' ? 0 : 1);
      const dirCompare = dirRank(a.tx.direction) - dirRank(b.tx.direction);
      if (dirCompare !== 0) return dirCompare;

      return a.index - b.index;
    })
    .map(({ tx }) => tx);
}

/**
 * Calculate the running balance for one account, given its transactions and
 * an opening balance (e.g. the "brought forward" figure at the start of a
 * period/year). Balances here are *signed* (credit = +, debit = −); credit
 * card "amount owed" presentation is handled by the caller (see ops.js).
 *
 * @param {import('../models/schema.js').Transaction[]} transactions - all for one account
 * @param {number} openingBalance - signed pence
 * @returns {{ transaction: import('../models/schema.js').Transaction, runningBalance: number }[]}
 */
export function calculateRunningBalance(transactions, openingBalance = 0) {
  const sorted = sortForBalance(transactions);
  let balance = openingBalance;

  return sorted.map((transaction) => {
    // a skipped projected entry (see schedule.js) is shown but moves nothing
    if (!transaction.skipped) balance += transaction.direction === 'credit' ? transaction.amount : -transaction.amount;
    return { transaction, runningBalance: balance };
  });
}

/**
 * Current balance is just the last entry's running balance (or the opening
 * balance if there are no transactions yet).
 *
 * @param {import('../models/schema.js').Transaction[]} transactions
 * @param {number} openingBalance - signed pence
 * @returns {number}
 */
export function currentBalance(transactions, openingBalance = 0) {
  const withBalances = calculateRunningBalance(transactions, openingBalance);
  if (withBalances.length === 0) return openingBalance;
  return withBalances[withBalances.length - 1].runningBalance;
}

/**
 * Detect same-day, same-amount, opposite-direction pairs that look like
 * pass-through money (e.g. salary in, immediately routed out). This is a
 * *detection helper* for flagging candidates in the UI — it does not
 * automatically mark anything as kind: 'passthrough'; that's a deliberate
 * choice made when the transaction is entered or reviewed.
 *
 * @param {import('../models/schema.js').Transaction[]} transactions - all for one account
 * @returns {Array<[import('../models/schema.js').Transaction, import('../models/schema.js').Transaction]>} pairs
 */
export function findPassthroughCandidates(transactions) {
  const byDateAndAmount = new Map();
  for (const tx of transactions) {
    if (tx.kind === 'note') continue;
    const key = `${tx.date}|${tx.amount}`;
    if (!byDateAndAmount.has(key)) byDateAndAmount.set(key, []);
    byDateAndAmount.get(key).push(tx);
  }

  const pairs = [];
  for (const group of byDateAndAmount.values()) {
    const credits = group.filter((t) => t.direction === 'credit');
    const debits = group.filter((t) => t.direction === 'debit');
    const pairCount = Math.min(credits.length, debits.length);
    for (let i = 0; i < pairCount; i++) {
      pairs.push([credits[i], debits[i]]);
    }
  }
  return pairs;
}

/**
 * Apply envelope splits to compute per-envelope balances for an account
 * that has envelopes enabled. Transactions without envelopeSplits are
 * ignored (unallocated money isn't tracked per-envelope).
 *
 * @param {import('../models/schema.js').Transaction[]} transactions - all for one account
 * @param {string[]} envelopeNames
 * @param {Object.<string, number>} openingEnvelopeBalances - pence
 * @returns {Object.<string, number>} envelopeName -> balance (pence)
 */
export function calculateEnvelopeBalances(transactions, envelopeNames, openingEnvelopeBalances = {}) {
  const balances = {};
  for (const name of envelopeNames) {
    balances[name] = openingEnvelopeBalances[name] ?? 0;
  }

  const sorted = sortForBalance(transactions);
  for (const tx of sorted) {
    if (!tx.envelopeSplits) continue;
    for (const split of tx.envelopeSplits) {
      if (!(split.envelopeName in balances)) continue; // ignore unknown envelope names defensively
      const signed = tx.direction === 'credit' ? split.amount : -split.amount;
      balances[split.envelopeName] += signed;
    }
  }
  return balances;
}
