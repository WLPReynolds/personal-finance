/**
 * v0.15.6: notice when a tab that has been left open is running an older
 * version than the one deployed. The network-first service worker means any
 * reload gets the new files, but a desktop tab can stay open for days without
 * reloading. The app fetches index.html now and then, reads its
 * <meta name="app-version"> stamp, and offers a reload when it is newer.
 * Pure helpers only; the fetching and the banner live in app.js.
 */

/** Check at most this often when the tab comes back into view. */
export const UPDATE_CHECK_MIN_MS = 10 * 60 * 1000;
/** And this often while the tab stays open and visible. */
export const UPDATE_CHECK_EVERY_MS = 60 * 60 * 1000;

/** The version stamp in an index.html, or null when it has none. */
export function pageVersionFrom(html) {
  if (typeof html !== 'string') return null;
  const m = html.match(/<meta\s+name=["']app-version["']\s+content=["']([^"']+)["']/i);
  return m ? m[1].trim() : null;
}

/** "0.15.6" → [0, 15, 6]; anything not plain dotted numbers → null. */
function parts(v) {
  if (typeof v !== 'string' || !/^\d+(\.\d+)*$/.test(v.trim())) return null;
  return v.trim().split('.').map(Number);
}

/**
 * True only when `deployed` is a later version than `running`. An older or
 * unreadable stamp (GitHub Pages briefly serving a cached page, or the service
 * worker answering from its offline copy) never prompts a reload.
 */
export function isNewerVersion(deployed, running) {
  const a = parts(deployed);
  const b = parts(running);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** Whether enough time has passed since the last check to check again. */
export function dueForCheck(lastCheckedAt, now, minGapMs = UPDATE_CHECK_MIN_MS) {
  return !lastCheckedAt || now - lastCheckedAt >= minGapMs;
}
