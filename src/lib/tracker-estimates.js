/**
 * v0.11 — "Set aside on payday" figures published by the ticket tracker.
 *
 * The tracker writes ONE file to Google Drive, `transport-estimates.json`
 * (spec: claude/transport-estimates-spec.md, format version 1). Both apps use
 * the same Google client, so with the drive.file scope this app can find and
 * read it. Nothing here reads the tracker's own data or backups.
 *
 * A recurring item with `amountFrom: 'ticket-tracker'` takes, for each
 * projected month, the total of the period whose `paydayMonth` is that month
 * (schedule.js). No file, a bad file, or no figure for a month → the item's
 * own amount. The figures are kept on this device only (store record
 * 'trackerEstimates') — never in the ledger, never synced: each device reads
 * Drive itself, so a device that doesn't use the tracker never looks.
 *
 * Pure functions apart from refreshTrackerEstimates(), whose Drive calls are
 * injected (testable with the fake Drive).
 */

export const TRACKER_SOURCE = 'ticket-tracker';
export const TRACKER_FILE_NAME = 'transport-estimates.json';
export const TRACKER_FORMAT = 'transport-estimates';
export const TRACKER_FORMAT_VERSION = 1;
/** Don't look on Drive more often than this during ordinary syncs ("Check now" ignores it). */
export const TRACKER_CHECK_MS = 5 * 60 * 1000;
/**
 * v0.13: how this version reads the file. A cached copy read by an older
 * version (no `tickets` read) is downloaded again once, even though the file
 * itself hasn't changed.
 */
export const TRACKER_READER = 2;
const TICKET_ID_RE = /^[pf]-\d{4}-\d{2}-\d{2}$/;

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const isMonth = (v) => typeof v === 'string' && MONTH_RE.test(v);
function isRealDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
const nextDay = (iso) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};
const count = (v) => Number.isInteger(v) && v >= 0;

/**
 * Check a published file. Never throws.
 * @param {string} text
 * @returns {{ ok: true, estimates: { version: number, generatedAt: string, appVersion: string|null,
 *   assumptions: object|null, periods: object[] } } | { ok: false, error: string }}
 */
export function parseTrackerEstimates(text) {
  let data;
  try { data = JSON.parse(text); } catch { return { ok: false, error: 'The ticket tracker’s file isn’t valid JSON.' }; }
  if (data?.format !== TRACKER_FORMAT) return { ok: false, error: 'The file doesn’t look like the ticket tracker’s estimates.' };
  if (!Number.isInteger(data.version) || data.version < 1) return { ok: false, error: 'The ticket tracker’s file has no valid format version.' };
  if (data.version > TRACKER_FORMAT_VERSION) {
    return { ok: false, error: `The ticket tracker’s file is format version ${data.version}; this app reads version ${TRACKER_FORMAT_VERSION}. Update Personal Finance.` };
  }
  if (typeof data.generatedAt !== 'string' || Number.isNaN(Date.parse(data.generatedAt))) {
    return { ok: false, error: 'The ticket tracker’s file has no valid “generatedAt” time.' };
  }
  if (!Array.isArray(data.periods) || data.periods.length === 0) return { ok: false, error: 'The ticket tracker’s file has no periods.' };
  if (data.periods.length > 60) return { ok: false, error: 'The ticket tracker’s file has too many periods.' };

  const periods = [];
  for (const [i, p] of data.periods.entries()) {
    const where = `period ${i + 1}${isMonth(p?.paydayMonth) ? ` (${p.paydayMonth})` : ''}`;
    const bad = (why) => ({ ok: false, error: `The ticket tracker’s file is damaged: ${where} ${why}.` });
    if (!p || typeof p !== 'object') return bad('isn’t an object');
    if (!isMonth(p.paydayMonth)) return bad('has no valid paydayMonth');
    if (!isRealDate(p.start) || !isRealDate(p.end)) return bad('has an invalid start or end date');
    if (p.end < p.start) return bad('ends before it starts');
    if (p.start.slice(0, 7) !== p.paydayMonth) return bad('has a paydayMonth that isn’t its start date’s month');
    if (p.status !== 'locked' && p.status !== 'projected') return bad('has a status other than locked or projected');
    if (!count(p.ticketCount) || !count(p.parkingDays)) return bad('has a count that isn’t a whole number');
    if (!count(p.ticketPence) || !count(p.parkingPence) || !count(p.totalPence)) return bad('has an amount that isn’t whole pence');
    if (p.totalPence !== p.ticketPence + p.parkingPence) return bad('has a total that isn’t tickets + parking');
    const prev = periods[periods.length - 1];
    if (prev && p.start !== nextDay(prev.end)) return bad('doesn’t start the day after the previous period ends');
    periods.push({
      paydayMonth: p.paydayMonth, start: p.start, end: p.end, status: p.status,
      ticketCount: p.ticketCount, ticketPence: p.ticketPence,
      parkingDays: p.parkingDays, parkingPence: p.parkingPence, totalPence: p.totalPence,
    });
  }
  const tickets = parseTickets(data.tickets);
  const a = data.assumptions;
  return {
    ok: true,
    estimates: {
      version: data.version,
      generatedAt: data.generatedAt,
      appVersion: typeof data.source?.appVersion === 'string' ? data.source.appVersion : null,
      assumptions: a && typeof a === 'object'
        ? { ticketPricePence: count(a.ticketPricePence) ? a.ticketPricePence : null, parkingDayPence: count(a.parkingDayPence) ? a.parkingDayPence : null }
        : null,
      periods,
      // v0.13: null = no list in the file (older tracker); a bad list is ignored on its own (periods still used)
      tickets: tickets.ok ? tickets.tickets : null,
      ticketsError: tickets.ok ? null : tickets.error,
    },
  };
}

/**
 * v0.13 — the `tickets` list (ticket-purchases-spec.md). Checked separately:
 * a bad list never throws away good periods. Absent → { ok: true, tickets: null }.
 */
function parseTickets(list) {
  if (list === undefined || list === null) return { ok: true, tickets: null };
  if (!Array.isArray(list)) return { ok: false, error: 'The ticket tracker’s ticket list isn’t a list — ticket purchases not shown.' };
  const out = [];
  const seen = new Set();
  for (const [i, t] of list.entries()) {
    const bad = (why) => ({ ok: false, error: `The ticket tracker’s ticket ${i + 1}${typeof t?.id === 'string' ? ` (${t.id})` : ''} ${why} — ticket purchases not shown.` });
    if (!t || typeof t !== 'object') return bad('isn’t an object');
    if (t.status !== 'bought' && t.status !== 'projected') return bad('has a status other than bought or projected');
    if (typeof t.id !== 'string' || !TICKET_ID_RE.test(t.id) || t.id[0] !== (t.status === 'bought' ? 'p' : 'f')) return bad('has an id that isn’t p-/f- and a date');
    if (seen.has(t.id)) return bad('appears twice');
    seen.add(t.id);
    if (!isRealDate(t.validFrom) || !isRealDate(t.validTo) || !isRealDate(t.purchaseDate)) return bad('has an invalid date');
    if (t.validTo < t.validFrom) return bad('ends before it starts');
    if (!count(t.pricePence) || t.pricePence === 0) return bad('has a price that isn’t whole pence');
    out.push({ id: t.id, validFrom: t.validFrom, validTo: t.validTo, purchaseDate: t.purchaseDate, pricePence: t.pricePence, status: t.status });
  }
  out.sort((x, y) => x.purchaseDate.localeCompare(y.purchaseDate) || x.id.localeCompare(y.id));
  return { ok: true, tickets: out };
}

/** The tracker's period for a payment month ('YYYY-MM'), or null. */
export function trackerPeriodFor(estimates, month) {
  return estimates?.periods?.find((p) => p.paydayMonth === month) ?? null;
}

/** Does any recurring item take its amount from the tracker? (Nothing is fetched otherwise.) */
export function usesTracker(ledger) {
  return (ledger?.scheduledItems ?? []).some((r) => (r?.recordType === 'recurring' && r.amountFrom === TRACKER_SOURCE && !r.payStatement)
    || (r?.recordType === 'ticketPurchases' && r.enabled)); // v0.13 ticket purchases (tickets.js)
}

/**
 * Look for the published file and read it if it changed since last time.
 * Returns the new cache record for the store:
 *   { fileId, version, checkedAt, estimates (last good copy, or null), error (null | message) }
 * A missing or bad file keeps the last good figures (with the error shown).
 * Drive errors with .auth propagate; any other Drive error is recorded.
 *
 * drive: { findFilesByName(token, name) -> [{ id, version }] oldest first, download(token, id) -> text }
 */
export async function refreshTrackerEstimates({ drive, token, cached, now = () => new Date() }) {
  const checkedAt = now().toISOString();
  const keep = cached?.estimates ?? null;
  let files;
  try {
    files = await drive.findFilesByName(token, TRACKER_FILE_NAME);
  } catch (err) {
    if (err?.auth) throw err;
    return { ...(cached ?? {}), estimates: keep, checkedAt, error: `Couldn’t look for the ticket tracker’s file (${err?.message ?? err}).` };
  }
  const f = files?.[0];
  if (!f) {
    return { fileId: null, version: null, checkedAt, estimates: keep, error: 'The ticket tracker hasn’t shared its figures yet (no transport-estimates.json in Drive).' };
  }
  if (cached && cached.fileId === f.id && cached.version === f.version && (cached.estimates || cached.error) && cached.reader === TRACKER_READER) {
    return { ...cached, checkedAt }; // unchanged since last read
  }
  let text;
  try {
    text = await drive.download(token, f.id);
  } catch (err) {
    if (err?.auth) throw err;
    return { ...(cached ?? {}), estimates: keep, checkedAt, error: `Couldn’t read the ticket tracker’s file (${err?.message ?? err}).` };
  }
  const parsed = parseTrackerEstimates(text);
  return parsed.ok
    ? { fileId: f.id, version: f.version, reader: TRACKER_READER, checkedAt, estimates: parsed.estimates, error: null }
    : { fileId: f.id, version: f.version, reader: TRACKER_READER, checkedAt, estimates: keep, error: parsed.error };
}
