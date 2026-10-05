/**
 * Working days for England & Wales: weekends and bank holidays.
 *
 * The bank-holiday list comes from gov.uk (https://www.gov.uk/bank-holidays.json,
 * "england-and-wales") — fetched by the app and kept on the device. The list
 * below is a built-in fallback so the very first run, or a phone that has
 * never been online with the app open, still gets the dates right.
 *
 * All dates are ISO "YYYY-MM-DD" strings; maths is done in UTC so the
 * clocks changing can never shift a day.
 */

/** England & Wales bank holidays, as published by gov.uk. */
export const BUILT_IN_BANK_HOLIDAYS = Object.freeze([
  // 2025
  '2025-01-01', '2025-04-18', '2025-04-21', '2025-05-05', '2025-05-26', '2025-08-25', '2025-12-25', '2025-12-26',
  // 2026 (Boxing Day falls on a Saturday -> substitute Monday 28 Dec)
  '2026-01-01', '2026-04-03', '2026-04-06', '2026-05-04', '2026-05-25', '2026-08-31', '2026-12-25', '2026-12-28',
  // 2027 (Christmas Sat / Boxing Day Sun -> substitutes Mon 27 / Tue 28 Dec)
  '2027-01-01', '2027-03-26', '2027-03-29', '2027-05-03', '2027-05-31', '2027-08-30', '2027-12-27', '2027-12-28',
]);

export const BANK_HOLIDAYS_URL = 'https://www.gov.uk/bank-holidays.json';

/**
 * Pull the England & Wales dates out of gov.uk's JSON. Throws on anything
 * unexpected so a bad response never replaces a good list.
 * @returns {string[]} sorted ISO dates
 */
export function parseGovUkBankHolidays(json) {
  const events = json?.['england-and-wales']?.events;
  if (!Array.isArray(events) || events.length === 0) throw new Error('Unexpected bank holiday data');
  const dates = events.map((e) => e?.date).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d ?? ''));
  if (dates.length === 0) throw new Error('Unexpected bank holiday data');
  return [...new Set(dates)].sort();
}

/**
 * The list to use: the fetched one, plus any built-in dates outside the
 * fetched list's range (gov.uk drops old years, and may not reach as far
 * ahead as the built-in list on a stale copy).
 */
export function combineHolidayLists(fetched = []) {
  if (!fetched.length) return [...BUILT_IN_BANK_HOLIDAYS];
  const first = fetched[0].slice(0, 4);
  const last = fetched[fetched.length - 1].slice(0, 4);
  const extra = BUILT_IN_BANK_HOLIDAYS.filter((d) => d.slice(0, 4) < first || d.slice(0, 4) > last);
  return [...new Set([...fetched, ...extra])].sort();
}

/** Last year covered by a holiday list (beyond it, only weekends are known). */
export function lastKnownYear(list) {
  return list.length ? Number(list[list.length - 1].slice(0, 4)) : 0;
}

// ------------------------------------------------------------------ date maths

export function toUtc(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
export function fromUtc(date) {
  return date.toISOString().slice(0, 10);
}
export function addDays(iso, n) {
  const d = toUtc(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return fromUtc(d);
}
export function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate(); // month is 1-12
}

/**
 * @param {string} iso
 * @param {Set<string>} holidays
 */
export function isWorkingDay(iso, holidays) {
  const dow = toUtc(iso).getUTCDay();
  return dow !== 0 && dow !== 6 && !holidays.has(iso);
}

/**
 * Move a date off a weekend/bank holiday.
 * @param {string} iso
 * @param {'none'|'before'|'after'} rule
 * @param {Set<string>} holidays
 */
export function shiftToWorkingDay(iso, rule, holidays) {
  if (rule !== 'before' && rule !== 'after') return iso;
  const step = rule === 'before' ? -1 : 1;
  let d = iso;
  for (let i = 0; i < 14 && !isWorkingDay(d, holidays); i++) d = addDays(d, step);
  return d;
}

/**
 * The nth working day of a month (e.g. Barclaycard's statement is the 13th).
 * @param {number} year
 * @param {number} month 1-12
 */
export function nthWorkingDay(year, month, n, holidays) {
  let count = 0;
  const last = daysInMonth(year, month);
  for (let day = 1; day <= last; day++) {
    const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (isWorkingDay(iso, holidays) && ++count === n) return iso;
  }
  return null;
}
