/**
 * Local persistence: one IndexedDB database, one key-value store.
 *   'ledger' -> the whole Ledger object
 *   'meta'   -> { lastExportAt, lastImportAt, lastImportFrom }
 *
 * Saving the whole ledger each time is fine at this size (a year of the
 * Budget sheet is ~400 rows ≈ 150 KB of JSON). When Drive sync arrives it
 * slots in behind loadLedger/saveLedger.
 *   'sync', 'bankHolidays', 'auth' (v0.10), 'vault' (v0.10 lock header),
 *   'trackerEstimates' (v0.11)
 *   'jointLedger', 'jointSync', 'jointSettings' (v0.14: the joint account's own
 *   local copy, its own Drive sync state, and this device's on/off switch —
 *   never mixed with the personal records above)
 *   'archive' (v0.14.8: history imported from Budget.xlsx — read-only, never
 *   in the ledger or synced with it; see lib/archive.js)
 */
import { encryptValue, decryptValue, isEncryptedValue, toB64, fromB64 } from './lib/vault.js';

const DB_NAME = 'finance-tracker';
const STORE = 'kv';

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

// ---------------------------------------------------------------- v0.10 passphrase lock
// With the lock on, every value below is saved encrypted (see lib/vault.js)
// and `vaultKey` holds the data key in memory while unlocked. The lock's
// header ('vault') is the one record always saved in plain view.
const VAULT = 'vault';
const DATA_KEYS = ['ledger', 'meta', 'sync', 'bankHolidays', 'auth', 'trackerEstimates', 'jointLedger', 'jointSync', 'jointSettings', 'archive'];
let vaultKey = null;

export class LockedError extends Error {
  constructor() { super('This device is locked'); this.name = 'LockedError'; }
}

export function setVaultKey(key) { vaultKey = key ?? null; }
export function isUnlocked() { return vaultKey !== null; }

async function rawGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

/** Write several records in ONE transaction (all or nothing). value === undefined deletes. */
async function rawPutMany(entries) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const os = tx.objectStore(STORE);
    for (const [key, value] of entries) {
      if (value === undefined) os.delete(key);
      else os.put(value, key);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function get(key) {
  const v = await rawGet(key);
  if (!isEncryptedValue(v)) return v; // plain (lock off, or not yet encrypted)
  if (!vaultKey) throw new LockedError();
  return decryptValue(vaultKey, v, key);
}

// Saves run one at a time, in order: encrypting takes a moment, and two
// quick saves of the ledger must never land in the wrong order.
let writeChain = Promise.resolve();
function put(key, value) {
  const run = writeChain.then(async () => {
    if (!vaultKey && (await rawGet(VAULT))) throw new LockedError(); // never write plain while locked on
    const stored = vaultKey ? await encryptValue(vaultKey, value, key) : value;
    await rawPutMany([[key, stored]]);
  });
  writeChain = run.catch(() => {});
  return run;
}

export const loadLedger = () => get('ledger');
export const saveLedger = (ledger) => put('ledger', ledger);
export const loadMeta = async () => (await get('meta')) ?? {};
export const saveMeta = (meta) => put('meta', meta);
/** Drive sync bookkeeping: enabled flag, Drive file id/version, and the last-synced copy ("base"). */
export const loadSyncState = () => get('sync');
export const saveSyncState = (s) => put('sync', s);

/** England & Wales bank holidays from gov.uk: { dates: string[], fetchedAt: ISO datetime } (this device only). */
export const loadBankHolidays = () => get('bankHolidays');
export const saveBankHolidays = (value) => put('bankHolidays', value);

/** v0.10: the Google sign-in token, kept here (encrypted) instead of localStorage while the lock is on. */
export const loadAuthCache = () => get('auth');
export const saveAuthCache = (value) => put('auth', value);

/** v0.11: the ticket tracker's published figures, as last read from Drive (this device only — see lib/tracker-estimates.js). */
export const loadTrackerEstimates = () => get('trackerEstimates');
export const saveTrackerEstimates = (value) => put('trackerEstimates', value);

/** v0.14 joint account (lib/joint.js). Separate records, so the personal ones are never touched by joint code. */
export const loadJointLedger = () => get('jointLedger');
export const saveJointLedger = (ledger) => put('jointLedger', ledger);
export const loadJointSyncState = () => get('jointSync');
export const saveJointSyncState = (s) => put('jointSync', s);
/** This device's switch: { enabled } — never synced. */
export const loadJointSettings = async () => (await get('jointSettings')) ?? { enabled: false };
export const saveJointSettings = (value) => put('jointSettings', value);
/** "Remove joint data from this device": the local copy and its sync state (Drive untouched). */
export async function removeJointData() {
  const run = writeChain.then(() => rawPutMany([['jointLedger', undefined], ['jointSync', undefined]]));
  writeChain = run.catch(() => {});
  return run;
}

/** v0.14.8: the imported history (lib/archive.js) — this device's copy; Drive keeps one file per year. */
export const loadArchive = () => get('archive');
export const saveArchive = (archive) => put('archive', archive);
export async function removeArchive() {
  const run = writeChain.then(() => rawPutMany([['archive', undefined]]));
  writeChain = run.catch(() => {});
  return run;
}

// ---------------------------------------------------------------- v0.15.8 receipt photos
// Expense-claim photos live in their OWN database, so the main one keeps its
// version (an older app tab opening it is never upgraded under its feet) and
// nothing here can end up in a ledger, a sync or an export. Two stores:
// 'meta' (entry id, size — no picture) and 'data' (the picture: a Blob, or
// encrypted while the passphrase lock is on). See lib/photos.js.
const PHOTO_DB = 'finance-tracker-photos';
let photoDbPromise = null;

function openPhotoDb() {
  if (!photoDbPromise) {
    photoDbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(PHOTO_DB, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('meta', { keyPath: 'id' });
        req.result.createObjectStore('data');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    photoDbPromise.catch(() => { photoDbPromise = null; });
  }
  return photoDbPromise;
}

function photoTx(stores, mode, fn) {
  return openPhotoDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let result;
    Promise.resolve(fn(tx, (r) => { result = r; })).catch(reject);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Photo save aborted'));
  }));
}
const reqP = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });

async function photoToStored(blob, id) {
  if (!vaultKey) return blob;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return encryptValue(vaultKey, { type: blob.type || 'image/jpeg', b64: toB64(bytes) }, `photo:${id}`);
}
async function storedToPhoto(v, id) {
  if (!v) return null;
  if (!isEncryptedValue(v)) return v;
  if (!vaultKey) throw new LockedError();
  const { type, b64 } = await decryptValue(vaultKey, v, `photo:${id}`);
  return new Blob([fromB64(b64)], { type });
}

/** The IndexedDB backend for lib/photos.js createPhotoLibrary(). */
export const photoBackend = {
  list: () => photoTx('meta', 'readonly', (tx, done) => reqP(tx.objectStore('meta').getAll()).then(done)),
  async get(id) {
    const v = await photoTx('data', 'readonly', (tx, done) => reqP(tx.objectStore('data').get(id)).then(done));
    return storedToPhoto(v, id);
  },
  async put(meta, blob) {
    if (!vaultKey && (await rawGet(VAULT))) throw new LockedError(); // never write plain while locked on
    const stored = await photoToStored(blob, meta.id); // before the transaction: it would close while waiting
    return photoTx(['meta', 'data'], 'readwrite', (tx) => {
      tx.objectStore('meta').put(meta);
      tx.objectStore('data').put(stored, meta.id);
    });
  },
  remove: (ids) => photoTx(['meta', 'data'], 'readwrite', (tx) => {
    for (const id of ids) { tx.objectStore('meta').delete(id); tx.objectStore('data').delete(id); }
  }),
};

/**
 * Re-save every photo plain (toKey null) or encrypted with the CURRENT key.
 * Called by rekeyAll in the order that never leaves a photo unreadable:
 * decrypted before the lock goes off, encrypted only after it's on.
 */
async function rekeyPhotos(encrypt) {
  let ids;
  try { ids = (await photoBackend.list()).map((m) => m.id); } catch { return; } // no photo database: nothing to do
  for (const id of ids) {
    const v = await photoTx('data', 'readonly', (tx, done) => reqP(tx.objectStore('data').get(id)).then(done));
    if (!v || isEncryptedValue(v) === encrypt) continue;
    const blob = await storedToPhoto(v, id);
    const stored = encrypt ? await photoToStored(blob, id) : blob;
    await photoTx('data', 'readwrite', (tx) => { tx.objectStore('data').put(stored, id); });
  }
}

export const loadVaultHeader = () => rawGet(VAULT);

/** Wait for saves already started (before locking). */
export const flushWrites = () => writeChain;

/** Save a changed header (new passphrase / auto-lock time) — the data is untouched. */
export function saveVaultHeader(header) {
  const run = writeChain.then(() => rawPutMany([[VAULT, header]]));
  writeChain = run.catch(() => {});
  return run;
}

/**
 * Turn the lock on (header + key) or off (null, null): every record is
 * re-saved encrypted or plain, together with the header, in one transaction
 * — so a crash half way can't leave data that nothing can read.
 * Must be called while unlocked (or with the lock off).
 */
export function rekeyAll(header, key) {
  const run = writeChain.then(async () => {
    if (!key) await rekeyPhotos(false); // v0.15.8: photos back to plain while the old key still works
    const entries = [];
    for (const k of DATA_KEYS) {
      const v = await get(k); // decrypts with the current key
      if (v === null) continue;
      entries.push([k, key ? await encryptValue(key, v, k) : v]);
    }
    entries.push([VAULT, header ?? undefined]);
    await rawPutMany(entries);
    vaultKey = key ?? null;
    if (key) await rekeyPhotos(true); // v0.15.8: photos encrypted once the lock is safely on
  });
  writeChain = run.catch(() => {});
  return run;
}

/** "Forgot passphrase": delete this device's whole database. Drive is not touched. */
export async function wipeDevice() {
  await writeChain;
  const db = await dbPromise?.catch(() => null);
  db?.close();
  dbPromise = null;
  vaultKey = null;
  await new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve(); // another tab has it open; it goes when that closes
  });
  // v0.15.8: receipt photos go too
  const pdb = await photoDbPromise?.catch(() => null);
  pdb?.close();
  photoDbPromise = null;
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(PHOTO_DB);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

/** Ask the browser not to evict our data under storage pressure. */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persisted && (await navigator.storage.persisted())) return true;
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch {
    /* not supported */
  }
  return false;
}
