/**
 * v0.15.25 — parking payments shared with the ticket tracker.
 *
 * Spec: Project doc `claude/parking-transactions-spec.md` (written in the
 * tracker's Project, 27 Nov 2026). Wayne records each parking payment once,
 * here, where the card is chosen, and ticks "Parking". The ticket tracker reads
 * the list from ONE Drive file, `parking-transactions.json`, and marks the
 * parked days itself.
 *
 * Who makes the file: **the ticket tracker, never this app.** Both apps use the
 * same Google client with the drive.file scope, so this app can find and update
 * a file the tracker created — but if this app created it, the tracker would
 * still see it only by the same rule, and two apps creating it could leave two
 * files. So: no file → say "turn it on in Ticket Tracker first" and do nothing.
 *
 * What goes in: every stored entry in YOUR file (never the joint file) with
 * `parking: true` that is a plain payment out (direction debit, kind
 * transaction, amount > 0, not a transfer leg). The list is the full current
 * set, not a log: an edit keeps the entry's id, a deletion or an untick just
 * drops it. The tracker ignores anything dated before it switched the feature
 * on, so old entries are harmless.
 *
 * Settings: one `scheduledItems` record (recordType 'parkingSharing'), so it
 * syncs between Wayne's devices like the ticket purchases settings. Alison's
 * file never has it, so her app never looks. What this device last saw of the
 * Drive file is kept locally only (store record 'parkingShare').
 *
 * Pure apart from publishParking(), whose Drive calls are injected.
 */

export const PARKING_FILE_NAME = 'parking-transactions.json';
export const PARKING_FORMAT = 'parking-transactions';
export const PARKING_FORMAT_VERSION = 1;
export const PARKING_SETTINGS_ID = 'parking-sharing';
export const PARKING_RECORD_TYPE = 'parkingSharing';
export const NO_FILE_MESSAGE = 'Turn on parking sharing in Ticket Tracker first (Backup & restore → “Read parking from Personal Finance”).';

// ------------------------------------------------------------------ settings

/** The stored settings record (on or off), or null. */
export function parkingSettingsRecord(ledger) {
  return (ledger?.scheduledItems ?? []).find((r) => r?.recordType === PARKING_RECORD_TYPE) ?? null;
}

/** Is sharing switched on? (The Parking tick on the entry form shows only then.) */
export function parkingSharingOn(ledger) {
  return Boolean(parkingSettingsRecord(ledger)?.enabled);
}

/** Switch sharing on or off. Off keeps every Parking tick already made. */
export function setParkingSharing(ledger, enabled) {
  const prev = parkingSettingsRecord(ledger);
  const now = new Date().toISOString();
  const rec = {
    id: PARKING_SETTINGS_ID,
    recordType: PARKING_RECORD_TYPE,
    description: 'Parking sharing setting', // shown if it ever clashes in a sync
    enabled: Boolean(enabled),
    createdAt: prev?.createdAt ?? now,
  };
  const others = (ledger.scheduledItems ?? []).filter((r) => r.recordType !== PARKING_RECORD_TYPE);
  return { ...ledger, scheduledItems: [...others, rec], lastModified: now };
}

// ------------------------------------------------------------------ the flag

/** Can this entry carry the Parking tick? A plain payment out, not a transfer leg or a note. */
export function canBeParking(t) {
  return Boolean(t) && t.kind !== 'note' && t.direction === 'debit' && !t.transferId;
}

/** Is the entry flagged as parking (whether or not it would be shared)? */
export const isParking = (t) => t?.parking === true;

/**
 * Tick or untick one entry. The field is removed rather than set false, so an
 * entry that was never parking looks exactly as before. The flag never touches
 * the reconcile tick (it isn't money).
 */
export function setParkingFlag(ledger, id, on) {
  let changed = false;
  const transactions = ledger.transactions.map((t) => {
    if (t.id !== id) return t;
    const want = Boolean(on) && canBeParking(t);
    if (want === isParking(t)) return t;
    changed = true;
    if (want) return { ...t, parking: true };
    const { parking, ...rest } = t;
    return rest;
  });
  return changed ? { ...ledger, transactions, lastModified: new Date().toISOString() } : ledger;
}

// ------------------------------------------------------------------ the file

/**
 * The `transactions` list for the file, from YOUR ledger (never pass the
 * combined ledger: joint entries don't belong in it). Sorted by date then id,
 * so the same set always gives the same text.
 */
export function parkingTransactions(ledger) {
  const names = new Map((ledger?.accounts ?? []).map((a) => [a.id, a.name]));
  return (ledger?.transactions ?? [])
    .filter((t) => isParking(t) && canBeParking(t) && Number.isInteger(t.amount) && t.amount > 0 && /^\d{4}-\d{2}-\d{2}$/.test(t.date ?? ''))
    .map((t) => {
      const e = { id: t.id, date: t.date, amountPence: t.amount };
      const name = names.get(t.accountId);
      if (name) e.account = name;
      return e;
    })
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The whole file's text. */
export function buildParkingFile(transactions, { appVersion, now = new Date() } = {}) {
  return `${JSON.stringify({
    format: PARKING_FORMAT,
    version: PARKING_FORMAT_VERSION,
    generatedAt: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    source: { app: 'personal-finance', appVersion: appVersion ?? null },
    transactions,
  }, null, 2)}\n`;
}

/** One entry reduced to the fields that count, for comparing. */
function norm(e) {
  return { id: String(e?.id), date: e?.date ?? null, amountPence: e?.amountPence ?? null, account: e?.account ?? null };
}
/** Same set of transactions? Order and generatedAt/source don't count (spec §5). */
export function sameTransactions(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const key = (list) => JSON.stringify(list.map(norm).sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)));
  return key(a) === key(b);
}

/**
 * Read what's in the Drive file now. Never throws.
 * → { ok: true, transactions } | { ok: false, error }. A file from a newer
 * format, or something else with the same name, is never overwritten.
 */
export function parseParkingFile(text) {
  let data;
  try { data = JSON.parse(text); } catch { return { ok: false, error: 'The parking file in Drive isn’t valid JSON, so it was left alone.' }; }
  if (data?.format !== PARKING_FORMAT) return { ok: false, error: 'The file called parking-transactions.json in Drive isn’t the ticket tracker’s parking file, so it was left alone.' };
  if (!Number.isInteger(data.version) || data.version < 1) return { ok: false, error: 'The parking file in Drive has no valid format version, so it was left alone.' };
  if (data.version > PARKING_FORMAT_VERSION) {
    return { ok: false, error: `The parking file in Drive is format version ${data.version}; this app writes version ${PARKING_FORMAT_VERSION}. Update Personal Finance.` };
  }
  return { ok: true, transactions: Array.isArray(data.transactions) ? data.transactions : [] };
}

/**
 * Bring the Drive file up to date with the ledger. Called after a sync that
 * reached Drive (so it uses that sync's token: never a sign-in window) and
 * when sharing is switched on.
 *
 * `cached` is this device's record of the file as it last saw it:
 * { fileId, version, transactions, checkedAt, sharedAt, error }.
 *  - Drive version unchanged and the list equals what we last saw → nothing to do (one small search).
 *  - Drive version unchanged but the list changed here → upload.
 *  - Drive version changed (the other device wrote it, or the tracker made a new one) → download, compare, upload only if different.
 * A failed upload leaves the file alone; it's tried again after the next sync.
 * Auth errors are passed on (the caller's sync handles them).
 *
 * @returns the new cached record (always), with `uploaded: true` when it wrote.
 */
export async function publishParking({ drive, token, ledger, cached, appVersion, now = () => new Date() }) {
  const checkedAt = now().toISOString();
  const want = parkingTransactions(ledger);
  const keep = { fileId: cached?.fileId ?? null, version: cached?.version ?? null, transactions: cached?.transactions ?? null, sharedAt: cached?.sharedAt ?? null };
  const soft = (err, what) => {
    if (err?.auth) throw err;
    return { ...keep, checkedAt, error: `Couldn’t ${what} (${err?.message ?? err}). It’ll try again after the next sync.`, uploaded: false };
  };

  let files;
  try { files = await drive.findFilesByName(token, PARKING_FILE_NAME); } catch (err) { return soft(err, 'look for the parking file'); }
  const f = files?.[0];
  if (!f) return { fileId: null, version: null, transactions: null, sharedAt: keep.sharedAt, checkedAt, error: NO_FILE_MESSAGE, uploaded: false };

  let current = null;
  if (cached?.fileId === f.id && cached?.version === f.version && Array.isArray(cached.transactions)) {
    current = cached.transactions; // nobody has written it since we last saw it
  } else {
    let text;
    try { text = await drive.download(token, f.id); } catch (err) { return soft(err, 'read the parking file'); }
    const parsed = parseParkingFile(text);
    if (!parsed.ok) return { fileId: f.id, version: f.version, transactions: null, sharedAt: keep.sharedAt, checkedAt, error: parsed.error, uploaded: false };
    current = parsed.transactions;
  }

  if (sameTransactions(current, want)) {
    return { fileId: f.id, version: f.version, transactions: want, sharedAt: keep.sharedAt, checkedAt, error: null, uploaded: false };
  }
  let saved;
  try {
    saved = await drive.updateFile(token, f.id, buildParkingFile(want, { appVersion, now: now() }));
  } catch (err) {
    // keep what we knew of the file, so the next try compares against it again
    return soft(err, 'update the parking file');
  }
  return { fileId: f.id, version: String(saved.version), transactions: want, sharedAt: checkedAt, checkedAt, error: null, uploaded: true };
}

/** Turning on: the tracker's file ({ id, version }, oldest first) or null. Never creates it. Errors are passed on. */
export async function findParkingFile({ drive, token }) {
  const files = await drive.findFilesByName(token, PARKING_FILE_NAME);
  return files?.[0] ?? null;
}
