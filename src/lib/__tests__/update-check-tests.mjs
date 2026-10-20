// Run with: node src/lib/__tests__/update-check-tests.mjs
// v0.15.6: a tab left open notices when a newer version has been deployed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pageVersionFrom, isNewerVersion, dueForCheck, UPDATE_CHECK_MIN_MS } from '../update-check.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); } catch (err) { failed++; console.log(`  FAIL - ${name}`); console.log(`    ${err.message}`); }
}
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

console.log('update check');

test('reads the version stamp from index.html', () => {
  assert.equal(pageVersionFrom('<head><meta name="app-version" content="0.15.6"></head>'), '0.15.6');
  assert.equal(pageVersionFrom("<meta name='app-version' content=' 1.2.3 '>"), '1.2.3');
  const real = read('index.html');
  const app = read('src/app.js').match(/export const APP_VERSION = '([^']+)'/)[1];
  assert.equal(pageVersionFrom(real), app, 'the real page parses to the running version');
});

test('a page with no stamp (or no page) gives null', () => {
  assert.equal(pageVersionFrom('<html><head></head></html>'), null);
  assert.equal(pageVersionFrom(undefined), null);
});

test('only a later deployed version counts as newer', () => {
  assert.equal(isNewerVersion('0.15.6', '0.15.5'), true);
  assert.equal(isNewerVersion('0.16.0', '0.15.9'), true);
  assert.equal(isNewerVersion('1.0.0', '0.99.99'), true);
  assert.equal(isNewerVersion('0.15.10', '0.15.9'), true, 'numeric, not text, compare');
  assert.equal(isNewerVersion('0.15.5', '0.15.5'), false, 'same version');
  assert.equal(isNewerVersion('0.15.4', '0.15.5'), false, 'an older cached page never prompts');
  assert.equal(isNewerVersion('0.15', '0.15.0'), false, 'missing part counts as 0');
});

test('an unreadable stamp never prompts', () => {
  assert.equal(isNewerVersion(null, '0.15.5'), false);
  assert.equal(isNewerVersion('next', '0.15.5'), false);
  assert.equal(isNewerVersion('0.15.6-beta', '0.15.5'), false);
});

test('checks are spaced out', () => {
  assert.equal(dueForCheck(0, 1000), true, 'never checked');
  assert.equal(dueForCheck(1000, 1000 + UPDATE_CHECK_MIN_MS - 1), false);
  assert.equal(dueForCheck(1000, 1000 + UPDATE_CHECK_MIN_MS), true);
});

test('the app checks when the tab comes back and while it stays open, and the offline copy has the helper', () => {
  const app = read('src/app.js');
  const vis = app.slice(app.indexOf("document.addEventListener('visibilitychange'"));
  assert.ok(vis.slice(0, 300).includes('checkForNewerVersion()'), 'checked on return to the tab');
  assert.ok(/setInterval\([^\n]*checkForNewerVersion/.test(app), 'checked on a timer');
  assert.ok(read('sw.js').includes("'src/lib/update-check.js'"), 'sw.js SHELL lists update-check.js');
});

test('finding a newer version offers a reload — it never reloads by itself', () => {
  const app = read('src/app.js');
  const start = app.indexOf('async function checkForNewerVersion(');
  const fn = app.slice(start, app.indexOf('\n}\n', start));
  assert.ok(fn.includes('showUpdateBanner('), 'shows the bar');
  assert.ok(!fn.includes('location.reload'), 'no automatic reload');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
