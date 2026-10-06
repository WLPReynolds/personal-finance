// Run with: node src/lib/__tests__/vault-tests.mjs
// v0.10 passphrase lock: key wrapping, wrong passphrase, value encryption, passphrase change.
import assert from 'node:assert/strict';
import {
  createVault, unlockVault, changePassphrase, encryptValue, decryptValue, isEncryptedValue, isVaultHeader,
  passphraseProblem, toB64, fromB64, DEFAULT_ITERATIONS,
} from '../vault.js';

let passed = 0;
let failed = 0;
const queue = [];
const test = (name, fn) => queue.push([name, fn]);
const FAST = { iterations: 1000 }; // the real 600k rounds are tested once below

test('passphrase rules: 8+ characters, no edge spaces, confirmation must match', () => {
  assert.match(passphraseProblem('short'), /at least 8/);
  assert.match(passphraseProblem(' padded pass'), /spaces/);
  assert.match(passphraseProblem('long enough', 'long enougH'), /match/);
  assert.equal(passphraseProblem('long enough', 'long enough'), null);
  assert.equal(passphraseProblem('long enough'), null);
});

test('base64 round trip, including a large buffer', () => {
  const big = new Uint8Array(200_000).map((_, i) => i % 256);
  assert.deepEqual(fromB64(toB64(big)), big);
});

test('right passphrase unlocks; wrong one returns null', async () => {
  const { header, key } = await createVault('correct horse', FAST);
  assert.ok(isVaultHeader(header));
  const blob = await encryptValue(key, { a: 1 }, 'ledger');
  assert.equal(await unlockVault(header, 'wrong horse'), null);
  const again = await unlockVault(header, 'correct horse');
  assert.ok(again);
  assert.deepEqual(await decryptValue(again, blob, 'ledger'), { a: 1 });
});

test('header and stored values reveal nothing readable', async () => {
  const { header, key } = await createVault('correct horse', FAST);
  const secret = { accounts: [{ name: 'Barclaycard' }], amount: 123456 };
  const blob = await encryptValue(key, secret, 'ledger');
  assert.ok(isEncryptedValue(blob));
  const text = JSON.stringify({ header, blob });
  assert.ok(!text.includes('Barclaycard') && !text.includes('123456') && !text.includes('correct horse'));
});

test('a value encrypted under one name will not decrypt under another', async () => {
  const { key } = await createVault('correct horse', FAST);
  const blob = await encryptValue(key, { x: 1 }, 'meta');
  await assert.rejects(decryptValue(key, blob, 'ledger'), /couldn’t be decrypted/);
});

test('tampered data is refused', async () => {
  const { key } = await createVault('correct horse', FAST);
  const blob = await encryptValue(key, { x: 1 }, 'ledger');
  const bytes = fromB64(blob.data);
  bytes[0] ^= 1;
  await assert.rejects(decryptValue(key, { ...blob, data: toB64(bytes) }, 'ledger'));
});

test('same value twice → different ciphertext (fresh IV each save)', async () => {
  const { key } = await createVault('correct horse', FAST);
  const a = await encryptValue(key, { x: 1 }, 'ledger');
  const b = await encryptValue(key, { x: 1 }, 'ledger');
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.data, b.data);
});

test('change passphrase: old data still readable with the new one; old passphrase stops working', async () => {
  const { header, key } = await createVault('first passphrase', FAST);
  const blob = await encryptValue(key, { kept: true }, 'ledger');
  assert.equal(await changePassphrase(header, 'not the one', 'second passphrase'), null);
  const next = await changePassphrase(header, 'first passphrase', 'second passphrase');
  assert.ok(next && next.kdf.salt !== header.kdf.salt);
  assert.equal(await unlockVault(next, 'first passphrase'), null);
  const k2 = await unlockVault(next, 'second passphrase');
  assert.deepEqual(await decryptValue(k2, blob, 'ledger'), { kept: true });
  await assert.rejects(changePassphrase(header, 'first passphrase', 'tiny'), /at least 8/);
});

test('auto-lock minutes are kept in the header and survive a passphrase change', async () => {
  const { header } = await createVault('correct horse', { ...FAST, autoLockMinutes: 30 });
  assert.equal(header.autoLockMinutes, 30);
  assert.equal((await changePassphrase(header, 'correct horse', 'battery staple')).autoLockMinutes, 30);
});

test('createVault refuses a weak passphrase', async () => {
  await assert.rejects(createVault('1234', FAST), /at least 8/);
});

test('real strength: 600,000 rounds by default, and unlocking takes noticeable time', async () => {
  const t0 = Date.now();
  const { header } = await createVault('correct horse');
  assert.equal(header.kdf.iterations, DEFAULT_ITERATIONS);
  assert.ok(await unlockVault(header, 'correct horse'));
  assert.ok(Date.now() - t0 > 50, 'two derivations at 600k should not be instant');
});

for (const [name, fn] of queue) {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL - ${name}\n    ${err.stack}`);
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
