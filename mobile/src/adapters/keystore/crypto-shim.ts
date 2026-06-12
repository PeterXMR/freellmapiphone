// crypto-shim — on-device replacement for the upstream `server/src/lib/crypto.ts`.
//
// ───────────────────────────────────────────────────────────────────────────
// DESIGN: API key secrets live in the Android Keystore, NOT in plaintext SQLite.
// ───────────────────────────────────────────────────────────────────────────
// Upstream lib/crypto.ts AES-256-GCM-encrypts each API key and stores the
// ciphertext + iv + authTag in the SQLite `api_keys` table. That model assumes a
// trusted server filesystem and a master ENCRYPTION_KEY. On a shared mobile device
// neither assumption holds: SQLite is world-readable to a rooted attacker and there
// is no safe place to keep a master key in JS.
//
// Instead we delegate encryption to the hardware-backed Android Keystore via
// expo-secure-store. The `api_keys` row no longer holds ciphertext — it holds a
// REFERENCE id. The real secret lives only in the Keystore under that ref:
//
//   encrypt(secret)            -> generate a fresh ref, store secret in SecretStore
//                                 under ref, return { encrypted: ref, iv: '', authTag: '' }
//   decrypt(ref, iv, authTag)  -> SecretStore.get(ref)  (iv/authTag ignored; throws if missing)
//   maskKey(key)               -> copied verbatim from upstream
//   initEncryptionKey(db)      -> no-op (no master key: the Keystore manages encryption)
//
// The return SHAPE of encrypt() and the SIGNATURES of every export are identical to
// upstream, so the reused router/health/embeddings/keys code persists `encrypted`
// into `encrypted_key`, `iv` into `iv`, `authTag` into `auth_tag`, and later calls
// decrypt(encrypted_key, iv, auth_tag) — all unchanged. iv/authTag are stored as
// empty strings; they are never read back meaningfully here.
//
// UPSTREAM MERGE NOTE: if upstream changes crypto.ts (e.g. adds a key-rotation
// export), mirror the SIGNATURE here but keep the Keystore-ref strategy. Do not
// reintroduce AES-into-SQLite — that would re-create the plaintext-on-device risk
// this shim exists to eliminate.
//
// decrypt() is SYNCHRONOUS on purpose: the upstream router resolves keys
// synchronously while assembling a request (server/src/services/router.ts:649), so
// SecretStore.get() must be synchronous (it is — expo-secure-store getItem).
// ───────────────────────────────────────────────────────────────────────────

import { secretStore } from './secret-store';
import type { BetterSqliteLike } from '../contracts';

// Ref ids are stored in SQLite and used as expo-secure-store keys, which must match
// [A-Za-z0-9._-]. We use a "k_" prefix + 32 url-safe hex chars from a 16-byte random
// draw. expo.SecureStore depends on expo-crypto's randomness; here we use the Web
// Crypto getRandomValues that React Native / Hermes polyfills via expo's runtime.
const REF_PREFIX = 'k_';
const REF_RANDOM_BYTES = 16;

function randomRef(): string {
  const bytes = new Uint8Array(REF_RANDOM_BYTES);
  // crypto.getRandomValues is available in the Expo/RN runtime (and in Node >= 19,
  // which the tsx sanity check below relies on).
  crypto.getRandomValues(bytes);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return REF_PREFIX + hex;
}

/**
 * No-op on mobile. The Android Keystore manages encryption keys in hardware, so
 * there is no master ENCRYPTION_KEY to load or persist. Kept for signature parity
 * with upstream so reused boot/migration code (db/migrations.ts) can call it.
 */
export function initEncryptionKey(_db?: BetterSqliteLike): void {
  // intentionally empty
}

/**
 * "Encrypt" by stashing the secret in the hardware Keystore under a fresh ref.
 * Returns the upstream shape so callers persist the ref into `encrypted_key` and
 * empty strings into `iv` / `auth_tag`.
 */
export function encrypt(text: string): { encrypted: string; iv: string; authTag: string } {
  const ref = randomRef();
  secretStore.put(ref, text);
  return { encrypted: ref, iv: '', authTag: '' };
}

/**
 * "Decrypt" by resolving the ref back to the secret in the Keystore.
 * `iv` and `authTag` are accepted for signature parity but ignored. Throws if the
 * ref is missing so callers' existing try/catch (router skips, keys route shows
 * "[decrypt failed]") behaves exactly as with the upstream GCM failure path.
 */
export function decrypt(encrypted: string, _iv: string, _authTag: string): string {
  const secret = secretStore.get(encrypted);
  if (secret === null) {
    throw new Error(`decrypt: no secret found in Keystore for ref "${encrypted}"`);
  }
  return secret;
}

// Copied VERBATIM from server/src/lib/crypto.ts — keep in sync on upstream merges.
export function maskKey(key: string): string {
  if (key.length <= 8) return '****' + key.slice(-4);
  return key.slice(0, 4) + '...' + key.slice(-4);
}

// Exposed for the deletion path: when an api_keys row is removed, the caller should
// also evict the Keystore entry so secrets don't linger. Not part of upstream
// crypto.ts (which had nothing to clean up), so it's an additive export.
export function forgetSecret(ref: string): void {
  secretStore.delete(ref);
}
