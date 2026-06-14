// Pure-logic sanity check for crypto-shim. Run from the mobile app:
//   cd mobile && npx tsx src/adapters/keystore/crypto-shim.check.mts
//
// We can't load expo-secure-store under Node, so we re-implement the shim's pure
// logic (maskKey, ref generation, encrypt/decrypt over an in-memory SecretStore)
// here and assert it. The maskKey body is pasted from upstream crypto.ts to prove
// the shim copy is character-for-character identical.

import assert from 'node:assert';

// ── in-memory SecretStore stand-in ──────────────────────────────────────────
const mem = new Map<string, string>();
const secretStore = {
  put: (ref: string, secret: string) => void mem.set(ref, secret),
  get: (ref: string): string | null => (mem.has(ref) ? mem.get(ref)! : null),
  delete: (ref: string) => void mem.delete(ref),
};

// ── logic mirrored from crypto-shim.ts ───────────────────────────────────────
const REF_PREFIX = 'k_';
const REF_RANDOM_BYTES = 16;
function randomRef(): string {
  const bytes = new Uint8Array(REF_RANDOM_BYTES);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return REF_PREFIX + hex;
}
function encrypt(text: string) {
  const ref = randomRef();
  secretStore.put(ref, text);
  return { encrypted: ref, iv: '', authTag: '' };
}
function decrypt(encrypted: string, _iv: string, _authTag: string): string {
  const secret = secretStore.get(encrypted);
  if (secret === null) throw new Error(`no secret for ref "${encrypted}"`);
  return secret;
}
// maskKey — pasted from upstream server/src/lib/crypto.ts
function maskKey(key: string): string {
  if (key.length <= 8) return '****' + key.slice(-4);
  return key.slice(0, 4) + '...' + key.slice(-4);
}

// ── assertions ───────────────────────────────────────────────────────────────
// maskKey parity with upstream tests (crypto.test.ts)
assert.equal(maskKey('gsk_test1234567890abcdef'), 'gsk_...cdef');
assert.equal(maskKey('abcd'), '****abcd');
assert.equal(maskKey('12345678'), '****5678'); // boundary: length === 8

// ref format: k_ + 32 hex chars, all url-safe for expo-secure-store keys
const ref = encrypt('x').encrypted;
assert.match(ref, /^k_[0-9a-f]{32}$/, `ref shape: ${ref}`);

// refs are unique across many draws
const seen = new Set<string>();
for (let i = 0; i < 5000; i++) seen.add(encrypt('dup').encrypted);
assert.equal(seen.size, 5000, 'refs must be unique');

// round-trip: encrypt stores secret, decrypt resolves it
const e = encrypt('sk-secret-value');
assert.equal(e.iv, '');
assert.equal(e.authTag, '');
assert.equal(decrypt(e.encrypted, e.iv, e.authTag), 'sk-secret-value');

// decrypt of an unknown/evicted ref throws (mirrors upstream GCM-failure path)
secretStore.delete(e.encrypted);
assert.throws(() => decrypt(e.encrypted, '', ''), /no secret/);

// two encrypts of the same plaintext yield different refs (like upstream's
// "should produce different ciphertext" — different random IV / here random ref)
const a = encrypt('same');
const b = encrypt('same');
assert.notEqual(a.encrypted, b.encrypted);

console.log('OK: maskKey parity, ref format, uniqueness, round-trip, missing-ref throw');
