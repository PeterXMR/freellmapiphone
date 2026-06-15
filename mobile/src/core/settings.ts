// Tiny key/value settings store over the reused `settings` table
// (key TEXT PRIMARY KEY, value TEXT). Upstream ships getSetting/setSetting in
// server/src/db/index.ts, but that module is Metro-aliased away to the sqlite
// facade on device, so we provide a local equivalent that talks to the facade
// directly.
//
// Both calls are defensive: db.init() is idempotent, and a failure (DB not yet
// migrated, disk error) degrades to "no stored value" / a logged warning rather
// than crashing a UI that reads a preference during early startup.

import { db } from './bridge';
import { getDb } from '../adapters/sqlite/db-shim';

export function getSetting(key: string): string | undefined {
  try {
    db.init();
    const row = getDb()
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row?.value;
  } catch {
    return undefined;
  }
}

export function setSetting(key: string, value: string): void {
  try {
    db.init();
    getDb()
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  } catch (err) {
    console.warn(`setSetting(${key}) failed:`, err);
  }
}
