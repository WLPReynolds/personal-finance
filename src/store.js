/**
 * Local persistence: one IndexedDB database, one key-value store.
 *   'ledger' -> the whole Ledger object
 *   'meta'   -> { lastExportAt, lastImportAt, lastImportFrom }
 *
 * Saving the whole ledger each time is fine at this size (a year of the
 * Budget sheet is ~400 rows ≈ 150 KB of JSON). When Drive sync arrives it
 * slots in behind loadLedger/saveLedger.
 */
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

async function get(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function put(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
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
