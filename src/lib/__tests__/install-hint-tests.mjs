// Run with: node src/lib/__tests__/install-hint-tests.mjs
// v0.15.7: iPhone / iPad install hint.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { iosInstallState, hintBannerDue, HINT_SNOOZE_DAYS } from '../install-hint.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); } catch (err) { failed++; console.log(`  FAIL - ${name}`); console.log(`    ${err.message}`); }
}
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const IPHONE_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/138.0 Mobile/15E148 Safari/604.1';
const IPAD_DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15';
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0 Mobile Safari/537.36';
const MAC_DESKTOP = IPAD_DESKTOP;

console.log('install hint');

test('iPhone in Safari, not installed, needs the hint', () => {
  assert.equal(iosInstallState({ userAgent: IPHONE_SAFARI }), 'needs-install');
  assert.equal(iosInstallState({ userAgent: IPHONE_CHROME }), 'needs-install', 'other iOS browsers can Add to Home Screen too');
});

test('installed Home Screen app gets no hint', () => {
  assert.equal(iosInstallState({ userAgent: IPHONE_SAFARI, standalone: true }), 'installed');
  assert.equal(iosInstallState({ userAgent: IPHONE_SAFARI, displayModeStandalone: true }), 'installed');
});

test('iPad asking for the desktop site still counts as iOS', () => {
  assert.equal(iosInstallState({ userAgent: IPAD_DESKTOP, maxTouchPoints: 5 }), 'needs-install');
});

test('Android and desktop are left alone (Android has its own Install button)', () => {
  assert.equal(iosInstallState({ userAgent: ANDROID }), 'not-ios');
  assert.equal(iosInstallState({ userAgent: MAC_DESKTOP, maxTouchPoints: 0 }), 'not-ios');
  assert.equal(iosInstallState({}), 'not-ios');
});

test('banner shows until dismissed, then returns after the snooze', () => {
  const now = Date.UTC(2026, 9, 22, 12);
  const day = 24 * 60 * 60 * 1000;
  assert.equal(hintBannerDue(null, now), true);
  assert.equal(hintBannerDue('', now), true);
  assert.equal(hintBannerDue('garbage', now), true);
  assert.equal(hintBannerDue(String(now - day), now), false);
  assert.equal(hintBannerDue(String(now - (HINT_SNOOZE_DAYS * day - 1)), now), false);
  assert.equal(hintBannerDue(String(now - HINT_SNOOZE_DAYS * day), now), true);
});

test('page has the install dialog and the service worker caches the module', () => {
  assert.match(read('index.html'), /<dialog id="installDialog"/);
  assert.match(read('sw.js'), /'src\/lib\/install-hint\.js'/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
