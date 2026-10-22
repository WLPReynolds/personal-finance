/**
 * v0.15.7: iPhone / iPad install hint.
 *
 * iOS has no install prompt (no `beforeinstallprompt`), so the app has to tell
 * people to use Share → Add to Home Screen themselves. It matters for more than
 * looks: on iOS the Home Screen app keeps its own storage, separate from Safari,
 * and Safari can clear a site's storage after a spell of not being used — the
 * installed app is exempt. So: install first, then enter data.
 *
 * Pure (no DOM), so it can be tested in Node. app.js passes in what it reads
 * from navigator / matchMedia.
 */

/**
 * @param {{ userAgent?: string, platform?: string, maxTouchPoints?: number,
 *           standalone?: boolean, displayModeStandalone?: boolean }} env
 * @returns {'not-ios' | 'installed' | 'needs-install'}
 */
export function iosInstallState(env = {}) {
  const ua = env.userAgent ?? '';
  const ios = /iPhone|iPad|iPod/i.test(ua)
    // iPadOS asks for the desktop site and reports itself as a Mac — a touch screen gives it away
    || (/Macintosh/i.test(ua) && (env.maxTouchPoints ?? 0) > 1);
  if (!ios) return 'not-ios';
  if (env.standalone === true || env.displayModeStandalone === true) return 'installed';
  return 'needs-install';
}

/** Days the banner stays hidden after "Not now" (the Install button stays). */
export const HINT_SNOOZE_DAYS = 7;

/** True if the banner should show, given when (ms) it was last dismissed. */
export function hintBannerDue(dismissedAt, now = Date.now()) {
  const t = Number(dismissedAt);
  if (!Number.isFinite(t) || t <= 0) return true;
  return now - t >= HINT_SNOOZE_DAYS * 24 * 60 * 60 * 1000;
}
