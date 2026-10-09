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
import { cleanEnvelopeConfig, envelopesInUse, validateSplits, fitSplits, isEnvelopeMove, envelopeConfig } from './envelopes.js';
import { assertNoLoanTransferOut, cleanLimit, isLoan } from './limits.js';

export const ACCOUNT_TYPES = ['current', 'savings', 'credit', 'loan'];

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
 * @param {{ name: string, type: 'current'|'savings'|'credit'|'loan', institution: string, openingBalance: number, openingDate: string, overdraftLimit?: number|null, creditLimit?: number|null }} fields
 *   v0.14: 'loan' = loan / credit account (stored as a negative balance, shown as owed); limits (pence) are optional
 */
export function addAccount(ledger, fields) {
  if (!fields.name?.trim()) throw new Error('Account name is required');
  if (!Number.isInteger(fields.openingBalance)) throw new Error('Opening balance must be whole pence');
  if (fields.type && !ACCOUNT_TYPES.includes(fields.type)) throw new Error('Choose an account type');
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
        ? cleanCreditCard({ statementWorkingDay: null, nextStatementDateOverride: null, statementBalance: 0, paymentDaysAfter: null, ...(fields.creditCard ?? {}) })
        : null,
    envelopes: null,
    createdAt: new Date().toISOString(),
  };
  // v0.14 limits: only set when given, so accounts made by older code stay as they were
  const limits = cleanLimits(account.type, fields);
  Object.assign(account, limits);
  if (fields.envelopes) {
    if (account.type === 'credit') throw new Error('A credit card can’t use envelopes');
    if (isLoan(account)) throw new Error('A loan account can’t use envelopes');
    account.envelopes = cleanEnvelopeConfig(fields.envelopes);
  }
  return { ledger: touch({ ...ledger, accounts: [...ledger.accounts, account] }), account };
}

/**
 * Statement settings (v0.7): statementWorkingDay 1-20 or null (= no
 * statements), paymentDaysAfter 1-60 or null (= the usual 25).
 */
function cleanCreditCard(cc) {
  const wd = cc.statementWorkingDay;
  if (wd !== null && (!Number.isInteger(wd) || wd < 1 || wd > 20)) throw new Error('Statement working day must be 1 to 20, or blank');
  const days = cc.paymentDaysAfter ?? null;
  if (days !== null && (!Number.isInteger(days) || days < 1 || days > 60)) throw new Error('Payment due must be 1 to 60 days after the statement');
  return { ...cc, paymentDaysAfter: days };
}

/** v0.14: overdraft limit for current/savings, credit limit for cards; neither on a loan. */
function cleanLimits(type, fields) {
  const out = {};
  if ('overdraftLimit' in fields) out.overdraftLimit = type === 'credit' || type === 'loan' ? null : cleanLimit(fields.overdraftLimit, 'Overdraft limit');
  if ('creditLimit' in fields) out.creditLimit = type === 'credit' ? cleanLimit(fields.creditLimit, 'Credit limit') : null;
  return out;
}

export function updateAccount(ledger, id, fields) {
  const accounts = ledger.accounts.map((a) => {
    if (a.id !== id) return a;
    const next = { ...a, ...fields, ...cleanLimits(fields.type ?? a.type, fields) };
    if (next.type && !ACCOUNT_TYPES.includes(next.type)) throw new Error('Choose an account type');
    if (isLoan(next) && !isLoan(a)) {
      // becoming a loan account: nothing may already take money out of it by transfer
      const out = ledger.transactions.filter((t) => t.accountId === a.id && t.transferId && t.direction === 'debit').length;
      const items = (ledger.scheduledItems ?? []).filter((r) => r.recordType === 'recurring' && r.kind === 'transfer' && r.accountId === a.id).length;
      if (out || items) {
        throw new Error(`${a.name} has ${[out && `${out} transfer${out === 1 ? '' : 's'} out`, items && `${items} recurring transfer${items === 1 ? '' : 's'} out`].filter(Boolean).join(' and ')}. A loan account can’t — change ${out + items === 1 ? 'it' : 'them'} first.`);
      }
      if (envelopeConfig(a)) throw new Error('A loan account can’t use envelopes — turn them off first');
    }
    if (next.type === 'credit' && !next.creditCard) {
      next.creditCard = { statementWorkingDay: null, nextStatementDateOverride: null, statementBalance: 0, paymentDaysAfter: null };
    }
    if (next.creditCard) next.creditCard = cleanCreditCard(next.creditCard);
    if ('envelopes' in fields) {
      if (next.type === 'credit' && fields.envelopes?.list?.length) throw new Error('A credit card can’t use envelopes');
      if (isLoan(next) && fields.envelopes?.enabled && fields.envelopes?.list?.length) throw new Error('A loan account can’t use envelopes');
      next.envelopes = cleanEnvelopeConfig(fields.envelopes, a.envelopes, envelopesInUse(ledger, a.id));
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
    envelopeSplits: fields.envelopeSplits ?? null,
    scheduledItemId: null,
    isProjected: false,
    statementMonth: fields.statementMonth ?? null,
  };
}

function validate(fields) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fields.date ?? '')) throw new Error('A valid date is required');
  if (fields.statementMonth != null && !/^\d{4}-\d{2}$/.test(fields.statementMonth)) throw new Error('Not a valid statement month');
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
  const acc = (id) => ledger.accounts.find((a) => a.id === id);
  // v0.12: envelopes for this entry, and for the other leg of a transfer into/out of an envelope account
  const ownSplits = fields.kind === 'note' ? null : validateSplits(acc(fields.accountId), fields.amount, fields.envelopeSplits);
  const otherSplits = fields.kind === 'note' || !fields.counterpartAccountId ? null
    : validateSplits(acc(fields.counterpartAccountId), fields.amount, fields.counterpartEnvelopeSplits);
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
    if (fields.statementMonth) ordered[0] = { ...ordered[0], statementMonth: fields.statementMonth };
    if (ownSplits) ordered[0] = { ...ordered[0], envelopeSplits: ownSplits };
    if (otherSplits) ordered[1] = { ...ordered[1], envelopeSplits: otherSplits };
    assertNoLoanTransferOut(ledger.accounts, ordered); // v0.14
    return touch({
      ...ledger,
      transactions: [...ledger.transactions, ...ordered],
      transfers: [...ledger.transfers, transfer],
    });
  }
  return touch({ ...ledger, transactions: [...ledger.transactions, blankTx({ ...fields, envelopeSplits: ownSplits })] });
}

/** Fields whose change means a reconciled entry must be checked again (v0.8). A new description doesn't. */
const RECONCILE_FIELDS = ['amount', 'date', 'direction', 'accountId', 'kind', 'statementMonth'];
const changedFrom = (before, after, keys) => keys.some((k) => (after[k] ?? null) !== (before[k] ?? null));

/**
 * Edit a transaction in place (keeps its position = same-day order).
 * For a transfer leg, date/amount/description are mirrored onto the other
 * leg; changing direction flips both legs.
 * v0.8: changing the amount, date, direction, account, kind or statement of a
 * reconciled entry clears its tick — and the other leg's, when the change is
 * mirrored onto it — so it gets checked again (the UI warns first).
 */
export function updateTransaction(ledger, id, fields) {
  const existing = ledger.transactions.find((t) => t.id === id);
  if (!existing) throw new Error('Transaction not found');
  if (isEnvelopeMove(existing)) throw new Error('Edit a move between envelopes from its own dialog');
  const merged = { ...existing, ...fields };
  validate(merged);
  if (merged.kind === 'note') merged.amount = 0;
  // v0.12 envelopes: given → checked; not given → the old ones follow a new amount where they can
  const account = ledger.accounts.find((a) => a.id === merged.accountId);
  if (merged.kind === 'note') merged.envelopeSplits = null;
  else if ('envelopeSplits' in fields && envelopeConfig(account)) merged.envelopeSplits = validateSplits(account, merged.amount, fields.envelopeSplits);
  else merged.envelopeSplits = fitSplits(existing.envelopeSplits, merged.amount);
  merged.description = (merged.description ?? '').trim();
  if (existing.reconciled && changedFrom(existing, merged, RECONCILE_FIELDS)) merged.reconciled = false;

  if (!existing.transferId) {
    return touch({ ...ledger, transactions: ledger.transactions.map((t) => (t.id === id ? merged : t)) });
  }

  const opposite = merged.direction === 'credit' ? 'debit' : 'credit';
  const transactions = ledger.transactions.map((t) => {
    if (t.id === id) return merged;
    if (t.transferId === existing.transferId) {
      const leg = { ...t, date: merged.date, amount: merged.amount, description: merged.description, direction: opposite };
      if (t.envelopeSplits) leg.envelopeSplits = fitSplits(t.envelopeSplits, merged.amount);
      if (t.reconciled && changedFrom(t, leg, ['amount', 'date', 'direction'])) leg.reconciled = false;
      return leg;
    }
    return t;
  });
  assertNoLoanTransferOut(ledger.accounts, transactions.filter((t) => t.transferId === existing.transferId)); // v0.14
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

/**
 * Say which card statement an entry is on (statements.js). Pass null for
 * "whichever its date says". Only this entry changes — not a transfer's
 * other leg, which is on a different account. Moving a reconciled entry to
 * another statement clears its tick (v0.8).
 */
export function setStatementMonth(ledger, id, month) {
  if (month !== null && !/^\d{4}-\d{2}$/.test(month)) throw new Error('Not a valid statement month');
  if (!ledger.transactions.some((t) => t.id === id)) throw new Error('Transaction not found');
  return touch({
    ...ledger,
    transactions: ledger.transactions.map((t) => {
      if (t.id !== id) return t;
      const next = { ...t, statementMonth: month };
      if (t.reconciled && (t.statementMonth ?? null) !== month) next.reconciled = false;
      return next;
    }),
  });
}

// ------------------------------------------------------------ envelopes (v0.12)

/**
 * Put one entry into envelopes (e.g. the Monzo leg of a transfer edited from
 * the current account's side). splits null/[] = Unallocated.
 */
export function setEnvelopeSplits(ledger, id, splits) {
  const t = ledger.transactions.find((x) => x.id === id);
  if (!t) throw new Error('Transaction not found');
  if (t.kind === 'note') throw new Error('A note has no money to put in an envelope');
  const account = ledger.accounts.find((a) => a.id === t.accountId);
  const clean = validateSplits(account, t.amount, splits);
  return touch({ ...ledger, transactions: ledger.transactions.map((x) => (x.id === id ? { ...x, envelopeSplits: clean } : x)) });
}

function moveRecord(ledger, fields) {
  const account = ledger.accounts.find((a) => a.id === fields.accountId);
  if (!envelopeConfig(account)) throw new Error('This account doesn’t use envelopes');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fields.date ?? '')) throw new Error('A valid date is required');
  if (!Number.isInteger(fields.amount) || fields.amount <= 0) throw new Error('Amount must be more than £0.00');
  const from = fields.fromEnvelopeId ?? null;
  const to = fields.toEnvelopeId ?? null;
  const known = new Set(account.envelopes.list.map((e) => e.id));
  for (const id of [from, to]) if (id !== null && !known.has(id)) throw new Error('Pick an envelope');
  if (from === to) throw new Error('Pick two different envelopes');
  return {
    accountId: account.id,
    date: fields.date,
    amount: 0,
    direction: 'credit',
    description: (fields.description ?? '').trim() || 'Move between envelopes',
    kind: 'note',
    envelopeSplits: [{ envelopeId: from, amount: -fields.amount }, { envelopeId: to, amount: fields.amount }],
  };
}

/**
 * Move money from one envelope to another (null = Unallocated). Stored as a
 * note — the account's balance doesn't change, and a device older than v0.12
 * just shows it as a note.
 * fields: { accountId, date, amount, fromEnvelopeId, toEnvelopeId, description }
 */
export function addEnvelopeMove(ledger, fields) {
  const rec = moveRecord(ledger, fields);
  return touch({ ...ledger, transactions: [...ledger.transactions, { ...blankTx({ ...rec, kind: 'note', description: rec.description }), ...rec }] });
}

export function updateEnvelopeMove(ledger, id, fields) {
  const existing = ledger.transactions.find((t) => t.id === id);
  if (!isEnvelopeMove(existing)) throw new Error('Move not found');
  const rec = moveRecord(ledger, { accountId: existing.accountId, ...fields });
  return touch({ ...ledger, transactions: ledger.transactions.map((t) => (t.id === id ? { ...t, ...rec } : t)) });
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
  // v0.14: a loan is stored like a current account (negative = owed) but shown as owed, like a card
  return account.type === 'credit' || account.type === 'loan' ? -signed : signed;
}

/** The opening figure as shown (owed for cards and loans). */
export function displayOpening(account) {
  return toDisplay(account, signedOpening(account));
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
    out[account.id] = running.length ? running[running.length - 1].runningBalance : displayOpening(account);
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
