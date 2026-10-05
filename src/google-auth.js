/**
 * Google sign-in for Drive, using Google Identity Services' token model
 * (same approach as the ticket tracker, same OAuth client).
 *
 * Deliberate difference from the ticket tracker: this NEVER asks Google for a
 * token without a tap. On an installed Android PWA a no-tap request opens a
 * window that Android closes instantly ("popup_closed") — the flash you see
 * when the ticket tracker opens. So: a cached token is used while it lasts
 * (~1 hour); after that the sync chip says "Tap to sync".
 *
 * Lessons carried over from the ticket tracker:
 *  - error_callback is always wired, and every request has a timeout, so a
 *    closed/blocked window can't leave a promise hanging forever;
 *  - the token is cached across reloads (localStorage, this device only);
 *  - login_hint skips the account picker once we know which account;
 *  - requestAccessToken is called synchronously from the tap (callers must not
 *    await anything before calling getToken({ interactive: true })).
 */
export const GOOGLE_CLIENT_ID = '130585374763-he5hjhlgigril8otmlcalp4llonefl4e.apps.googleusercontent.com';
// drive.file: the app can only see files it created itself — not the rest of your Drive.
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const TOKEN_KEY = 'ft.googleToken';
const HINT_KEY = 'ft.googleLoginHint';
const TIMEOUT_MS = 2 * 60 * 1000; // first-time consent can take a while to read

let client = null;
let clientHint = null;
let token = null;
let expiry = 0;
let activeErrorHandler = null;
let lastError = null;

(function loadCache() {
  try {
    const c = JSON.parse(localStorage.getItem(TOKEN_KEY) ?? 'null');
    if (c && typeof c.token === 'string' && c.expiry > Date.now()) { token = c.token; expiry = c.expiry; }
  } catch { /* no cache */ }
})();

function saveCache() {
  try {
    if (token && expiry > Date.now()) localStorage.setItem(TOKEN_KEY, JSON.stringify({ token, expiry }));
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* not critical */ }
}

function loginHint() {
  try { return localStorage.getItem(HINT_KEY) || null; } catch { return null; }
}

function ensureClient() {
  const hint = loginHint();
  if (client && clientHint === hint) return client;
  if (!window.google?.accounts?.oauth2) return null;
  const config = {
    client_id: GOOGLE_CLIENT_ID,
    scope: SCOPE,
    callback: () => {}, // replaced per request
    error_callback: (err) => activeErrorHandler?.(err),
  };
  if (hint) config.login_hint = hint;
  client = window.google.accounts.oauth2.initTokenClient(config);
  clientHint = hint;
  return client;
}

/**
 * Load Google's sign-in script on demand, so the app makes no contact with
 * Google unless sync is on. Call it ahead of time (app start with sync on,
 * or opening settings): the script must already be loaded when the person
 * taps, because sign-in has to start synchronously inside the tap.
 */
let scriptPromise = null;
export function loadGoogleScript() {
  if (window.google?.accounts?.oauth2) return Promise.resolve(true);
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = () => resolve(true);
      s.onerror = () => { scriptPromise = null; s.remove(); resolve(false); }; // allow a retry later (e.g. back online)
      document.head.append(s);
    });
  }
  return scriptPromise;
}

export function hasValidToken() {
  return Boolean(token) && Date.now() < expiry;
}

export function lastAuthError() {
  return lastError;
}

/**
 * @param {{ interactive: boolean }} opts - interactive=false never shows
 *   anything; it only returns a cached, unexpired token (or null).
 * @returns {Promise<string|null>}
 */
export function getToken({ interactive }) {
  if (hasValidToken()) return Promise.resolve(token);
  if (!interactive) return Promise.resolve(null);
  const c = ensureClient();
  if (!c) {
    loadGoogleScript(); // so a second tap in a moment works
    lastError = "Google sign-in is still loading — check your connection and tap again";
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (activeErrorHandler === onError) activeErrorHandler = null;
      resolve(value);
    };
    const onError = (err) => {
      lastError = err?.type === 'popup_closed' ? 'The Google window was closed before sign-in finished' : `Google sign-in failed (${err?.type ?? 'unknown'})`;
      finish(null);
    };
    const timer = setTimeout(() => { lastError = 'Google sign-in timed out'; finish(null); }, TIMEOUT_MS);
    activeErrorHandler = onError;
    c.callback = (resp) => {
      if (resp?.access_token) {
        token = resp.access_token;
        expiry = Date.now() + (Number(resp.expires_in) || 3600) * 1000 - 60 * 1000;
        lastError = null;
        saveCache();
        finish(token);
      } else {
        lastError = `Google sign-in failed (${resp?.error ?? 'no token'})`;
        finish(null);
      }
    };
    try {
      c.requestAccessToken({ prompt: '' });
    } catch (e) {
      lastError = `Google sign-in failed (${e?.message ?? e})`;
      finish(null);
    }
  });
}

/**
 * Forget the token on this device. Deliberately does NOT revoke it with
 * Google: the OAuth client is shared with the ticket tracker, and revoking
 * would withdraw the ticket tracker's permission too.
 */
export function clearToken() {
  token = null;
  expiry = 0;
  saveCache();
}

export function setLoginHint(email) {
  try {
    if (email) localStorage.setItem(HINT_KEY, email);
    else localStorage.removeItem(HINT_KEY);
  } catch { /* not critical */ }
}

export const googleAuth = { getToken, hasValidToken, clearToken, setLoginHint, lastAuthError, preload: loadGoogleScript };
