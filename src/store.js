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
 */
import { encryptValue, decryptValue, isEncryptedValue } from './lib/vault.js';

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
const DATA_KEYS = ['ledger', 'meta', 'sync', 'bankHolidays', 'auth', 'trackerEstimates'];
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
    const entries = [];
    for (const k of DATA_KEYS) {
      const v = await get(k); // decrypts with the current key
      if (v === null) continue;
      entries.push([k, key ? await encryptValue(key, v, k) : v]);
    }
    entries.push([VAULT, header ?? undefined]);
    await rawPutMany(entries);
    vaultKey = key ?? null;
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
