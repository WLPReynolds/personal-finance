/**
 * Reconciling an account against the bank (v0.8).
 *
 * WHAT IS STORED: one flag per entry, `transaction.reconciled === true`,
 * meaning "I've matched this line against the bank / card statement".
 * Absent or false = not yet. It is an ordinary field on the record, so it
 * syncs and merges like any other edit (Wayne chose a tick per entry over a
 * "reconciled up to" date). A transfer's two legs are ticked separately —
 * each account reconciles its own side.
 *
 * WHAT IS NOT STORED: the closing balance typed in from the bank, the totals
 * and the difference. Those are worked out while the reconcile screen is open.
 *
 * Two kinds of period:
 *  - a credit card with statement dates reconciles against a STATEMENT
 *    (entries on that statement — statementMonth or by date, statements.js);
 *  - any other account reconciles up to a CLOSING DATE.
 * In both, everything up to the closing point counts towards the totals, and
 * earlier entries left unticked are listed alongside this period's so nothing
 * is lost when a line turns up on a later statement.
 *
 * The maths, in the account's own terms (a card's figures are amounts owed):
 *   ticked balance = opening balance + every ticked entry up to the closing point
 *   difference     = bank's closing balance − ticked balance
 * When every line on the bank statement is ticked, the difference is £0.00
 * ("Balanced"). Nothing is ticked automatically (Wayne's choice).
 */
import { signedOpening, toDisplay } from './ops.js';
import { sortForBalance } from './balances.js';
import { statementConfig, statementDate, effectiveStatementMonth, addMonths } from './statements.js';

export const isReconciled = (t) => t?.reconciled === true;

/** Entries that can be reconciled: real money entries (not notes, projections, statement rows or skipped ones). */
export function isReconcilable(t) {
  return Boolean(t) && t.kind !== 'note' && !t.isProjected && !t.isStatement && !t.skipped;
}

function touch(ledger) {
  return { ...ledger, lastModified: new Date().toISOString() };
}

/** Tick or untick one entry. Only that entry changes — a transfer's other leg is on another account. */
export function setReconciled(ledger, id, on) {
  const t = ledger.transactions.find((x) => x.id === id);
  if (!t) throw new Error('Entry not found');
  if (!isReconcilable(t)) throw new Error('Only money entries can be reconciled');
  return touch({ ...ledger, transactions: ledger.transactions.map((x) => (x.id === id ? { ...x, reconciled: Boolean(on) } : x)) });
}

const pad = (n) => String(n).padStart(2, '0');
function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** Same day a month earlier (clamped to that month's length), e.g. 31 Mar -> 28 Feb. */
function monthEarlier(iso) {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  const days = new Date(Date.UTC(py, pm, 0)).getUTCDate();
  return `${py}-${pad(pm)}-${pad(Math.min(Number(iso.slice(8, 10)), days))}`;
}

/** Does this account reconcile against card statements (rather than a closing date)? */
export const reconcilesByStatement = (account) => Boolean(statementConfig(account));

/**
 * Everything the reconcile screen needs for one account and period.
 *
 * @param {object} ledger   the REAL ledger (not a view with projections)
 * @param {object} account
 * @param {{ month?: string, toDate?: string }} period
 *        month  — card statement month 'YYYY-MM' (statement cards)
 *        toDate — closing date 'YYYY-MM-DD' (other accounts)
 * @returns {{
 *   kind: 'statement'|'date', month: string|null, closingDate: string, fromDate: string,
 *   entries: Array<{ tx: object, inPeriod: boolean, reconciled: boolean }>,
 *   opening: number, tickedBalance: number, appBalance: number,
 *   tickedCount: number, totalCount: number, earlierUnticked: number,
 * }}
 *   entries     — this period's entries plus earlier unticked ones, oldest first
 *   appBalance  — the balance the app works out at the closing point (all entries, ticked or not)
 *   tickedBalance — opening + ticked entries up to the closing point
 *   counts are over the listed entries
 */
export function reconcileScope(ledger, account, period, holidays) {
  const byStatement = reconcilesByStatement(account) && period.month;
  let closingDate;
  let fromDate; // first day of this period
  let inScope; // up to the closing point
  let inPeriod; // within this period
  if (byStatement) {
    const month = period.month;
    closingDate = statementDate(account, month, holidays);
    const prev = statementDate(account, addMonths(month, -1), holidays);
    fromDate = prev ? addDays(prev, 1) : account.openingDate;
    const cache = new Map();
    const stmtOf = (t) => {
      if (t.statementMonth) return t.statementMonth;
      if (!cache.has(t.date)) cache.set(t.date, effectiveStatementMonth(account, { date: t.date }, holidays));
      return cache.get(t.date);
    };
    inScope = (t) => stmtOf(t) <= month;
    inPeriod = (t) => stmtOf(t) === month;
  } else {
    closingDate = period.toDate;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(closingDate ?? '')) throw new Error('Choose a closing date');
    fromDate = addDays(monthEarlier(closingDate), 1);
    inScope = (t) => t.date <= closingDate;
    inPeriod = (t) => t.date >= fromDate && t.date <= closingDate;
  }

  const own = sortForBalance(ledger.transactions.filter((t) => t.accountId === account.id && isReconcilable(t)));
  const signed = (t) => (t.direction === 'credit' ? t.amount : -t.amount);
  let app = signedOpening(account);
  let ticked = signedOpening(account);
  const entries = [];
  let earlierUnticked = 0;
  for (const t of own) {
    if (!inScope(t)) continue;
    app += signed(t);
    if (isReconciled(t)) ticked += signed(t);
    const here = inPeriod(t);
    if (here || !isReconciled(t)) {
      entries.push({ tx: t, inPeriod: here, reconciled: isReconciled(t) });
      if (!here) earlierUnticked++;
    }
  }
  return {
    kind: byStatement ? 'statement' : 'date',
    month: byStatement ? period.month : null,
    closingDate,
    fromDate,
    entries,
    opening: account.openingBalance,
    tickedBalance: toDisplay(account, ticked),
    appBalance: toDisplay(account, app),
    tickedCount: entries.filter((e) => e.reconciled).length,
    totalCount: entries.length,
    earlierUnticked,
  };
}

/** Bank's closing balance minus the ticked balance (both in the account's own terms). 0 = balanced. */
export function reconcileDifference(scope, bankClosing) {
  return bankClosing - scope.tickedBalance;
}

/**
 * The period to open the reconcile screen on: for a statement card, the
 * latest statement produced on or before today (or its first one); for any
 * other account, today.
 */
export function defaultPeriod(account, todayIso, holidays) {
  if (!reconcilesByStatement(account)) return { toDate: todayIso };
  let m = todayIso.slice(0, 7);
  const d = statementDate(account, m, holidays);
  if (!d || d > todayIso) m = addMonths(m, -1);
  const first = effectiveStatementMonth(account, { date: account.openingDate }, holidays);
  return { month: first && m < first ? first : m };
}

/** How many of an account's entries up to `toIso` are not yet ticked (for the header badge). */
export function untickedCount(ledger, account, toIso) {
  return ledger.transactions.filter((t) => t.accountId === account.id && isReconcilable(t) && t.date <= toIso && !isReconciled(t)).length;
}
