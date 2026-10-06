/**
 * v0.9 automatic backups — pure rules (names, what to keep). The Drive side
 * lives in sync-engine.js.
 *
 * Files live in My Drive/Finance/backups/:
 *   personal-2026-10-06.json                     daily: Drive's copy as it stood
 *                                                before that day's first save
 *   personal-2026-10-06-before-restore-1512.json safety copy taken just before
 *                                                restoring a backup
 *
 * Keeping (Wayne, 6 Oct 2026):
 *   - the 30 most recent daily backups (days the app wasn't used have none,
 *     so this reaches back at least 30 days);
 *   - plus the FIRST daily backup of each month, for the last 12 months
 *     (this month and the 11 before);
 *   - before-restore copies for 30 days.
 * Anything not named like a backup is never touched. If two devices both made
 * the same day's backup, the older file is kept and the other removed.
 */

export const BACKUP_FOLDER_NAME = 'backups';
export const KEEP_DAILY = 30;
export const KEEP_MONTHS = 12;
export const KEEP_RESTORE_DAYS = 30;

const pad = (n) => String(n).padStart(2, '0');

/** Local calendar date of a Date, as YYYY-MM-DD (the device's own time zone). */
export function localDay(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export const dailyBackupName = (day) => `personal-${day}.json`;
export const restoreBackupName = (date) => `personal-${localDay(date)}-before-restore-${pad(date.getHours())}${pad(date.getMinutes())}.json`;

/** { kind: 'daily'|'before-restore', day, time } or null for anything else. */
export function parseBackupName(name) {
  let m = /^personal-(\d{4}-\d{2}-\d{2})\.json$/.exec(name ?? '');
  if (m) return { kind: 'daily', day: m[1], time: null };
  m = /^personal-(\d{4}-\d{2}-\d{2})-before-restore-(\d{2})(\d{2})\.json$/.exec(name ?? '');
  if (m) return { kind: 'before-restore', day: m[1], time: `${m[2]}:${m[3]}` };
  return null;
}

function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function monthIndex(day) {
  return Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7)) - 1;
}

/**
 * Backup files (from Drive: { id, name, createdTime }) with their parsed
 * names, newest first. Files that aren't backups are left out.
 */
export function describeBackups(files) {
  return files
    .map((f) => ({ ...f, info: parseBackupName(f.name) }))
    .filter((f) => f.info)
    .sort((a, b) =>
      b.info.day.localeCompare(a.info.day)
      || (b.info.time ?? '00:00').localeCompare(a.info.time ?? '00:00') // same day: the daily copy is made first, so it sorts below before-restore ones
      || String(a.createdTime ?? '').localeCompare(String(b.createdTime ?? '')));
}

/** Ids of backup files to delete, given today's local date (YYYY-MM-DD). */
export function backupsToDelete(files, today) {
  const del = [];
  // duplicates of the same name (two devices at once): keep the oldest
  const byName = new Map();
  const ordered = [...files].sort((a, b) => String(a.createdTime ?? '').localeCompare(String(b.createdTime ?? '')) || String(a.id).localeCompare(String(b.id)));
  for (const f of ordered) {
    if (!parseBackupName(f.name)) continue;
    if (byName.has(f.name)) del.push(f.id);
    else byName.set(f.name, f);
  }
  const unique = [...byName.values()].map((f) => ({ ...f, info: parseBackupName(f.name) }));

  const daily = unique.filter((f) => f.info.kind === 'daily').sort((a, b) => b.info.day.localeCompare(a.info.day));
  const keep = new Set(daily.slice(0, KEEP_DAILY).map((f) => f.id));
  const firstOfMonth = new Map(); // month index -> earliest daily file
  for (const f of daily) {
    const m = monthIndex(f.info.day);
    const cur = firstOfMonth.get(m);
    if (!cur || f.info.day < cur.info.day) firstOfMonth.set(m, f);
  }
  const thisMonth = monthIndex(today);
  for (const [m, f] of firstOfMonth) if (thisMonth - m < KEEP_MONTHS) keep.add(f.id);
  for (const f of daily) if (!keep.has(f.id)) del.push(f.id);

  const oldestRestore = addDays(today, -KEEP_RESTORE_DAYS);
  for (const f of unique) if (f.info.kind === 'before-restore' && f.info.day < oldestRestore) del.push(f.id);
  return del;
}

/** Is this daily backup one of the monthly keepers? (For the label in the list.) */
export function monthlyKeeperIds(files) {
  const firstOfMonth = new Map();
  for (const f of files) {
    const info = parseBackupName(f.name);
    if (info?.kind !== 'daily') continue;
    const m = monthIndex(info.day);
    const cur = firstOfMonth.get(m);
    if (!cur || info.day < cur.day) firstOfMonth.set(m, { day: info.day, id: f.id });
  }
  return new Set([...firstOfMonth.values()].map((x) => x.id));
}
