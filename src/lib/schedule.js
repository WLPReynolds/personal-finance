/**
 * Recurring items (salary, direct debits, subscriptions, card payments) and
 * the projected entries they produce.
 *
 * WHAT IS STORED (all in ledger.scheduledItems, so a device on an older
 * version still carries them through a sync untouched):
 *   - recurring item  { recordType: 'recurring', ... }   the rule
 *   - occurrence      { recordType: 'occurrence', ... }  a skip or a one-off
 *                     change to one month's entry, id `occ:<itemId>:<YYYY-MM>`
 * Confirmed occurrences are ordinary transactions tagged with
 * scheduledItemId + scheduledPeriod, with an id built from the item and
 * month (`sched:<itemId>:<YYYY-MM>`), so two devices confirming the same one
 * produce the same record rather than a duplicate.
 *
 * WHAT IS NOT STORED: the projected rows themselves. They are worked out
 * from the rules every time the screen is drawn (like balances), so there is
 * nothing to fall out of step or duplicate between devices.
 *
 * An occurrence is identified by its MONTH ("period"), not its date: every
 * frequency offered (monthly, every N months, yearly) is at most once a
 * month, and keying by month means changing an item's day doesn't orphan
 * months already confirmed or skipped.
 */
import { randomUUID } from './id.js';
import { daysInMonth, shiftToWorkingDay } from './workdays.js';

export const MAX_HORIZON_MONTHS = 12;

/**
 * @typedef {Object} RecurringItem
 * @property {string} id
 * @property {'recurring'} recordType
 * @property {string} description
 * @property {'out'|'in'|'transfer'} kind
 * @property {string} accountId          - the account; for a transfer, the one the money leaves
 * @property {string|null} toAccountId   - transfer only: where the money goes (e.g. the credit card)
 * @property {number} amount             - pence
 * @property {number} everyMonths        - 1 = monthly, 12 = yearly, else every N months (counted from the start date's month)
 * @property {number} day                - 1-31; a shorter month uses its last day
 * @property {string} startDate          - ISO; nothing before this
 * @property {string|null} endDate       - ISO; last entry on or before this. null = indefinitely
 * @property {'none'|'before'|'after'} shift - weekend/bank holiday: don't move / working day before / next working day
 * @property {string} createdAt
 */

/**
 * @typedef {Object} OccurrenceException
 * @property {string} id                 - `occ:<itemId>:<period>`
 * @property {'occurrence'} recordType
 * @property {string} itemId
 * @property {string} period             - YYYY-MM
 * @property {boolean} skipped
 * @property {string|null} date          - one-off date, or null = the series' date
 * @property {number|null} amount        - one-off amount, or null = the series' amount
 * @property {string|null} description   - one-off description, or null = the series'
 */

export const isRecurring = (r) => r?.recordType === 'recurring';
export const isOccurrence = (r) => r?.recordType === 'occurrence';

export function recurringItems(ledger) {
  return (ledger.scheduledItems ?? []).filter(isRecurring);
}
export function occurrenceExceptions(ledger) {
  return (ledger.scheduledItems ?? []).filter(isOccurrence);
}

const pad = (n) => String(n).padStart(2, '0');
const periodOf = (iso) => iso.slice(0, 7);
function periodParts(period) {
  const [y, m] = period.split('-').map(Number);
  return { y, m };
}
function addMonths(period, n) {
  const { y, m } = periodParts(period);
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${pad((idx % 12) + 1)}`;
}
function monthsBetween(a, b) {
  const pa = periodParts(a);
  const pb = periodParts(b);
  return (pb.y - pa.y) * 12 + (pb.m - pa.m);
}

export const exceptionId = (itemId, period) => `occ:${itemId}:${period}`;
export const confirmedId = (itemId, period) => `sched:${itemId}:${period}`;

/** End of the month `months` after today's month, e.g. 5 Oct + 3 -> 31 Jan. */
export function horizonEnd(todayIso, months) {
  const p = addMonths(periodOf(todayIso), months);
  const { y, m } = periodParts(p);
  return `${p}-${pad(daysInMonth(y, m))}`;
}

// ------------------------------------------------------------------ dates

/** The series' own date in a month (before any weekend shift), or null if not due that month. */
export function nominalDate(item, period) {
  const offset = monthsBetween(periodOf(item.startDate), period);
  if (offset < 0 || offset % item.everyMonths !== 0) return null;
  const { y, m } = periodParts(period);
  const iso = `${period}-${pad(Math.min(item.day, daysInMonth(y, m)))}`;
  if (iso < item.startDate) return null;
  if (item.endDate && iso > item.endDate) return null;
  return iso;
}

/**
 * Every occurrence of an item whose date (after the weekend rule) falls
 * on or before `toIso`, from its start.
 * @returns {{ period: string, nominal: string, date: string }[]}
 */
export function seriesDates(item, toIso, holidays) {
  const out = [];
  const last = addMonths(periodOf(toIso), 1); // a 'before' shift can pull next month's 1st back into range
  for (let p = periodOf(item.startDate); monthsBetween(p, last) >= 0; p = addMonths(p, 1)) {
    const nominal = nominalDate(item, p);
    if (!nominal) continue;
    const date = shiftToWorkingDay(nominal, item.shift, holidays);
    if (date <= toIso) out.push({ period: p, nominal, date });
  }
  return out;
}

/** The next few dates from a given day — for the preview line in the editor and the manager list. */
export function upcomingDates(item, fromIso, count, holidays) {
  const out = [];
  if (item.endDate && item.endDate < fromIso) return out;
  let p = periodOf(item.startDate > fromIso ? item.startDate : fromIso);
  p = addMonths(p, -1);
  for (let guard = 0; out.length < count && guard < 600; guard++, p = addMonths(p, 1)) {
    const nominal = nominalDate(item, p);
    if (!nominal) {
      if (item.endDate && `${p}-01` > item.endDate) break;
      continue;
    }
    const date = shiftToWorkingDay(nominal, item.shift, holidays);
    if (date >= fromIso) out.push(date);
  }
  return out;
}

// ------------------------------------------------------------------ projections

/**
 * The projected (not yet confirmed) entries up to `toIso`, including any
 * whose date has passed without being confirmed ("overdue"), and skipped
 * ones (shown struck through; they don't count towards balances).
 *
 * @returns {Array<{ key: string, itemId: string, period: string, date: string, seriesDate: string,
 *   amount: number, description: string, kind: string, accountId: string, toAccountId: string|null,
 *   skipped: boolean, changed: boolean }>}
 */
export function projections(ledger, toIso, holidays) {
  const confirmed = new Set(
    ledger.transactions.filter((t) => t.scheduledItemId && t.scheduledPeriod).map((t) => `${t.scheduledItemId}|${t.scheduledPeriod}`)
  );
  const exceptions = new Map(occurrenceExceptions(ledger).map((e) => [e.id, e]));
  const out = [];
  for (const item of recurringItems(ledger)) {
    for (const { period, date } of seriesDates(item, toIso, holidays)) {
      if (confirmed.has(`${item.id}|${period}`)) continue;
      const ex = exceptions.get(exceptionId(item.id, period));
      const effectiveDate = ex?.date ?? date;
      if (effectiveDate > toIso) continue; // a one-off moved beyond the horizon
      out.push({
        key: `${item.id}:${period}`,
        itemId: item.id,
        period,
        date: effectiveDate,
        seriesDate: date,
        amount: ex?.amount ?? item.amount,
        description: ex?.description ?? item.description,
        kind: item.kind,
        accountId: item.accountId,
        toAccountId: item.kind === 'transfer' ? item.toAccountId : null,
        skipped: Boolean(ex?.skipped),
        changed: Boolean(ex && (ex.date !== null || ex.amount !== null || ex.description !== null)),
      });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** One projection as transaction-shaped legs (two for a transfer), marked isProjected. */
function projectionLegs(p) {
  const base = {
    category: null,
    kind: 'transaction',
    envelopeSplits: null,
    scheduledItemId: p.itemId,
    scheduledPeriod: p.period,
    isProjected: true,
    skipped: p.skipped,
    projection: p,
    date: p.date,
    amount: p.amount,
    description: p.description,
  };
  const id = `proj:${p.itemId}:${p.period}`;
  if (p.kind === 'transfer') {
    return [
      { ...base, id: `${id}:out`, accountId: p.accountId, direction: 'debit', transferId: id },
      { ...base, id: `${id}:in`, accountId: p.toAccountId, direction: 'credit', transferId: id },
    ];
  }
  return [{ ...base, id, accountId: p.accountId, direction: p.kind === 'in' ? 'credit' : 'debit', transferId: null }];
}

/**
 * A read-only "view" of the ledger with projected entries added after the
 * real ones — feed it to the same balance/grid code the real ledger uses.
 * Skipped entries carry `skipped: true` and add nothing to balances.
 * Never save this object.
 */
export function withProjections(ledger, toIso, holidays) {
  const accountIds = new Set(ledger.accounts.map((a) => a.id));
  const legs = projections(ledger, toIso, holidays)
    .flatMap(projectionLegs)
    .filter((t) => accountIds.has(t.accountId));
  return { ...ledger, transactions: [...ledger.transactions, ...legs] };
}

// ------------------------------------------------------------------ edits

function touch(ledger) {
  return { ...ledger, lastModified: new Date().toISOString() };
}
const isIso = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v ?? '');

function validateItem(f, ledger) {
  if (!f.description?.trim()) throw new Error('Give it a description');
  if (!['out', 'in', 'transfer'].includes(f.kind)) throw new Error('Choose money out, money in or transfer');
  if (!ledger.accounts.some((a) => a.id === f.accountId)) throw new Error('Choose an account');
  if (f.kind === 'transfer') {
    if (!ledger.accounts.some((a) => a.id === f.toAccountId)) throw new Error('Choose the account the money goes to');
    if (f.toAccountId === f.accountId) throw new Error('A transfer needs two different accounts');
  }
  if (!Number.isInteger(f.amount) || f.amount <= 0) throw new Error('Amount must be more than £0.00');
  if (!Number.isInteger(f.everyMonths) || f.everyMonths < 1 || f.everyMonths > 12) throw new Error('Repeat every 1 to 12 months');
  if (!Number.isInteger(f.day) || f.day < 1 || f.day > 31) throw new Error('Day of the month must be 1 to 31');
  if (!isIso(f.startDate)) throw new Error('A start date is required');
  if (f.endDate !== null && !isIso(f.endDate)) throw new Error('The end date isn’t a valid date');
  if (f.endDate && f.endDate < f.startDate) throw new Error('The end date is before the start date');
  if (!['none', 'before', 'after'].includes(f.shift)) throw new Error('Choose what happens on a weekend or bank holiday');
}

function cleanItemFields(f) {
  return {
    description: (f.description ?? '').trim(),
    kind: f.kind,
    accountId: f.accountId,
    toAccountId: f.kind === 'transfer' ? f.toAccountId : null,
    amount: f.amount,
    everyMonths: f.everyMonths,
    day: f.day,
    startDate: f.startDate,
    endDate: f.endDate || null,
    shift: f.shift ?? 'none',
  };
}

/** @returns {{ ledger: object, item: RecurringItem }} */
export function addRecurring(ledger, fields) {
  const clean = cleanItemFields(fields);
  validateItem(clean, ledger);
  const item = { id: randomUUID(), recordType: 'recurring', ...clean, createdAt: new Date().toISOString() };
  return { ledger: touch({ ...ledger, scheduledItems: [...(ledger.scheduledItems ?? []), item] }), item };
}

/** Edit the whole series: every occurrence not yet confirmed follows the new rule. */
export function updateRecurring(ledger, id, fields) {
  const existing = recurringItems(ledger).find((i) => i.id === id);
  if (!existing) throw new Error('Recurring item not found');
  const next = { ...existing, ...cleanItemFields({ ...existing, ...fields }) };
  validateItem(next, ledger);
  return touch({ ...ledger, scheduledItems: ledger.scheduledItems.map((r) => (r.id === id ? next : r)) });
}

/** Delete an item and its skips/one-offs. Entries already confirmed stay — they really happened. */
export function deleteRecurring(ledger, id) {
  return touch({
    ...ledger,
    scheduledItems: ledger.scheduledItems.filter((r) => r.id !== id && !(isOccurrence(r) && r.itemId === id)),
  });
}

/**
 * Skip, un-skip, or change one month's entry.
 * changes: { skipped?, date?, amount?, description? } — null for a field means "as the series".
 * An exception that ends up identical to the series is removed.
 */
export function setOccurrence(ledger, itemId, period, changes) {
  const item = recurringItems(ledger).find((i) => i.id === itemId);
  if (!item) throw new Error('Recurring item not found');
  const id = exceptionId(itemId, period);
  const current = occurrenceExceptions(ledger).find((e) => e.id === id) ?? {
    id, recordType: 'occurrence', itemId, period, skipped: false, date: null, amount: null, description: null,
  };
  const next = { ...current, ...changes };
  if (next.date !== null && !isIso(next.date)) throw new Error('A valid date is required');
  if (next.amount !== null && (!Number.isInteger(next.amount) || next.amount <= 0)) throw new Error('Amount must be more than £0.00');
  if (next.description !== null) next.description = next.description.trim() || null;
  const isPlain = !next.skipped && next.date === null && next.amount === null && next.description === null;
  const others = ledger.scheduledItems.filter((r) => r.id !== id);
  return touch({ ...ledger, scheduledItems: isPlain ? others : [...others, next] });
}

/**
 * Confirm one month's entry: it becomes a real transaction (two linked legs
 * for a transfer), dated and priced as actually paid. Deleting that
 * transaction later puts the projected entry back.
 */
export function confirmOccurrence(ledger, itemId, period, { date, amount, description }) {
  const item = recurringItems(ledger).find((i) => i.id === itemId);
  if (!item) throw new Error('Recurring item not found');
  if (!isIso(date)) throw new Error('A valid date is required');
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('Amount must be more than £0.00');
  const id = confirmedId(itemId, period);
  if (ledger.transactions.some((t) => t.id === id || t.id === `${id}:out`)) throw new Error('Already confirmed');
  const text = (description ?? item.description).trim();
  const common = {
    date, amount, description: text, kind: 'transaction', envelopeSplits: null,
    scheduledItemId: itemId, scheduledPeriod: period, isProjected: false,
  };
  if (item.kind === 'transfer') {
    const legs = [
      { ...common, id: `${id}:out`, accountId: item.accountId, direction: 'debit', category: 'Transfer', transferId: id },
      { ...common, id: `${id}:in`, accountId: item.toAccountId, direction: 'credit', category: 'Transfer', transferId: id },
    ];
    const transfer = { id, fromAccountId: item.accountId, toAccountId: item.toAccountId, amount, date, note: text };
    return touch({
      ...ledger,
      transactions: [...ledger.transactions, ...legs],
      transfers: [...ledger.transfers.filter((t) => t.id !== id), transfer],
    });
  }
  const tx = { ...common, id, accountId: item.accountId, direction: item.kind === 'in' ? 'credit' : 'debit', category: null, transferId: null };
  return touch({ ...ledger, transactions: [...ledger.transactions, tx] });
}

/** Plain-English rule, e.g. "Monthly on the 28th · working day before". */
export function describeRule(item) {
  const nth = (n) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;
  const month = new Date(Date.UTC(2000, Number(item.startDate.slice(5, 7)) - 1, 1)).toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' });
  const freq =
    item.everyMonths === 1 ? `Monthly on the ${nth(item.day)}`
      : item.everyMonths === 12 ? `Yearly on ${item.day} ${month}`
        : `Every ${item.everyMonths} months on the ${nth(item.day)}`;
  const shift = item.shift === 'before' ? ' · working day before' : item.shift === 'after' ? ' · next working day' : '';
  return freq + shift;
}
