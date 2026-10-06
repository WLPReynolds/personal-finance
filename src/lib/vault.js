/**
 * v0.10 passphrase lock: encrypts what this device keeps in its own storage.
 * Uses only the browser's built-in Web Crypto (no libraries).
 *
 *   passphrase --PBKDF2-SHA256 (600k rounds, random salt)--> wrapping key
 *   random 256-bit DATA key, encrypted ("wrapped") by the wrapping key
 *   each stored value = AES-GCM(data key, JSON), labelled with its storage
 *   name so one value can't be swapped in for another
 *
 * The header (salt, rounds, wrapped key, auto-lock minutes) is stored in
 * plain view — none of it reveals anything without the passphrase. A wrong
 * passphrase fails AES-GCM's built-in check, so there's no separate
 * "check value" to attack. Changing the passphrase only re-wraps the data
 * key; the data itself isn't touched.
 *
 * The data key is imported non-extractable and lives in memory only while
 * unlocked. Nothing here is synced: the lock belongs to this device.
 */
export const VAULT_VERSION = 1;
export const DEFAULT_ITERATIONS = 600_000; // OWASP's 2023 figure for PBKDF2-SHA256
export const MIN_PASSPHRASE_LENGTH = 8;
export const AUTO_LOCK_CHOICES = [5, 15, 30, 60]; // minutes
export const DEFAULT_AUTO_LOCK = 15;

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('This browser has no built-in encryption (Web Crypto) — it needs a secure (https) page');
  return s;
};
const enc = new TextEncoder();
const dec = new TextDecoder();

export function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromB64(text) {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Why a passphrase can't be used, or null if it's fine. */
export function passphraseProblem(pass, confirmPass) {
  if (typeof pass !== 'string' || pass.length < MIN_PASSPHRASE_LENGTH) return `Use at least ${MIN_PASSPHRASE_LENGTH} characters`;
  if (pass.trim() !== pass) return 'No spaces at the start or end — they’re too easy to forget';
  if (confirmPass !== undefined && pass !== confirmPass) return 'The two passphrases don’t match';
  return null;
}

async function wrappingKey(pass, salt, iterations) {
  const base = await subtle().importKey('raw', enc.encode(pass.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

const importDataKey = (raw) => subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

async function wrap(raw, pass, iterations) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const kek = await wrappingKey(pass, salt, iterations);
  const wrapped = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode('ft-vault-key') }, kek, raw));
  return { kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: toB64(salt) }, iv: toB64(iv), wrappedKey: toB64(wrapped) };
}

/** The raw data key, or null if the passphrase is wrong. */
async function unwrapRaw(header, pass) {
  if (!isVaultHeader(header)) throw new Error('Not a passphrase lock record');
  const kek = await wrappingKey(pass, fromB64(header.kdf.salt), header.kdf.iterations);
  try {
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: fromB64(header.iv), additionalData: enc.encode('ft-vault-key') }, kek, fromB64(header.wrappedKey)));
  } catch {
    return null;
  }
}

export function isVaultHeader(h) {
  return Boolean(h) && h.version === VAULT_VERSION && h.kdf?.name === 'PBKDF2' && typeof h.wrappedKey === 'string';
}

/** New lock: { header, key }. */
export async function createVault(pass, { iterations = DEFAULT_ITERATIONS, autoLockMinutes = DEFAULT_AUTO_LOCK } = {}) {
  const problem = passphraseProblem(pass);
  if (problem) throw new Error(problem);
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const header = { version: VAULT_VERSION, ...(await wrap(raw, pass, iterations)), autoLockMinutes, createdAt: new Date().toISOString() };
  const key = await importDataKey(raw);
  raw.fill(0);
  return { header, key };
}

/** The data key, or null for a wrong passphrase. */
export async function unlockVault(header, pass) {
  const raw = await unwrapRaw(header, pass);
  if (!raw) return null;
  const key = await importDataKey(raw);
  raw.fill(0);
  return key;
}

/** A new header for a new passphrase (same data key), or null if the current one is wrong. */
export async function changePassphrase(header, currentPass, newPass) {
  const problem = passphraseProblem(newPass);
  if (problem) throw new Error(problem);
  const raw = await unwrapRaw(header, currentPass);
  if (!raw) return null;
  const next = { ...header, ...(await wrap(raw, newPass, header.kdf.iterations)), changedAt: new Date().toISOString() };
  raw.fill(0);
  return next;
}

export function isEncryptedValue(v) {
  return Boolean(v) && typeof v === 'object' && v.__ftEnc === 1 && typeof v.iv === 'string' && typeof v.data === 'string';
}

/** Encrypt any JSON-able value; `label` is its storage name (checked on decrypt). */
export async function encryptValue(key, value, label) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(label) }, key, enc.encode(JSON.stringify(value))));
  return { __ftEnc: 1, iv: toB64(iv), data: toB64(data) };
}

export async function decryptValue(key, blob, label) {
  let plain;
  try {
    plain = await subtle().decrypt({ name: 'AES-GCM', iv: fromB64(blob.iv), additionalData: enc.encode(label) }, key, fromB64(blob.data));
  } catch {
    throw new Error(`Saved data “${label}” couldn’t be decrypted`);
  }
  return JSON.parse(dec.decode(plain));
}
