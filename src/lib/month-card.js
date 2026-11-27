/**
 * v0.15.26: the "This month" card at the top of the phone Summary (Wayne, 27 Nov).
 * Design: Project doc claude/summary-card-design.md.
 *
 *  - Payday comes from recurring "money in" items ticked `isPay` (no new date
 *    rules: day of month + the weekend/bank-holiday shift already cover both
 *    people's pay).
 *  - "Left until payday" = the projected balance of the account the pay goes
 *    into, at the end of the day before payday.
 *  - "Spent" = confirmed money going to anyone outside your own accounts:
 *    debits that aren't a transfer leg; card / loan refunds (credits with no
 *    transfer) take it down. Card purchases count on the day bought.
 *  - Compared with last month to the same day, until three full months of
 *    live data exist; then the average of the last three months to that day.
 *  - Next 7 days: money out — bills, and card / loan payments — not moves
 *    between your own other accounts.
 *
 * Pure functions, no I/O. Ledgers here are view ledgers (with projections)
 * unless the name says otherwise.
 */
import { addDays, daysInMonth } from './workdays.js';
import { balanceAsOf } from './ops.js';
import { balanceProblems } from './limits.js';

const pad = (n) => String(n).padStart(2, '0');
const monthStart = (iso) => `${iso.slice(0, 7)}-01`;
/** First of the month `n` months from `iso`'s month. */
function shiftMonth(iso, n) {
  const [y, m] = iso.split('-').map(Number);
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${pad((idx % 12) + 1)}-01`;
}
/** The same day of the month in `firstOfMonth`'s month, clamped (31 Mar → 28 Feb). */
function sameDayIn(firstOfMonth, day) {
  const [y, m] = firstOfMonth.split('-').map(Number);
  return `${firstOfMonth.slice(0, 8)}${pad(Math.min(day, daysInMonth(y, m)))}`;
}

/** Ids of the recurring items ticked as pay. */
export function payItemIds(ledger) {
  return new Set((ledger.scheduledItems ?? []).filter((r) => r.recordType === 'recurring' && r.kind === 'in' && r.isPay).map((r) => r.id));
}

/**
 * The next payday from the view ledger (projected or confirmed pay, not skipped).
 * @returns {{ date: string, accountId: string, isToday: boolean, todayPay: object|null } | null}
 *   `date` is the payday counted to: when pay lands today, the one after it.
 */
export function nextPayday(view, today) {
  const ids = payItemIds(view);
  if (!ids.size) return null;
  const pays = view.transactions
    .filter((t) => ids.has(t.scheduledItemId) && t.direction === 'credit' && !t.skipped && t.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!pays.length) return null;
  const isToday = pays[0].date === today;
  const next = isToday ? pays.find((t) => t.date > today) : pays[0];
  if (!next) return isToday ? { date: null, accountId: pays[0].accountId, isToday, todayPay: pays[0] } : null;
  return { date: next.date, accountId: next.accountId, isToday, todayPay: isToday ? pays[0] : null };
}

/** Whole days from today to iso (0 = today). */
export function daysUntil(today, iso) {
  return Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
}

/** Projected balance of the pay account at the end of the day before payday. */
export function leftUntilPayday(view, payday) {
  if (!payday?.date) return null;
  const account = view.accounts.find((a) => a.id === payday.accountId);
  if (!account) return null;
  return { account, balance: balanceAsOf(view, account, addDays(payday.date, -1)), date: addDays(payday.date, -1) };
}

const REFUNDABLE = new Set(['credit', 'loan']);
/**
 * Money spent with anyone outside your own accounts, from fromIso to toIso
 * inclusive, on the given accounts. Confirmed entries only (projections and
 * statement rows are ignored, so a view ledger can be passed safely).
 */
export function spentBetween(ledger, accountIds, fromIso, toIso) {
  const ids = accountIds instanceof Set ? accountIds : new Set(accountIds);
  const types = new Map(ledger.accounts.map((a) => [a.id, a.type]));
  let total = 0;
  for (const t of ledger.transactions) {
    if (!ids.has(t.accountId) || t.date < fromIso || t.date > toIso) continue;
    if (t.isProjected || t.isStatement || t.skipped || t.kind === 'note' || t.transferId) continue;
    if (t.direction === 'debit') total += t.amount;
    else if (REFUNDABLE.has(types.get(t.accountId))) total -= t.amount; // a refund on a card or loan
  }
  return total;
}

/** Spent this month to today. */
export function spentThisMonth(ledger, accountIds, today) {
  return spentBetween(ledger, accountIds, monthStart(today), today);
}

/**
 * What this month's spend to today is compared with: last month to the same
 * day while fewer than three full months of records exist, then the average of
 * the last three months to that day. Records start at the earliest opening date
 * of the given accounts; a month counts as full only from its 1st.
 * @returns {{ basis: 'last-month'|'three-months', usual: number, diff: number } | null}
 *   diff = this month − usual (negative = under)
 */
export function spendComparison(ledger, accountIds, today) {
  const ids = accountIds instanceof Set ? accountIds : new Set(accountIds);
  const openings = ledger.accounts.filter((a) => ids.has(a.id) && a.openingDate).map((a) => a.openingDate).sort();
  if (!openings.length) return null;
  const firstFull = openings[0].endsWith('-01') ? openings[0] : shiftMonth(openings[0], 1);
  const thisMonth = monthStart(today);
  let full = 0;
  for (let m = firstFull; m < thisMonth && full < 3; m = shiftMonth(m, 1)) full++;
  if (!full) return null;
  const day = Number(today.slice(8, 10));
  const months = full >= 3 ? [1, 2, 3] : [1];
  const totals = months.map((n) => {
    const start = shiftMonth(today, -n);
    return spentBetween(ledger, ids, start, sameDayIn(start, day));
  });
  const usual = Math.round(totals.reduce((s, v) => s + v, 0) / totals.length);
  const now = spentThisMonth(ledger, ids, today);
  return { basis: full >= 3 ? 'three-months' : 'last-month', usual, diff: now - usual };
}

/**
 * Money going out over the next `days` days (today included): bills and other
 * payments to the outside world, plus card and loan payments; not moves between
 * your own other accounts (pots, envelopes, ring-fencing). Projected entries
 * from today, confirmed ones dated after today (today's have happened).
 */
export function comingUp(view, today, days = 7) {
  const last = addDays(today, days - 1);
  const types = new Map(view.accounts.map((a) => [a.id, a.type]));
  const legs = new Map();
  for (const t of view.transactions) if (t.transferId) legs.set(`${t.transferId}|${t.direction}`, t);
  const out = [];
  for (const t of view.transactions) {
    if (t.direction !== 'debit' || t.date > last || t.skipped || t.kind === 'note' || t.isStatement) continue;
    if (t.isProjected ? t.date < today : t.date <= today) continue;
    if (t.ringFenceOf) continue;
    if (t.transferId) {
      const other = legs.get(`${t.transferId}|credit`);
      if (!other || !REFUNDABLE.has(types.get(other.accountId))) continue; // only paying a card or loan
    } else if (types.get(t.accountId) === 'credit') {
      continue; // a spend on a card is paid with the card's payment, which is listed
    }
    out.push(t);
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount);
}

/**
 * Every account's limit warnings over the dates shown, soonest first:
 * [{ account, level, date, balance }].
 */
export function allWarnings(view, accounts, fromIso, toIso) {
  const out = [];
  for (const account of accounts) {
    const pr = balanceProblems(view, account, fromIso, toIso);
    if (!pr) continue;
    for (const [level, p] of Object.entries(pr.first)) out.push({ account, level, date: p.date, balance: p.balance });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
