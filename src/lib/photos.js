/**
 * v0.15.8: receipts for expense claims — kept on THIS device only.
 * v0.15.9: a receipt is a photo (shrunk before storing) or a PDF (kept as it is).
 *
 * Never uploaded, never in the ledger, the joint file, a backup or an export:
 * the ledger only ever holds `entry.expense` (lib/expenses.js), and photos are
 * found by the entry's id. So a photo attached on one device isn't on another
 * (it travels by Share instead).
 *
 * The library works over a small backend so it can be tested in Node:
 *   list()            → [{ id, entryId, size, type, addedAt, name? }]   (no file data)
 *   get(id)           → Blob | null
 *   put(meta, blob)   → store one photo
 *   remove(ids)       → delete those photos
 * The real backend is IndexedDB, in its own database (store.js), encrypted
 * while the passphrase lock is on.
 */
import { randomUUID } from './id.js';
import { cleanupPlan } from './expenses.js';

export const MAX_EDGE = 1600; // px, long side, before storing
export const JPEG_QUALITY = 0.82;
/** v0.15.9: PDFs are kept exactly as they are, up to this size each. */
export const MAX_PDF_BYTES = 10 * 1024 * 1024;
export const PDF_TYPE = 'application/pdf';

/** Is a picked file (or a stored receipt's meta) a PDF? Some pickers leave the type blank, so the name counts too. */
export function isPdf(f) {
  return Boolean(f) && (f.type === PDF_TYPE || (!f.type && /\.pdf$/i.test(f.name ?? '')));
}
/** Why a picked PDF can't be kept, or null if it's fine. */
export function pdfProblem(file) {
  if ((file.size ?? 0) > MAX_PDF_BYTES) return `${file.name || 'That PDF'} is over 10 MB — too big to keep here`;
  if (!file.size) return `${file.name || 'That PDF'} is empty`;
  return null;
}

export function createPhotoLibrary(backend) {
  const byDate = (a, b) => (a.addedAt < b.addedAt ? -1 : a.addedAt > b.addedAt ? 1 : 0);
  return {
    list: () => backend.list(),
    async forEntry(entryId) {
      return (await backend.list()).filter((m) => m.entryId === entryId).sort(byDate);
    },
    /** How many photos each entry has: Map(entryId → n). */
    async counts() {
      const out = new Map();
      for (const m of await backend.list()) out.set(m.entryId, (out.get(m.entryId) ?? 0) + 1);
      return out;
    },
    async add(entryId, blob, nowIso = new Date().toISOString(), name = null) {
      const type = isPdf(blob) || isPdf({ type: '', name: name ?? '' }) ? PDF_TYPE : blob.type || 'image/jpeg';
      const meta = { id: randomUUID(), entryId, size: blob.size ?? 0, type, addedAt: nowIso };
      if (name) meta.name = String(name).slice(0, 120);
      await backend.put(meta, blob);
      return meta;
    },
    get: (id) => backend.get(id),
    async remove(ids) {
      if (ids.length) await backend.remove(ids);
    },
    async removeForEntry(entryId) {
      const ids = (await backend.list()).filter((m) => m.entryId === entryId).map((m) => m.id);
      if (ids.length) await backend.remove(ids);
      return ids.length;
    },
    /** What "Delete photos of paid claims" would do (lib/expenses.js cleanupPlan). */
    async cleanupPlan(ledger) {
      return cleanupPlan(ledger, await backend.list());
    },
  };
}

/** In-memory backend: for tests, and as a stand-in if IndexedDB can't be opened. */
export function memoryPhotoBackend() {
  const metas = new Map();
  const blobs = new Map();
  return {
    async list() { return [...metas.values()].map((m) => ({ ...m })); },
    async get(id) { return blobs.get(id) ?? null; },
    async put(meta, blob) { metas.set(meta.id, { ...meta }); blobs.set(meta.id, blob); },
    async remove(ids) { for (const id of ids) { metas.delete(id); blobs.delete(id); } },
  };
}

/** Width and height to shrink a picture to, keeping its shape. */
export function fitWithin(width, height, maxEdge = MAX_EDGE) {
  const long = Math.max(width, height);
  if (!long || long <= maxEdge) return { width, height };
  const k = maxEdge / long;
  return { width: Math.round(width * k), height: Math.round(height * k) };
}
