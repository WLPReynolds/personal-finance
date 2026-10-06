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
 * frequency offered (monthly, every N months, yearly, every N days with
 * N >= 31) is at most once a month, and keying by month means changing an
 * item's day doesn't orphan months already confirmed or skipped. That is why
 * "every N days" has a minimum of 31 — weekly/fortnightly would need
 * occurrences keyed by date instead (not built).
 */
import { randomUUID } from './id.js';
import { daysInMonth, shiftToWorkingDay } from './workdays.js';
import { statementConfig, paymentDueDate, statementFor, addMonths as addStatementMonths } from './statements.js';
import { TRACKER_SOURCE, trackerPeriodFor } from './tracker-estimates.js';
import { envelopeConfig, validateSplits, fitSplits } from './envelopes.js';

export const MAX_HORIZON_MONTHS = 12;
/** "Every N days" bounds. 31 is the smallest gap that can never land twice in one month (see above). */
export const MIN_EVERY_DAYS = 31;
export const MAX_EVERY_DAYS = 366;

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
 * @property {number|null} [everyDays]  - v0.7.1: every N days (MIN_EVERY_DAYS–MAX_EVERY_DAYS) counted from the start date,
 *                                         which is the first payment. When set, everyMonths/day are ignored here — they hold
 *                                         an approximation (N/30 months, start date's day) so an older device shows something close.
 * @property {number} day                - 1-31; a shorter month uses its last day
 * @property {string} startDate          - ISO; nothing before this
 * @property {string|null} endDate       - ISO; last entry on or before this. null = indefinitely
 * @property {'none'|'before'|'after'} shift - weekend/bank holiday: don't move / working day before / next working day
 * @property {number|null} [finalAmount] - pence; the last payment's amount if it differs (needs an end date). null/absent = same as the rest
 * @property {number} [firstNumber]      - fixed-end series only: the number of this series' first payment, for "(x of y)". Default 1;
 *                                         e.g. 2 when payment 1 was made before the series was set up
 * @property {boolean} [payStatement]   - v0.7, transfer to a credit card only: pay the card's statement balance on its
 *                                         payment due date (statements.js). day/shift/everyMonths are then ignored, and
 *                                         `amount` is only an estimate for a statement from before the card's records start.
 *                                         The payment for month P pays the statement produced the month before.
 * @property {'ticket-tracker'|null} [amountFrom] - v0.11: take each projected month's amount from the ticket tracker's
 *                                         published figure for the period paid that month (tracker-estimates.js); `amount`
 *                                         is then the fallback. Not with payStatement. Absent/null = off.
 * @property {{envelopeId: string, amount: number}[]|null} [envelopeSplits] - v0.12: envelopes for the leg on the envelope
 *                                         account (envelopeLegAccountId). One envelope follows whatever the month's amount
 *                                         is; a split must add up to `amount`, and a month with a different amount is
 *                                         left Unallocated. Absent/null = Unallocated.
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

/**
 * v0.12: which of an item's accounts its envelopes are for — the account the
 * money goes TO for a transfer if that one uses envelopes, else the item's
 * own account; null when neither does.
 */
export function envelopeLegAccountId(item, accounts) {
  const uses = (id) => Boolean(envelopeConfig(accounts.find((a) => a.id === id)));
  if (item.kind === 'transfer' && item.toAccountId && uses(item.toAccountId)) return item.toAccountId;
  return uses(item.accountId) ? item.accountId : null;
}

/** The envelope splits one month's entry of an item gets, for the leg on `accountId`. */
function legSplits(item, accountId, amount, accounts) {
  if (!item?.envelopeSplits || envelopeLegAccountId(item, accounts) !== accountId) return null;
  return fitSplits(item.envelopeSplits, amount);
}
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

/** The card a statement-payment item pays, if it's set up for statements — else null (the item then behaves as a plain monthly one). */
export function statementCardFor(item, accounts) {
  if (!item.payStatement || item.kind !== 'transfer') return null;
  const card = accounts?.find((a) => a.id === item.toAccountId);
  return statementConfig(card) ? card : null;
}

/**
 * The date an item falls due in a month (after the weekend rule), or null.
 * For a statement payment: the due date of the previous month's statement.
 */
function occurrenceDate(item, period, holidays, card) {
  if (card) {
    if (monthsBetween(periodOf(item.startDate), period) < 0) return null;
    const date = paymentDueDate(card, addMonths(period, -1), holidays);
    if (!date || date < item.startDate) return null;
    if (item.endDate && date > item.endDate) return null;
    return { nominal: date, date };
  }
  const nominal = nominalDate(item, period);
  return nominal ? { nominal, date: shiftToWorkingDay(nominal, item.shift, holidays) } : null;
}

const DAY_MS = 86400000;
const dayNo = (iso) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / DAY_MS;
const isoOfDay = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);

/** Every-N-days: the one series date in a month (N >= 31, so never two), or null. */
function nominalDateByDays(item, period) {
  const { y, m } = periodParts(period);
  const first = dayNo(`${period}-01`);
  const last = dayNo(`${period}-${pad(daysInMonth(y, m))}`);
  const start = dayNo(item.startDate);
  if (last < start) return null;
  const k = Math.ceil((Math.max(first, start) - start) / item.everyDays);
  const n = start + k * item.everyDays;
  if (n > last) return null;
  const iso = isoOfDay(n);
  if (item.endDate && iso > item.endDate) return null;
  return iso;
}

/** The series' own date in a month (before any weekend shift), or null if not due that month. */
export function nominalDate(item, period) {
  if (item.everyDays) return nominalDateByDays(item, period);
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
export function seriesDates(item, toIso, holidays, card = null) {
  const out = [];
  const last = addMonths(periodOf(toIso), 1); // a 'before' shift can pull next month's 1st back into range
  for (let p = periodOf(item.startDate); monthsBetween(p, last) >= 0; p = addMonths(p, 1)) {
    const o = occurrenceDate(item, p, holidays, card);
    if (o && o.date <= toIso) out.push({ period: p, ...o });
  }
  return out;
}

/** The next few dates from a given day — for the preview line in the editor and the manager list. */
export function upcomingDates(item, fromIso, count, holidays, card = null) {
  const out = [];
  if (item.endDate && item.endDate < fromIso) return out;
  let p = periodOf(item.startDate > fromIso ? item.startDate : fromIso);
  p = addMonths(p, -1);
  for (let guard = 0; out.length < count && guard < 600; guard++, p = addMonths(p, 1)) {
    const o = occurrenceDate(item, p, holidays, card);
    if (!o) {
      if (item.endDate && `${p}-01` > item.endDate) break;
      continue;
    }
    if (o.date >= fromIso) out.push(o.date);
  }
  return out;
}

// ------------------------------------------------------------------ numbering & final payment

/** Every period the series falls due in, start to end. Only for a series with an end date. */
function allPeriods(item) {
  if (!item.endDate || item.payStatement) return []; // statement payments aren't numbered
  const out = [];
  const last = periodOf(item.endDate);
  for (let p = periodOf(item.startDate); monthsBetween(p, last) >= 0; p = addMonths(p, 1)) {
    if (nominalDate(item, p)) out.push(p);
  }
  return out;
}

/**
 * Payment numbers for a series with an end date: Map period -> { n, of }.
 * A skipped month (not confirmed) takes no number and the rest close up, so
 * the total is the payments actually due: skip one of 12 and the last is
 * "11 of 11". Numbering starts at the item's firstNumber (default 1).
 * The final payment — the one finalAmount applies to — is the last numbered one.
 * @param {Set<string>} skippedPeriods - periods skipped and not confirmed
 */
export function seriesNumbering(item, skippedPeriods = new Set()) {
  const map = new Map();
  const due = allPeriods(item).filter((p) => !skippedPeriods.has(p));
  const first = item.firstNumber ?? 1;
  const of = first + due.length - 1;
  due.forEach((p, i) => map.set(p, { n: first + i, of }));
  return map;
}

function skippedPeriodsFor(ledger, itemId, confirmed) {
  return new Set(occurrenceExceptions(ledger)
    .filter((e) => e.itemId === itemId && e.skipped && !confirmed.has(`${itemId}|${e.period}`))
    .map((e) => e.period));
}
function confirmedKeys(ledger) {
  return new Set(
    ledger.transactions.filter((t) => t.scheduledItemId && t.scheduledPeriod).map((t) => `${t.scheduledItemId}|${t.scheduledPeriod}`)
  );
}

/** The period of the final payment (last one not skipped), or null when there's no end date or nothing due. */
function finalPeriodOf(numbering) {
  let last = null;
  for (const p of numbering.keys()) last = p;
  return last;
}

/** Numbering for one item in a ledger (skips taken into account). */
export function itemNumbering(ledger, item) {
  return seriesNumbering(item, skippedPeriodsFor(ledger, item.id, confirmedKeys(ledger)));
}

/** The series' own amount for a month: finalAmount on the final payment, otherwise the usual amount. */
export function seriesAmount(item, period, numbering) {
  if (item.finalAmount == null || !item.endDate || item.payStatement) return item.amount;
  return finalPeriodOf(numbering) === period ? item.finalAmount : item.amount;
}

/** "(3 of 12)" — or '' when the entry isn't part of a numbered series. */
export const numberLabel = (no) => (no ? `(${no.n} of ${no.of})` : '');

// ------------------------------------------------------------------ projections

/**
 * The projected (not yet confirmed) entries up to `toIso`, including any
 * whose date has passed without being confirmed ("overdue"), and skipped
 * ones (shown struck through; they don't count towards balances).
 *
 * sources (v0.11, optional): { tracker } — the ticket tracker's published
 * figures (tracker-estimates.js), for items with amountFrom 'ticket-tracker'.
 * Such a projection carries amountSource 'tracker' (+ tracker: the period) or
 * 'fallback' (no figure for that month — the item's own amount).
 *
 * @returns {Array<{ key: string, itemId: string, period: string, date: string, seriesDate: string,
 *   amount: number, description: string, kind: string, accountId: string, toAccountId: string|null,
 *   skipped: boolean, changed: boolean, seriesAmount: number, number: {n:number, of:number}|null }>}
 */
export function projections(ledger, toIso, holidays, sources = {}) {
  const confirmed = confirmedKeys(ledger);
  const exceptions = new Map(occurrenceExceptions(ledger).map((e) => [e.id, e]));
  const out = [];
  const projectionFor = (item, period, date, amount, numbering, extra = {}) => {
    const ex = exceptions.get(exceptionId(item.id, period));
    const effectiveDate = ex?.date ?? date;
    if (effectiveDate > toIso) return null; // a one-off moved beyond the horizon
    return {
      key: `${item.id}:${period}`,
      itemId: item.id,
      period,
      date: effectiveDate,
      seriesDate: date,
      amount: ex?.amount ?? amount,
      seriesAmount: amount,
      number: numbering?.get(period) ?? null, // { n, of } for a fixed-end series; null if skipped / open-ended
      description: ex?.description ?? item.description,
      kind: item.kind,
      accountId: item.accountId,
      toAccountId: item.kind === 'transfer' ? item.toAccountId : null,
      skipped: Boolean(ex?.skipped),
      changed: Boolean(ex && (ex.date !== null || ex.amount !== null || ex.description !== null)),
      ...extra,
    };
  };

  // 1. ordinary items
  const statementItems = [];
  for (const item of recurringItems(ledger)) {
    const card = statementCardFor(item, ledger.accounts);
    if (card) { statementItems.push({ item, card }); continue; }
    const numbering = seriesNumbering(item, skippedPeriodsFor(ledger, item.id, confirmed));
    const fromTracker = item.amountFrom === TRACKER_SOURCE;
    for (const { period, date } of seriesDates(item, toIso, holidays)) {
      if (confirmed.has(`${item.id}|${period}`)) continue;
      let amount = seriesAmount(item, period, numbering);
      let extra = {};
      if (fromTracker) {
        const tp = trackerPeriodFor(sources.tracker, period);
        if (tp) {
          amount = tp.totalPence;
          extra = { amountSource: 'tracker', tracker: { ...tp, generatedAt: sources.tracker.generatedAt } };
        } else {
          extra = { amountSource: 'fallback' };
        }
      }
      const p = projectionFor(item, period, date, amount, numbering, extra);
      if (!p) continue;
      if (fromTracker && p.amount <= 0 && !p.skipped) continue; // the tracker says nothing to set aside
      out.push(p);
    }
  }

  // 2. statement payments, oldest first: each statement's balance counts
  // everything projected before it, including earlier statement payments
  // (and anything paid less, or skipped, carries on to the next statement)
  if (statementItems.length) {
    const projected = [...out];
    const balanceLedger = () => ({ ...ledger, transactions: [...ledger.transactions, ...projected.flatMap(projectionLegs)] });
    const pending = statementItems.flatMap(({ item, card }) =>
      seriesDates(item, toIso, holidays, card).map((o) => ({ item, card, ...o })));
    pending.sort((a, b) => a.date.localeCompare(b.date));
    for (const { item, card, period, date } of pending) {
      if (confirmed.has(`${item.id}|${period}`)) continue;
      const st = statementFor(balanceLedger(), card, addStatementMonths(period, -1), holidays);
      const amount = st.beforeRecords ? item.amount : Math.max(0, st.owed);
      const p = projectionFor(item, period, date, amount, null, { statement: st });
      if (!p) continue;
      if (p.amount <= 0 && !p.skipped) continue; // nothing owed: no payment
      out.push(p);
      projected.push(p);
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
    seriesNo: p.number,
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
/**
 * v0.9: has a fixed-end series been paid off? True when the item has an end
 * date and no payment is left that is neither confirmed nor skipped (overdue
 * unconfirmed ones count as still to pay). Open-ended items never finish.
 * Looks 62 days past the end date so a last payment moved a little later by a
 * one-off date still counts as outstanding.
 */
export function seriesFinished(ledger, item, holidays, sources = {}) {
  if (!item?.endDate) return false;
  const d = new Date(`${item.endDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 62);
  const to = d.toISOString().slice(0, 10);
  return !projections(ledger, to, holidays, sources).some((p) => p.itemId === item.id && !p.skipped);
}

export function withProjections(ledger, toIso, holidays, sources = {}) {
  const accountIds = new Set(ledger.accounts.map((a) => a.id));
  const items = new Map(recurringItems(ledger).map((i) => [i.id, i]));
  const legs = projections(ledger, toIso, holidays, sources)
    .flatMap(projectionLegs)
    .filter((t) => accountIds.has(t.accountId))
    .map((t) => {
      const splits = legSplits(items.get(t.scheduledItemId), t.accountId, t.amount, ledger.accounts);
      return splits ? { ...t, envelopeSplits: splits } : t;
    });
  // confirmed entries of a numbered series get their "(x of y)" too — worked
  // out live, so it follows any later change to the series or a skip
  const numberings = new Map(recurringItems(ledger).filter((i) => i.endDate).map((i) => [i.id, itemNumbering(ledger, i)]));
  const real = ledger.transactions.map((t) => {
    const no = t.scheduledItemId ? numberings.get(t.scheduledItemId)?.get(t.scheduledPeriod) : null;
    return no ? { ...t, seriesNo: no } : t;
  });
  return { ...ledger, transactions: [...real, ...legs] };
}

// ------------------------------------------------------------------ edits

function touch(ledger) {
  return { ...ledger, lastModified: new Date().toISOString() };
}
const isIso = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v ?? '');

function validateItem(f, ledger) {
  if (!f.description?.trim()) throw new Error('Give it a description');
  if (f.payStatement) {
    if (f.kind !== 'transfer') throw new Error('Only a transfer to a credit card can pay its statement');
    const card = ledger.accounts.find((a) => a.id === f.toAccountId);
    if (!statementConfig(card)) throw new Error('Set the card’s statement date first (Account…)');
    if (!Number.isInteger(f.amount) || f.amount < 0) throw new Error('Estimate must be £0.00 or more');
  }
  if (!['out', 'in', 'transfer'].includes(f.kind)) throw new Error('Choose money out, money in or transfer');
  if (!ledger.accounts.some((a) => a.id === f.accountId)) throw new Error('Choose an account');
  if (f.kind === 'transfer') {
    if (!ledger.accounts.some((a) => a.id === f.toAccountId)) throw new Error('Choose the account the money goes to');
    if (f.toAccountId === f.accountId) throw new Error('A transfer needs two different accounts');
  }
  if (!f.payStatement && (!Number.isInteger(f.amount) || f.amount <= 0)) throw new Error('Amount must be more than £0.00');
  if (f.everyDays !== null && (!Number.isInteger(f.everyDays) || f.everyDays < MIN_EVERY_DAYS || f.everyDays > MAX_EVERY_DAYS)) {
    throw new Error(`Repeat every ${MIN_EVERY_DAYS} to ${MAX_EVERY_DAYS} days`);
  }
  if (!Number.isInteger(f.everyMonths) || f.everyMonths < 1 || f.everyMonths > 12) throw new Error('Repeat every 1 to 12 months');
  if (!Number.isInteger(f.day) || f.day < 1 || f.day > 31) throw new Error('Day of the month must be 1 to 31');
  if (!isIso(f.startDate)) throw new Error('A start date is required');
  if (f.endDate !== null && !isIso(f.endDate)) throw new Error('The end date isn’t a valid date');
  if (f.endDate && f.endDate < f.startDate) throw new Error('The end date is before the start date');
  if (!['none', 'before', 'after'].includes(f.shift)) throw new Error('Choose what happens on a weekend or bank holiday');
  if (f.finalAmount !== null) {
    if (!f.endDate) throw new Error('A different last payment needs an end date');
    if (!Number.isInteger(f.finalAmount) || f.finalAmount <= 0) throw new Error('Last payment must be more than £0.00');
  }
  if (!Number.isInteger(f.firstNumber) || f.firstNumber < 1 || f.firstNumber > 999) throw new Error('First payment number must be 1 to 999');
  if (f.envelopeSplits) {
    const legId = envelopeLegAccountId(f, ledger.accounts);
    if (!legId) throw new Error('Neither account uses envelopes');
    const account = ledger.accounts.find((a) => a.id === legId);
    if (f.envelopeSplits.length > 1 && (f.payStatement || f.amountFrom === TRACKER_SOURCE)) {
      throw new Error('An amount that changes every month can only go into one envelope');
    }
    // one envelope takes any amount; a split must add up to the usual amount
    const check = f.envelopeSplits.length === 1 ? f.envelopeSplits.map((x) => ({ ...x, amount: f.amount || 1 })) : f.envelopeSplits;
    validateSplits(account, f.envelopeSplits.length === 1 ? f.amount || 1 : f.amount, check);
  }
}

function cleanItemFields(f) {
  const payStatement = Boolean(f.kind === 'transfer' && f.payStatement);
  const everyDays = payStatement || f.everyDays == null || f.everyDays === '' ? null : f.everyDays;
  // every N days: keep an approximate months/day rule alongside, for devices older than v0.7.1
  const byDays = everyDays !== null && Number.isInteger(everyDays) && isIso(f.startDate);
  return {
    description: (f.description ?? '').trim(),
    kind: f.kind,
    accountId: f.accountId,
    toAccountId: f.kind === 'transfer' ? f.toAccountId : null,
    amount: f.amount,
    everyMonths: byDays ? Math.min(12, Math.max(1, Math.round(everyDays / 30.4375))) : f.everyMonths,
    everyDays,
    day: byDays ? Number(f.startDate.slice(8, 10)) : f.day,
    startDate: f.startDate,
    endDate: f.endDate || null,
    shift: f.shift ?? 'none',
    finalAmount: f.payStatement ? null : f.finalAmount ?? null,
    firstNumber: f.firstNumber ?? 1,
    payStatement,
    amountFrom: !payStatement && f.amountFrom === TRACKER_SOURCE ? TRACKER_SOURCE : null,
    envelopeSplits: !Array.isArray(f.envelopeSplits) || !f.envelopeSplits.length ? null
      : f.envelopeSplits.length === 1 ? [{ envelopeId: f.envelopeSplits[0].envelopeId, amount: f.amount }]
        : f.envelopeSplits.map((x) => ({ envelopeId: x.envelopeId, amount: x.amount })),
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
    ].map((t) => ({ ...t, envelopeSplits: legSplits(item, t.accountId, amount, ledger.accounts) }));
    const transfer = { id, fromAccountId: item.accountId, toAccountId: item.toAccountId, amount, date, note: text };
    return touch({
      ...ledger,
      transactions: [...ledger.transactions, ...legs],
      transfers: [...ledger.transfers.filter((t) => t.id !== id), transfer],
    });
  }
  const tx = { ...common, id, accountId: item.accountId, direction: item.kind === 'in' ? 'credit' : 'debit', category: null, transferId: null,
    envelopeSplits: legSplits(item, item.accountId, amount, ledger.accounts) };
  return touch({ ...ledger, transactions: [...ledger.transactions, tx] });
}

/** Plain-English rule, e.g. "Monthly on the 28th · working day before". */
export function describeRule(item, card = null) {
  if (item.payStatement) {
    const days = card?.creditCard?.paymentDaysAfter ?? 25;
    return `Statement balance · ${days} days after the statement · next working day`;
  }
  const nth = (n) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;
  const month = new Date(Date.UTC(2000, Number(item.startDate.slice(5, 7)) - 1, 1)).toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' });
  if (item.everyDays) {
    const from = new Date(`${item.startDate}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
    const shift = item.shift === 'before' ? ' · working day before' : item.shift === 'after' ? ' · next working day' : '';
    return `Every ${item.everyDays} days from ${from}${shift}`;
  }
  const freq =
    item.everyMonths === 1 ? `Monthly on the ${nth(item.day)}`
      : item.everyMonths === 12 ? `Yearly on ${item.day} ${month}`
        : `Every ${item.everyMonths} months on the ${nth(item.day)}`;
  const shift = item.shift === 'before' ? ' · working day before' : item.shift === 'after' ? ' · next working day' : '';
  return freq + shift;
}
