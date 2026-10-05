/**
 * Export/import file format — the manual "sync" between phone and desktop
 * for the local-only test build, and the backup safety net later.
 * Pure functions (no DOM) so they're testable in Node.
 */
import { SCHEMA_VERSION } from './ops.js';

export const EXPORT_FORMAT = 'finance-tracker-export';

export function buildExport(ledger, deviceLabel = '') {
  return {
    format: EXPORT_FORMAT,
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    exportedFrom: deviceLabel,
    ledger,
  };
}

export function exportFileName(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `finance-tracker-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}.json`;
}

/**
 * Parse and sanity-check an export file. Throws a readable Error if the file
 * isn't one of ours, so a wrong file can never silently wipe the data.
 *
 * @param {string} text
 * @returns {{ exportedAt: string, exportedFrom: string, ledger: import('../models/schema.js').Ledger }}
 */
export function parseImport(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("That file isn't valid JSON.");
  }
  if (data?.format !== EXPORT_FORMAT || !data.ledger) {
    throw new Error("That doesn't look like a Finance Tracker export file.");
  }
  const l = data.ledger;
  for (const key of ['accounts', 'transactions', 'transfers', 'scheduledItems']) {
    if (!Array.isArray(l[key])) throw new Error(`Export file is damaged (missing ${key}).`);
  }
  if (l.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Export is schema v${l.schemaVersion}; this app expects v${SCHEMA_VERSION}. Update the app on both devices.`);
  }
  const accountIds = new Set(l.accounts.map((a) => a.id));
  for (const t of l.transactions) {
    if (!accountIds.has(t.accountId)) throw new Error('Export file is damaged (a transaction points at a missing account).');
    if (!Number.isInteger(t.amount)) throw new Error('Export file is damaged (non-pence amount).');
  }
  return { exportedAt: data.exportedAt, exportedFrom: data.exportedFrom ?? '', ledger: l };
}
