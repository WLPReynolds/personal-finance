/**
 * v0.14: account limits and warnings (Wayne, 8 Oct).
 *
 *  - Current / savings / joint accounts may have an arranged OVERDRAFT LIMIT
 *    (`account.overdraftLimit`, pence ≥ 0, null/0 = none). Below £0 is
 *    "overdrawn" (no overdraft) or "into the overdraft"; below −limit is
 *    "past the overdraft limit".
 *  - Credit cards may have a CREDIT LIMIT (`account.creditLimit`); owing more
 *    than it is "over the credit limit".
 *  - LOAN / credit accounts (`type: 'loan'`, no interest worked out): stored
 *    exactly like a current account — a negative balance — so an older version
 *    still shows the right figure; only the DISPLAY flips to "Owed £x". Money
 *    can't be transferred out of one (the one hard block); charges/interest
 *    are ordinary entries. No limits apply. v0.14.1: envelopes allowed (one
 *    loan can hold several "reasons" to borrow), their figures shown as owed.
 *
 * These are WARNINGS, never blocks: on saving, a change that makes an
 * account's balance cross one of those lines, within the dates shown on
 * screen, asks first. On screen, every balance past a line is flagged.
 * Pure functions, no I/O.
 */
import { accountRunning, balanceAsOf } from './ops.js';

export const isLoan = (a) => a?.type === 'loan';
/** Accounts shown as "Owed £x" rather than a balance. */
export const showsOwed = (a) => a?.type === 'credit' || a?.type === 'loan';

export const LEVELS = {
  overdraft: { severity: 1, label: 'into the overdraft' },
  overdrawn: { severity: 2, label: 'overdrawn' },
  'past-overdraft': { severity: 2, label: 'past the overdraft limit' },
  'over-credit-limit': { severity: 2, label: 'over the credit limit' },
};

const limit = (v) => (Number.isInteger(v) && v > 0 ? v : 0);

/** Which line a display balance has crossed for this account, or null. */
export function balanceLevel(account, display) {
  if (!account || isLoan(account)) return null;
  if (account.type === 'credit') {
    const cl = limit(account.creditLimit);
    return cl && display > cl ? 'over-credit-limit' : null;
  }
  if (display >= 0) return null;
  const od = limit(account.overdraftLimit);
  if (!od) return 'overdrawn';
  return -display > od ? 'past-overdraft' : 'overdraft';
}

/** "Worse" for this account: lower balance, or for a card more owed. */
const worse = (account, a, b) => (account.type === 'credit' ? a > b : a < b);

/**
 * Lines crossed between fromIso and toIso (inclusive), from a ledger that
 * includes projections: the first date each level is reached, the worst
 * level, and the lowest point (highest owed for a card). null = none.
 */
export function balanceProblems(view, account, fromIso, toIso) {
  if (!account || isLoan(account)) return null;
  const points = [{ date: fromIso, balance: balanceAsOf(view, account, fromIso) }];
  for (const r of accountRunning(view, account)) {
    const d = r.transaction.date;
    if (d > fromIso && d <= toIso && r.transaction.kind !== 'note') points.push({ date: d, balance: r.runningBalance, tx: r.transaction });
  }
  const first = {};
  let extreme = null;
  let worst = null;
  for (const p of points) {
    const level = balanceLevel(account, p.balance);
    if (!level) continue;
    if (!first[level]) first[level] = p;
    if (!extreme || worse(account, p.balance, extreme.balance)) extreme = p;
    if (!worst || LEVELS[level].severity > LEVELS[worst].severity) worst = level;
  }
  return worst ? { first, worst, extreme } : null;
}

/**
 * The warnings a change should give. Day by day, within the dates shown: a
 * day counts when the change makes that day's closing balance WORSE (or
 * reaches a worse line) and it is past a line. For each line, the first such
 * day is reported, with the entry that does it and the balance it had before.
 * So an account already overdrawn for other reasons isn't reported on its old
 * dates, and an unrelated save warns about nothing (v0.14.1, after Wayne's
 * test: a big card spend's knock-on on the current account named old entries).
 * @returns {{ account, level, date, balance, was, limit, cause }[]} soonest first
 */
export function newLimitProblems(beforeView, afterView, fromIso, toIso) {
  const out = [];
  for (const account of afterView.accounts) {
    if (isLoan(account)) continue;
    const prevAcc = beforeView.accounts.find((a) => a.id === account.id) ?? null;
    const rows = [{ date: fromIso, tx: null }];
    for (const r of accountRunning(afterView, account)) {
      const d = r.transaction.date;
      if (d > fromIso && d <= toIso && r.transaction.kind !== 'note') rows.push({ date: d, tx: r.transaction });
    }
    const first = {};
    const seen = new Set();
    for (const row of rows) {
      if (seen.has(row.date)) continue; // one look per day, at its closing balance
      seen.add(row.date);
      const now = balanceAsOf(afterView, account, row.date);
      const level = balanceLevel(account, now);
      if (!level || first[level]) continue;
      const was = prevAcc ? balanceAsOf(beforeView, prevAcc, row.date) : null;
      const wasLevel = prevAcc ? balanceLevel(prevAcc, was) : null;
      const madeWorse = was === null || worse(account, now, was) || !wasLevel || LEVELS[level].severity > LEVELS[wasLevel].severity;
      if (!madeWorse) continue;
      // the day's entry that does it: the last one on that day in this account (the closing balance's)
      const dayTxs = rows.filter((r) => r.date === row.date && r.tx).map((r) => r.tx);
      const cause = dayTxs.at(-1) ?? null;
      first[level] = { date: row.date, balance: now, was: wasLevel ? was : null, cause };
    }
    for (const [level, p] of Object.entries(first)) {
      out.push({
        account, level, date: p.date, balance: p.balance, was: p.was,
        limit: account.type === 'credit' ? limit(account.creditLimit) : limit(account.overdraftLimit),
        cause: p.cause,
      });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || LEVELS[b.level].severity - LEVELS[a.level].severity);
}

export class LoanTransferError extends Error {
  constructor(name) {
    super(`Money can’t be transferred out of ${name ?? 'a loan account'} — it’s a loan / credit account. Payments into it are fine, and charges or interest can be added as money out.`);
    this.name = 'LoanTransferError';
  }
}

/** Throw if any of these entries is a transfer leg taking money OUT of a loan account. */
export function assertNoLoanTransferOut(accounts, txs) {
  for (const t of txs) {
    if (!t?.transferId || t.direction !== 'debit') continue;
    const a = accounts.find((x) => x.id === t.accountId);
    if (isLoan(a)) throw new LoanTransferError(a.name);
  }
}

/** Clean a limit typed into the account dialog: null (none) or whole pence ≥ 0. */
export function cleanLimit(v, what) {
  if (v === null || v === undefined || v === '') return null;
  if (!Number.isInteger(v) || v < 0) throw new Error(`${what} must be £0.00 or more, or blank`);
  return v || null;
}
