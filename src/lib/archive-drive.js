/**
 * v0.14.8: the imported history on Google Drive — one read-only file per
 * year in My Drive/Finance/Archive/archive-YYYY.json, so the other device
 * can fetch it. Completely apart from personal.json: never synced, merged
 * or backed up with the ledger (it never changes, so there's nothing to
 * merge). Drive adapter injected (drive.js, or the test fake).
 */
import { ARCHIVE_FOLDER_NAME, ARCHIVE_FILE_RE, archiveFileName, validYear } from './archive.js';
import { DRIVE_FOLDER_NAME } from './sync-engine.js';

async function archiveFolder(drive, token) {
  const finance = await drive.findOrCreateFolder(token, DRIVE_FOLDER_NAME);
  return drive.findOrCreateFolder(token, ARCHIVE_FOLDER_NAME, finance);
}

/** The year files there → [{ id, name, year }] (one per year: the newest copy if Drive somehow has two). */
async function yearFiles(drive, token, folderId) {
  const byYear = new Map();
  for (const f of await drive.listFiles(token, folderId)) {
    const m = ARCHIVE_FILE_RE.exec(f.name);
    if (!m) continue;
    const year = Number(m[1]);
    const had = byYear.get(year);
    if (!had || String(f.createdTime ?? '') > String(had.createdTime ?? '')) byYear.set(year, { ...f, year });
  }
  return [...byYear.values()].sort((a, b) => a.year - b.year);
}

/** Save these years (a year already there is overwritten). */
export async function uploadArchiveYears(drive, token, years) {
  const folder = await archiveFolder(drive, token);
  const have = new Map((await yearFiles(drive, token, folder)).map((f) => [f.year, f]));
  for (const y of years) {
    const text = JSON.stringify(y);
    const existing = have.get(y.year);
    if (existing) await drive.updateFile(token, existing.id, text);
    else await drive.createFile(token, folder, archiveFileName(y.year), text);
  }
  return years.length;
}

/** Every year on Drive → { years: [...], skipped: [names that couldn't be read] }. */
export async function downloadArchiveYears(drive, token) {
  const folder = await archiveFolder(drive, token);
  const years = [];
  const skipped = [];
  for (const f of await yearFiles(drive, token, folder)) {
    try {
      const y = JSON.parse(await drive.download(token, f.id));
      if (validYear(y) && y.year === f.year) years.push(y);
      else skipped.push(f.name);
    } catch (err) {
      if (err?.auth) throw err;
      skipped.push(f.name);
    }
  }
  return { years, skipped };
}

/** Move the year files to Drive's bin (all of them, or just `onlyYears`) → how many. */
export async function trashArchiveYears(drive, token, onlyYears = null) {
  const folder = await archiveFolder(drive, token);
  const pick = onlyYears ? new Set(onlyYears.map(Number)) : null;
  let n = 0;
  for (const f of await yearFiles(drive, token, folder)) {
    if (pick && !pick.has(f.year)) continue;
    await drive.trashFile(token, f.id);
    n++;
  }
  // a second copy of the same year (two devices importing at once) goes too
  for (const f of await drive.listFiles(token, folder)) {
    const m = ARCHIVE_FILE_RE.exec(f.name);
    if (m && (!pick || pick.has(Number(m[1])))) { await drive.trashFile(token, f.id); n++; }
  }
  return n;
}
