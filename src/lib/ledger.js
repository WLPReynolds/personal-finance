import { randomUUID } from './id.js';

/**
 * Create the two linked Transaction objects that represent a Transfer
 * between two accounts. Keeping transfers as a pair of ordinary
 * transactions (rather than a special-cased entity) means balance
 * calculation only ever has one code path.
 *
 * @param {Object} params
 * @param {string} params.fromAccountId
 * @param {string} params.toAccountId
 * @param {number} params.amount - integer pence
 * @param {string} params.date - ISO date
 * @param {string} params.note
 * @returns {{ transfer: import('../models/schema.js').Transfer, transactions: import('../models/schema.js').Transaction[] }}
 */
export function createTransfer({ fromAccountId, toAccountId, amount, date, note }) {
  const transferId = randomUUID();

  /** @type {import('../models/schema.js').Transfer} */
  const transfer = {
    id: transferId,
    fromAccountId,
    toAccountId,
    amount,
    date,
    note,
  };

  const debitLeg = {
    id: randomUUID(),
    accountId: fromAccountId,
    date,
    amount,
    direction: 'debit',
    description: note,
    category: 'Transfer',
    kind: 'transaction',
    transferId,
    envelopeSplits: null,
    scheduledItemId: null,
    isProjected: false,
  };

  const creditLeg = {
    id: randomUUID(),
    accountId: toAccountId,
    date,
    amount,
    direction: 'credit',
    description: note,
    category: 'Transfer',
    kind: 'transaction',
    transferId,
    envelopeSplits: null,
    scheduledItemId: null,
    isProjected: false,
  };

  return { transfer, transactions: [debitLeg, creditLeg] };
}
