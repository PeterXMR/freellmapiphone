// Drop-in replacement for the upstream `server/src/db/index.ts`.
//
// The Metro resolver aliases the upstream `db/index` import to THIS module, so
// the reused router/ratelimit/services code (which does
// `import { getDb, getSetting, setSetting, getUnifiedApiKey,
//          regenerateUnifiedKey, initDb } from '../db/index.js'`)
// runs unchanged on-device. We therefore re-export the SAME names with the SAME
// signatures, backed by the expo-sqlite facade instead of better-sqlite3.
//
// What changes vs. upstream db/index.ts:
//   - The DB is opened with expo-sqlite (openDatabaseSync) and wrapped by
//     createFacade(), not `new Database(path)`.
//   - Schema/migrations come from `../../db/schema` (applySchema) — owned by
//     the schema agent — rather than the upstream migrations module.
//   - The encryption key is initialised by `../keystore/crypto-shim`
//     (initEncryptionKey) which is backed by the hardware Keystore, not a row
//     in plaintext SQLite.
//
// Scope note: this file is import-safe in plain Node ONLY up to the point of
// calling initDb() — initDb pulls in expo-sqlite + the sibling agents' modules.
// getDb()/getSetting()/etc. operate purely on the already-initialised facade
// and have no expo import of their own.

import { createFacade, type SqliteFacade } from './facade';
import type { ExpoSQLiteDatabaseLike } from './facade';

// Sibling-agent modules. These may not exist yet while agents work in parallel;
// the imports are written to the agreed paths so the alias is transparent once
// every piece lands. They are only EVALUATED inside initDb(), never at the top
// level of a consumer that merely needs getDb().
import { applySchema } from '../../db/schema';
import { initEncryptionKey } from '../keystore/crypto-shim';

// expo-sqlite is imported lazily inside initDb so this module stays importable
// in environments without a native build (e.g. the Node verification harness,
// or any consumer that only calls getDb after init has run elsewhere).
type OpenDatabaseSync = (
  name: string,
  options?: { enableChangeListener?: boolean },
) => ExpoSQLiteDatabaseLike;

// Default on-device database filename. expo-sqlite stores this under the app's
// sandboxed SQLite directory; there is no filesystem path to mkdir (unlike the
// server's data/ dir), so initDb takes only an optional name override.
const DEFAULT_DB_NAME = 'freeapi.db';

let db: SqliteFacade | undefined;

/**
 * Returns the initialised facade. Mirrors upstream getDb(): throws if initDb()
 * has not run yet. The reused router/ratelimit code calls this on every request.
 */
export function getDb(): SqliteFacade {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

/**
 * Open the on-device DB, wrap it in the better-sqlite3-shaped facade, apply the
 * schema/migrations, initialise the Keystore-backed encryption key, and return
 * the facade. Mirrors upstream initDb()'s signature and return type.
 *
 * @param dbName optional database filename (default 'freeapi.db'). Replaces the
 *               server's filesystem dbPath; ':memory:' is honoured for tests.
 */
export function initDb(dbName: string = DEFAULT_DB_NAME): SqliteFacade {
  // Lazy require so the module is import-safe without a native build.
  const { openDatabaseSync } = require('expo-sqlite') as {
    openDatabaseSync: OpenDatabaseSync;
  };

  const raw = openDatabaseSync(dbName);
  const facade = createFacade(raw);

  // expo-sqlite opens databases in WAL mode by default and the upstream code
  // also asks for foreign_keys = ON; route both through the facade's pragma so
  // the behaviour matches server/src/db/index.ts.
  facade.pragma('foreign_keys = ON');

  // Schema + migrations (schema agent). Uses facade.exec / facade.prepare /
  // facade.transaction — all provided here.
  applySchema(facade);

  // Hardware-backed encryption key (keystore agent). Upstream seeds an
  // encryption key row inside SQLite; on-device the secret lives in the
  // Keystore and only a reference is persisted.
  initEncryptionKey(facade);

  db = facade;
  return facade;
}

/**
 * Test/teardown helper (not part of the upstream surface). Lets the in-app
 * lifecycle and tests reset module state between DB opens.
 */
export function __resetDbForTests(): void {
  db = undefined;
}

// ── Settings + unified-key accessors (verbatim port of upstream db/index.ts) ──
// These run against the facade and contain no expo/native import, so they are
// identical in behaviour to the server. SQL is preserved exactly (explicit
// column lists, no SELECT *).

export function getUnifiedApiKey(): string {
  const database = getDb();
  const row = database
    .prepare("SELECT value FROM settings WHERE key = 'unified_api_key'")
    .get() as { value: string };
  return row.value;
}

export function regenerateUnifiedKey(): string {
  const database = getDb();
  // Randomness comes from the keystore/crypto shim so we never import Node's
  // `crypto` (absent in React Native). randomKeyHex() returns hex chars.
  const key = `freellmapi-${randomKeyHex(24)}`;
  database
    .prepare("UPDATE settings SET value = ? WHERE key = 'unified_api_key'")
    .run(key);
  return key;
}

// Generic key/value settings accessors (used by routing strategy, etc.).
export function getSetting(key: string): string | undefined {
  const database = getDb();
  const row = database
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  const database = getDb();
  database
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value);
}

// ── Crypto-safe randomness ───────────────────────────────────────────────────
// regenerateUnifiedKey needs cryptographically-strong hex without Node's crypto.
// We source it from the keystore crypto-shim when it exposes randomHex (the
// keystore agent already wraps expo-crypto's getRandomBytes there); otherwise
// fall back to globalThis.crypto.getRandomValues (available in the Hermes/RN
// runtime via expo-crypto's polyfill). Either way: no Node `crypto` import.
function randomKeyHex(byteLen: number): string {
  // Prefer the shim's helper if present (keeps a single randomness source).
  const shim = require('../keystore/crypto-shim') as {
    randomHex?: (n: number) => string;
  };
  if (typeof shim.randomHex === 'function') {
    return shim.randomHex(byteLen);
  }
  const g = globalThis as { crypto?: { getRandomValues?: <T extends ArrayBufferView>(a: T) => T } };
  if (g.crypto?.getRandomValues) {
    const bytes = new Uint8Array(byteLen);
    g.crypto.getRandomValues(bytes);
    let out = '';
    for (const b of bytes) out += b.toString(16).padStart(2, '0');
    return out;
  }
  throw new Error(
    'No CSPRNG available: crypto-shim.randomHex and globalThis.crypto.getRandomValues are both missing.',
  );
}
