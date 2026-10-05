/**
 * Pure ledger operations used by the UI. Every function takes a Ledger and
 * returns a NEW Ledger (never mutates), so the UI can save the result and
 * re-render, and the logic stays testable in plain Node.
 *
 * Amounts are integer pence throughout.
 */
import { randomUUID } from './id.js';
import { createTransfer } from './ledger.js';
import { calculateRunningBalance } from './balances.js';

export const SCHEMA_VERSION = '2';

/** @returns {import('../models/schema.js').Ledger} */
export function emptyLedger() {
  return {
    id: randomUUID(),
    name: 'Personal',
    accounts: [],
    transactions: [],
    transfers: [],
    scheduledItems: [],
    schemaVersion: SCHEMA_VERSION,
    lastModified: new Date().toISOString(),
  };
}

function touch(ledger) {
  return { ...ledger, lastModified: new Date().toISOString() };
}

// ---------------------------------------------------------------- accounts

/**
 * @param {import('../models/schema.js').Ledger} ledger
 * @param {{ name: string, type: 'current'|'savings'|'credit', institution: string, openingBalance: number, openingDate: string }} fields
 */
export function addAccount(ledger, fields) {
  if (!fields.name?.trim()) throw new Error('Account name is required');
  if (!Number.isInteger(fields.openingBalance)) throw new Error('Opening balance must be whole pence');
  /** @type {import('../models/schema.js').Account} */
  const account = {
    id: randomUUID(),
    name: fields.name.trim(),
    type: fields.type,
    institution: fields.institution || 'other',
    openingBalance: fields.openingBalance,
    openingDate: fields.openingDate,
    active: true,
    storageLocation: 'personal',
    sharedFileId: null,
    creditCard:
      fields.type === 'credit'
        ? { statementWorkingDay: null, nextStatementDateOverride: null, statementBalance: 0 }
        : null,
    envelopes: null,
    createdAt: new Date().toISOString(),
  };
  return { ledger: touch({ ...ledger, accounts: [...ledger.accounts, account] }), account };
}

export function updateAccount(ledger, id, fields) {
  const accounts = ledger.accounts.map((a) => {
    if (a.id !== id) return a;
    const next = { ...a, ...fields };
    if (next.type === 'credit' && !next.creditCard) {
      next.creditCard = { statementWorkingDay: null, nextStatementDateOverride: null, statementBalance: 0 };
    }
    return next;
  });
  return touch({ ...ledger, accounts });
}

export function deleteAccount(ledger, id) {
  if (ledger.transactions.some((t) => t.accountId === id)) {
    throw new Error('This account has transactions. Hide it instead, or delete its transactions first.');
  }
  return touch({ ...ledger, accounts: ledger.accounts.filter((a) => a.id !== id) });
}

/** Move an account up (-1) or down (+1) in display order. */
export function moveAccount(ledger, id, delta) {
  const accounts = [...ledger.accounts];
  const i = accounts.findIndex((a) => a.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= accounts.length) return ledger;
  [accounts[i], accounts[j]] = [accounts[j], accounts[i]];
  return touch({ ...ledger, accounts });
}

// ------------------------------------------------------------ transactions

function blankTx(fields) {
  return {
    id: randomUUID(),
    accountId: fields.accountId,
    date: fields.date,
    amount: fields.kind === 'note' ? 0 : fields.amount,
    direction: fields.direction ?? 'debit',
    description: (fields.description ?? '').trim(),
    category: null,
    kind: fields.kind ?? 'transaction',
    transferId: null,
    envelopeSplits: null,
    scheduledItemId: null,
    isProjected: false,
  };
}

function validate(fields) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fields.date ?? '')) throw new Error('A valid date is required');
  if (fields.kind === 'note') {
    if (!fields.description?.trim()) throw new Error('A note needs some text');
    return;
  }
  if (!Number.isInteger(fields.amount) || fields.amount <= 0) throw new Error('Amount must be more than £0.00');
  if (fields.direction !== 'credit' && fields.direction !== 'debit') throw new Error('Choose credit or debit');
}

/**
 * Add a transaction. If `counterpartAccountId` is given, it becomes a
 * linked transfer: this account gets `direction`, the counterpart gets the
 * opposite (e.g. Current Account debit + Barclaycard credit for the
 * Barclaycard direct debit — one row in the spreadsheet, two legs here).
 *
 * @param {import('../models/schema.js').Ledger} ledger
 * @param {{ accountId: string, date: string, amount: number, direction: 'credit'|'debit', description: string, kind?: 'transaction'|'note', counterpartAccountId?: string|null }} fields
 */
export function addTransaction(ledger, fields) {
  validate(fields);
  if (fields.counterpartAccountId && fields.kind !== 'note') {
    if (fields.counterpartAccountId === fields.accountId) throw new Error('Pick a different account for the other side');
    const from = fields.direction === 'debit' ? fields.accountId : fields.counterpartAccountId;
    const to = fields.direction === 'debit' ? fields.counterpartAccountId : fields.accountId;
    const { transfer, transactions } = createTransfer({
      fromAccountId: from,
      toAccountId: to,
      amount: fields.amount,
      date: fields.date,
      note: fields.description.trim(),
    });
    // keep the leg for the account the user is looking at first, so it sorts naturally
    const ordered = transactions[0].accountId === fields.accountId ? transactions : [transactions[1], transactions[0]];
    return touch({
      ...ledger,
      transactions: [...ledger.transactions, ...ordered],
      transfers: [...ledger.transfers, transfer],
    });
  }
  return touch({ ...ledger, transactions: [...ledger.transactions, blankTx(fields)] });
}

/**
 * Edit a transaction in place (keeps its position = same-day order).
 * For a transfer leg, date/amount/description are mirrored onto the other
 * leg; changing direction flips both legs.
 */
export function updateTransaction(ledger, id, fields) {
  const existing = ledger.transactions.find((t) => t.id === id);
  if (!existing) throw new Error('Transaction not found');
  const merged = { ...existing, ...fields };
  validate(merged);
  if (merged.kind === 'note') merged.amount = 0;
  merged.description = (merged.description ?? '').trim();

  if (!existing.transferId) {
    return touch({ ...ledger, transactions: ledger.transactions.map((t) => (t.id === id ? merged : t)) });
  }

  const opposite = merged.direction === 'credit' ? 'debit' : 'credit';
  const transactions = ledger.transactions.map((t) => {
    if (t.id === id) return merged;
    if (t.transferId === existing.transferId) {
      return { ...t, date: merged.date, amount: merged.amount, description: merged.description, direction: opposite };
    }
    return t;
  });
  const debitLeg = transactions.find((t) => t.transferId === existing.transferId && t.direction === 'debit');
  const creditLeg = transactions.find((t) => t.transferId === existing.transferId && t.direction === 'credit');
  const transfers = ledger.transfers.map((tr) =>
    tr.id === existing.transferId
      ? {
          ...tr,
          fromAccountId: debitLeg.accountId,
          toAccountId: creditLeg.accountId,
          amount: merged.amount,
          date: merged.date,
          note: merged.description,
        }
      : tr
  );
  return touch({ ...ledger, transactions, transfers });
}

/** Delete a transaction; deleting either leg of a transfer deletes both. */
export function deleteTransaction(ledger, id) {
  const existing = ledger.transactions.find((t) => t.id === id);
  if (!existing) return ledger;
  if (existing.transferId) {
    return touch({
      ...ledger,
      transactions: ledger.transactions.filter((t) => t.transferId !== existing.transferId),
      transfers: ledger.transfers.filter((tr) => tr.id !== existing.transferId),
    });
  }
  return touch({ ...ledger, transactions: ledger.transactions.filter((t) => t.id !== id) });
}

/** The other leg of a transfer, or null. */
export function counterpartOf(ledger, tx) {
  if (!tx.transferId) return null;
  return ledger.transactions.find((t) => t.transferId === tx.transferId && t.id !== tx.id) ?? null;
}

// ---------------------------------------------------------------- balances

/**
 * Accounts are stored "as the user reads them": credit cards show amount
 * OWED, which goes UP with a debit (spend) and DOWN with a credit (payment),
 * exactly like the Nationwide/Barclaycard columns in Budget.xlsx.
 * Internally balances are signed (credit +, debit −), so a card's displayed
 * figure is the negative of its signed balance.
 */
export function toDisplay(account, signed) {
  return account.type === 'credit' ? -signed : signed;
}

export function signedOpening(account) {
  return account.type === 'credit' ? -account.openingBalance : account.openingBalance;
}

/**
 * Running balances for one account, in display terms.
 * @returns {{ transaction: object, runningBalance: number }[]} ascending order
 */
export function accountRunning(ledger, account) {
  const txs = ledger.transactions.filter((t) => t.accountId === account.id);
  return calculateRunningBalance(txs, signedOpening(account)).map((r) => ({
    transaction: r.transaction,
    runningBalance: toDisplay(account, r.runningBalance),
  }));
}

/** Current (latest) balance per account id, in display terms. */
export function accountBalances(ledger) {
  const out = {};
  for (const account of ledger.accounts) {
    const running = accountRunning(ledger, account);
    out[account.id] = running.length ? running[running.length - 1].runningBalance : account.openingBalance;
  }
  return out;
}

/**
 * Balance after every transaction dated on or before `dateIso` (inclusive),
 * in display terms — i.e. ignoring anything backfilled/entered further into
 * the future than that date. Used for "balance as of today" and "balance at
 * month-end" rather than the account's single latest (possibly far-future)
 * entry.
 */
export function balanceAsOf(ledger, account, dateIso) {
  const signed = ledger.transactions
    .filter((t) => t.accountId === account.id && t.date <= dateIso && !t.skipped)
    .reduce((sum, t) => sum + (t.direction === 'credit' ? t.amount : -t.amount), signedOpening(account));
  return toDisplay(account, signed);
}

/**
 * Previously-used descriptions, most recent first, with the last amount and
 * direction used — drives the description autocomplete / prefill.
 */
export function descriptionHistory(ledger, accountId = null) {
  const seen = new Map();
  for (let i = ledger.transactions.length - 1; i >= 0; i--) {
    const t = ledger.transactions[i];
    if (accountId && t.accountId !== accountId) continue;
    const key = t.description.toLowerCase();
    if (!t.description || seen.has(key)) continue;
    seen.set(key, { description: t.description, amount: t.amount, direction: t.direction, kind: t.kind });
  }
  return [...seen.values()];
}
