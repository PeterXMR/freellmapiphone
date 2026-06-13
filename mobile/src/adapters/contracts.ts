// Shared adapter contracts. The mobile adapters implement these so the reused
// upstream router/services run unchanged on-device. Parallel agents code against
// THESE interfaces — do not change the signatures without coordinating.

// ── 1. better-sqlite3 facade ──────────────────────────────────────────────
// The upstream router/ratelimit/db code uses a synchronous better-sqlite3
// surface: db.prepare(sql).get(...) / .run(...) / .all(...), plus db.pragma()
// and db.exec(). expo-sqlite exposes matching *sync* methods (prepareSync,
// getFirstSync, getAllSync, runSync, execSync), so a thin facade can emulate it.

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface Statement<Row = unknown> {
  get(...params: unknown[]): Row | undefined;
  all(...params: unknown[]): Row[];
  run(...params: unknown[]): RunResult;
}

export interface BetterSqliteLike {
  prepare<Row = unknown>(sql: string): Statement<Row>;
  exec(sql: string): void;
  pragma(source: string): unknown;
}

// ── 2. Secret store (Android Keystore via expo-secure-store) ──────────────
// API key secrets live here (hardware-encrypted), NOT in plaintext SQLite.
// The SQLite `keys` table stores only a reference id in its encrypted_key
// column; crypto-shim.decrypt() resolves that reference back to the secret.
// All methods are synchronous (expo-secure-store getItem/setItem/deleteItemSync).
// NOTE: Android Keystore values are capped at ~2048 bytes — fine for API keys.

export interface SecretStore {
  put(ref: string, secret: string): void;
  get(ref: string): string | null;
  delete(ref: string): void;
}

// ── 3. Networking ─────────────────────────────────────────────────────────
// React Native's built-in fetch cannot stream response bodies; expo/fetch can.
// The bridge installs expo/fetch as the fetch used by the provider layer.
export type FetchLike = typeof fetch;
