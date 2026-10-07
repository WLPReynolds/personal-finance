/**
 * Service worker: NETWORK-FIRST, cache as offline fallback.
 * Chosen over cache-first because you deploy small changes often — a fresh
 * load always gets the latest files when online, so there's no "why is my
 * phone still on the old version" problem. Bump VERSION on each deploy
 * anyway so old caches get cleaned up.
 */
const VERSION = '0.13.1';
const CACHE = `finance-tracker-${VERSION}`;
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'src/app.js',
  'src/store.js',
  'src/google-auth.js',
  'src/drive.js',
  'src/lib/sync-engine.js',
  'src/lib/sync-core.js',
  'src/lib/merge.js',
  'src/lib/ops.js',
  'src/lib/schedule.js',
  'src/lib/statements.js',
  'src/lib/reconcile.js',
  'src/lib/backups.js',
  'src/lib/vault.js',
  'src/lib/tracker-estimates.js',
  'src/lib/tickets.js',
  'src/lib/envelopes.js',
  'src/lib/workdays.js',
  'src/lib/grid.js',
  'src/lib/money.js',
  'src/lib/institutions.js',
  'src/lib/transfer-file.js',
  'src/lib/balances.js',
  'src/lib/ledger.js',
  'src/lib/id.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('finance-tracker-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  event.respondWith(
    // cache: 'no-cache' makes the browser revalidate with GitHub Pages every
    // time instead of trusting its ~10-minute HTTP cache — otherwise a deploy
    // can arrive half-applied (e.g. new styles.css, old app.js).
    fetch(req, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(async () => (await caches.match(req, { ignoreSearch: true })) ??
        (req.mode === 'navigate' ? caches.match('index.html') : Response.error()))
  );
});
