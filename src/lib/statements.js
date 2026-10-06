/**
 * Credit card statements (v0.7).
 *
 * A card with `creditCard.statementWorkingDay` set (Barclaycard: 13) produces
 * a statement on that working day of every month; the payment is due
 * `creditCard.paymentDaysAfter` days later (Barclaycard: 25), moved to the
 * next working day if that's a weekend or bank holiday. Checked against
 * Wayne's real 2026 statements: 17 Jun -> 13 Jul, 17 Jul -> 11 Aug,
 * 19 Aug -> 14 Sep, 17 Sep -> 12 Oct.
 *
 * Statements are identified by the MONTH they're produced in ("YYYY-MM").
 *
 * Which statement an entry is on: by default, the first statement dated on
 * or after the entry. The bank doesn't always agree (a spend made on the
 * statement day, or the day before, can appear on the next one), so an entry
 * may carry `statementMonth` to say which statement it's really on. Stored
 * only when it differs from the date-based one (null otherwise).
 *
 * The amount owed on a statement is WORKED OUT from the entries, never typed
 * in: opening amount owed + every entry on that statement or an earlier one.
 * A statement from before the card's opening date can't be worked out.
 *
 * Nothing here is stored: statement rows are derived for display, like
 * projected recurring entries.
 */
import { nthWorkingDay, addDays, shiftToWorkingDay, daysInMonth } from './workdays.js';

export const DEFAULT_PAYMENT_DAYS = 25;
/** How close to a statement date an entry has to be before we offer to move it. */
export const BOUNDARY_DAYS = 3;

const pad = (n) => String(n).padStart(2, '0');
export const monthOf = (iso) => iso.slice(0, 7);
export function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${pad((idx % 12) + 1)}`;
}

/** { workingDay, paymentDays } for a card with statements set up, else null. */
export function statementConfig(account) {
  const cc = account?.type === 'credit' ? account.creditCard : null;
  if (!cc || !Number.isInteger(cc.statementWorkingDay) || cc.statementWorkingDay < 1) return null;
  const days = Number.isInteger(cc.paymentDaysAfter) && cc.paymentDaysAfter > 0 ? cc.paymentDaysAfter : DEFAULT_PAYMENT_DAYS;
  return { workingDay: cc.statementWorkingDay, paymentDays: days };
}

/** The statement date in a month, or null when the card has no statement set up. */
export function statementDate(account, month, holidays) {
  const cfg = statementConfig(account);
  if (!cfg) return null;
  const [y, m] = month.split('-').map(Number);
  // a working day past the end of the month (can't happen for sensible
  // settings) falls back to the month's last day
  return nthWorkingDay(y, m, cfg.workingDay, holidays) ?? `${month}-${pad(daysInMonth(y, m))}`;
}

/** The payment due date for the statement produced in `month`. */
export function paymentDueDate(account, month, holidays) {
  const cfg = statementConfig(account);
  const s = statementDate(account, month, holidays);
  if (!cfg || !s) return null;
  return shiftToWorkingDay(addDays(s, cfg.paymentDays), 'after', holidays);
}

/** The statement an entry dated `dateIso` falls on by date alone. */
export function statementMonthByDate(account, dateIso, holidays) {
  const m = monthOf(dateIso);
  const s = statementDate(account, m, holidays);
  if (!s) return null;
  return dateIso <= s ? m : addMonths(m, 1);
}

/** The statement an entry is actually on (its own choice, else by date). */
export function effectiveStatementMonth(account, t, holidays) {
  return t.statementMonth || statementMonthByDate(account, t.date, holidays);
}

/** The first statement produced on or after the card's opening date. */
export function firstStatementMonth(account, holidays) {
  const m = monthOf(account.openingDate);
  const s = statementDate(account, m, holidays);
  if (!s) return null;
  return s >= account.openingDate ? m : addMonths(m, 1);
}

/**
 * Amount owed on one statement, worked out from the entries in `ledger`
 * (pass a view ledger to include projected entries).
 * @returns {{ month: string, date: string, dueDate: string, owed: number|null, beforeRecords: boolean }|null}
 */
export function statementFor(ledger, account, month, holidays) {
  const date = statementDate(account, month, holidays);
  if (!date) return null;
  const dueDate = paymentDueDate(account, month, holidays);
  if (date < account.openingDate) return { month, date, dueDate, owed: null, beforeRecords: true };
  const byDate = new Map(); // date -> statement month, cached: nthWorkingDay is a loop
  let owed = account.openingBalance;
  for (const t of ledger.transactions) {
    if (t.accountId !== account.id || t.kind === 'note' || t.skipped || t.isStatement) continue;
    let eff = t.statementMonth;
    if (!eff) {
      if (!byDate.has(t.date)) byDate.set(t.date, statementMonthByDate(account, t.date, holidays));
      eff = byDate.get(t.date);
    }
    if (eff <= month) owed += t.direction === 'debit' ? t.amount : -t.amount;
  }
  return { month, date, dueDate, owed, beforeRecords: false };
}

/** Every statement month for a card from its first one to the last dated on or before `toIso`. */
export function statementMonths(account, toIso, holidays) {
  const first = firstStatementMonth(account, holidays);
  if (!first) return [];
  const out = [];
  for (let m = first; out.length < 240; m = addMonths(m, 1)) {
    const d = statementDate(account, m, holidays);
    if (d > toIso) break;
    out.push(m);
  }
  return out;
}

/**
 * The statement nearest to a date, and the two statements an entry on that
 * date could reasonably be on — for the "this statement / next statement"
 * choice. Returns null when the date isn't within BOUNDARY_DAYS of a
 * statement (or the card has none).
 * @returns {{ near: string, options: string[], byDate: string }|null}
 */
export function boundaryChoice(account, dateIso, holidays) {
  if (!statementConfig(account) || !dateIso) return null;
  const m = monthOf(dateIso);
  for (const cand of [addMonths(m, -1), m, addMonths(m, 1)]) {
    const s = statementDate(account, cand, holidays);
    const gap = Math.abs((Date.parse(dateIso) - Date.parse(s)) / 86400000);
    if (gap <= BOUNDARY_DAYS) {
      return { near: cand, options: [cand, addMonths(cand, 1)], byDate: statementMonthByDate(account, dateIso, holidays) };
    }
  }
  return null;
}

/**
 * Add derived statement rows to a view ledger and mark entries whose
 * statement differs from their date. Returns a new view; never save it.
 *
 * - Statement row: kind 'note', isStatement, `statement` = statementFor(...),
 *   id `stmt:<accountId>:<month>`.
 * - stmtOrder (display sort only): on a statement date, entries on that
 *   statement come first (0), then the statement row (1), then entries
 *   on the next one (2).
 * - stmtTag on a card entry: 'next' (on a later statement than its date
 *   says) or 'earlier' (on an earlier one), with stmtMonthLabel = that month.
 */
export function withStatements(view, toIso, holidays) {
  const cards = view.accounts.filter((a) => statementConfig(a));
  if (!cards.length) return view;
  const cardById = new Map(cards.map((c) => [c.id, c]));
  const stmtDates = new Map(); // `${cardId}|${date}` -> month, for statement dates in range
  const markers = [];
  for (const card of cards) {
    for (const month of statementMonths(card, toIso, holidays)) {
      const st = statementFor(view, card, month, holidays);
      stmtDates.set(`${card.id}|${st.date}`, month);
      markers.push({
        id: `stmt:${card.id}:${month}`, accountId: card.id, date: st.date, amount: 0, direction: 'debit',
        description: 'Statement', category: null, kind: 'note', transferId: null, envelopeSplits: null,
        scheduledItemId: null, isProjected: false, isStatement: true, statement: st, stmtOrder: 1,
      });
    }
  }
  const transactions = view.transactions.map((t) => {
    const card = cardById.get(t.accountId);
    if (!card || t.kind === 'note') return t;
    const byDate = statementMonthByDate(card, t.date, holidays);
    const eff = t.statementMonth || byDate;
    const extra = {};
    if (eff > byDate) extra.stmtTag = 'next';
    else if (eff < byDate) extra.stmtTag = 'earlier';
    if (extra.stmtTag) extra.stmtMonth = eff;
    const onDay = stmtDates.get(`${card.id}|${t.date}`);
    if (onDay && eff > onDay) extra.stmtOrder = 2;
    return Object.keys(extra).length ? { ...t, ...extra } : t;
  });
  return { ...view, transactions: [...transactions, ...markers] };
}
