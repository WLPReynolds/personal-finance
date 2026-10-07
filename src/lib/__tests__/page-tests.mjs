// Run with: node src/lib/__tests__/page-tests.mjs
// v0.13.2: checks that index.html and the code agree, so a deploy can't ship a
// page that's missing something the code looks for (the "Couldn't save:
// Cannot read properties of null (reading 'open')" problem of 7 Oct 2026).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const html = read('index.html');
const app = read('src/app.js');
const sw = read('sw.js');
const pkg = JSON.parse(read('package.json'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL - ${name}`);
    console.log(`    ${err.message}`);
  }
}

const appVersion = app.match(/export const APP_VERSION = '([^']+)'/)?.[1];
const swVersion = sw.match(/const VERSION = '([^']+)'/)?.[1];
const pageVersion = html.match(/<meta name="app-version" content="([^"]+)">/)?.[1];

console.log('page and code agree');
test('one version number everywhere: app.js, sw.js, package.json, index.html', () => {
  assert.ok(appVersion, 'APP_VERSION not found in app.js');
  assert.equal(swVersion, appVersion, 'sw.js VERSION');
  assert.equal(pkg.version, appVersion, 'package.json version');
  assert.equal(pageVersion, appVersion, 'index.html <meta name="app-version">');
});

test('every element the code looks up by id is on the page (or made by the code)', () => {
  const onPage = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const madeByCode = new Set([...app.matchAll(/\bid: '([^']+)'/g)].map((m) => m[1]));
  const looked = new Set([...app.matchAll(/(?:\$|isOpen)\('([^']+)'\)/g)].map((m) => m[1]));
  const missing = [...looked].filter((id) => !onPage.has(id) && !madeByCode.has(id));
  assert.deepEqual(missing, [], `missing from index.html: ${missing.join(', ')}`);
});

test('dialog "is it open?" checks are null-safe (isOpen), never $(…).open', () => {
  const unsafe = app.match(/\$\('[^']+'\)\.open\b/g) ?? [];
  assert.deepEqual(unsafe, []);
});

test('a save only says "Couldn\'t save" when storing failed — screen problems are reported separately', () => {
  const commit = app.slice(app.indexOf('async function commit('), app.indexOf('\n}\n', app.indexOf('async function commit(')));
  const saveCatch = commit.slice(commit.indexOf('await saveLedger'), commit.indexOf('return;'));
  assert.match(saveCatch, /Couldn't save/);
  assert.match(saveCatch, /state\.ledger = previous/);
  const after = commit.slice(commit.indexOf('return;'));
  assert.doesNotMatch(after, /state\.ledger = previous/, 'a screen problem must not undo the change');
  assert.match(after, /scheduleSync\(\)/, 'a saved change still goes to Drive');
});

test('every app file is in the offline cache list', () => {
  const imports = new Set(['src/app.js']);
  const queue = ['src/app.js'];
  while (queue.length) {
    const file = queue.pop();
    for (const m of read(file).matchAll(/^import [^;]*? from '(\.[^']+)'/gm)) {
      const p = join(dirname(file), m[1]).replaceAll('\\', '/');
      if (!imports.has(p)) { imports.add(p); queue.push(p); }
    }
  }
  const missing = [...imports].filter((p) => !sw.includes(`'${p}'`));
  assert.deepEqual(missing, []);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
