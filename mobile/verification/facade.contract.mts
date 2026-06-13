/*
 * Contract verification for the better-sqlite3 → expo-sqlite facade.
 *
 * WHAT THIS PROVES (in plain Node, no device):
 *   - The param-normalization LOGIC of facade.ts: positional binding, single
 *     scalar, and the better-sqlite3 BARE-key named form (@x/$x/:x) being
 *     rewritten to expo-sqlite's PREFIXED-key form.
 *   - The shape of .get() (row | undefined), .all() (array), .run()
 *     ({ changes, lastInsertRowid }), pragma() (array), and transaction()
 *     (callable wrapper returning fn's value, nesting flattened).
 *
 * HOW: we build a tiny FAKE of the expo-sqlite SYNC surface
 * (ExpoSQLiteDatabaseLike) that delegates to a REAL better-sqlite3 database.
 * The fake reproduces expo-sqlite's *documented* conventions that DIFFER from
 * better-sqlite3 — specifically: getFirstSync returns null (not undefined) and
 * named params use PREFIXED keys ({ '@x': ... }). Because the fake imposes
 * those expo conventions, any place the facade fails to translate would surface
 * here as a binding error or a null/undefined mismatch.
 *
 * Then we run the SAME queries through better-sqlite3 DIRECTLY (the oracle) and
 * assert the facade's outputs equal the oracle's.
 *
 * WHAT THIS DOES NOT PROVE (build-gated, needs a real Android/expo build):
 *   - That expo-sqlite's real prepareSync/executeSync/getFirstSync/getAllSync/
 *     withTransactionSync behave exactly like this fake. The fake encodes the
 *     documented contract; only an on-device run confirms the implementation.
 *
 * RUN:
 *   cd /Users/accountname/Documents/projects/freellmapi && \
 *     npx tsx /Users/accountname/Documents/projects/freellmapiphone/mobile/verification/facade.contract.mts
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// better-sqlite3 lives in the SIBLING repo's node_modules, not the phone repo.
// ESM bare-import resolution won't reach across repos (and NODE_PATH doesn't
// apply to ESM), so resolve it explicitly via a require rooted at the sibling.
// This keeps the documented run command working unchanged:
//   cd /Users/accountname/Documents/projects/freellmapi && npx tsx <this file>
const siblingRequire = createRequire('/Users/accountname/Documents/projects/freellmapi/package.json');
const Database = siblingRequire('better-sqlite3') as typeof import('better-sqlite3');
type Database = import('better-sqlite3').Database;
import { createFacade } from '../src/adapters/sqlite/facade.ts';
import type {
  ExpoSQLiteDatabaseLike,
  ExpoSQLiteStatement,
  ExpoSQLiteExecuteResult,
  SQLiteBindParams,
} from '../src/adapters/sqlite/facade.ts';

// ── A fake of the expo-sqlite SYNC surface, backed by real better-sqlite3. ───
// It enforces the expo conventions that DIFFER from better-sqlite3 so the
// facade's translation is actually exercised:
//   * named params must arrive PREFIXED ({ '@x': v }); a bare key would throw.
//   * getFirstSync returns null when there is no row.
function makeFakeExpoDb(real: Database): ExpoSQLiteDatabaseLike {
  // Convert expo-style params into what better-sqlite3 expects, asserting the
  // facade handed us the expo convention (prefixed keys / positional array).
  function toBetterSqliteArgs(params: SQLiteBindParams | undefined): unknown[] {
    if (params === undefined) return [];
    if (Array.isArray(params)) return params;
    // Object form: the facade MUST have produced PREFIXED keys for the expo API.
    const bare: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) {
      assert.ok(
        /^[$:@]/.test(k),
        `expo-sqlite fake expected a PREFIXED named-param key, got bare "${k}". ` +
          `facade.normalizeParams failed to translate better-sqlite3's bare keys.`,
      );
      bare[k.slice(1)] = v; // better-sqlite3 wants the bare name back.
    }
    return [bare];
  }

  function makeStatement(source: string): ExpoSQLiteStatement {
    return {
      executeSync<Row>(params: SQLiteBindParams): ExpoSQLiteExecuteResult<Row> {
        const stmt = real.prepare(source);
        const args = toBetterSqliteArgs(params);
        const isSelect = /^\s*(select|pragma|with)\b/i.test(source);
        let cachedRows: Row[] | null = null;
        let runInfo: { lastInsertRowId: number; changes: number } | null = null;

        const ensureRead = (): Row[] => {
          if (cachedRows === null) cachedRows = stmt.all(...(args as [])) as Row[];
          return cachedRows;
        };
        const ensureRun = () => {
          if (runInfo === null) {
            const r = stmt.run(...(args as []));
            runInfo = {
              lastInsertRowId: Number(r.lastInsertRowid),
              changes: r.changes,
            };
          }
          return runInfo;
        };

        return {
          getFirstSync(): Row | null {
            const rows = ensureRead();
            // expo convention: null (NOT undefined) when empty.
            return rows.length > 0 ? rows[0] : null;
          },
          getAllSync(): Row[] {
            return ensureRead();
          },
          get lastInsertRowId(): number {
            return ensureRun().lastInsertRowId;
          },
          get changes(): number {
            return ensureRun().changes;
          },
          resetSync(): void {
            /* no-op for the fake */
          },
        };
      },
      finalizeSync(): void {
        /* no-op for the fake */
      },
    };
  }

  return {
    prepareSync(source: string): ExpoSQLiteStatement {
      return makeStatement(source);
    },
    execSync(source: string): void {
      real.exec(source);
    },
    getAllSync<Row = Record<string, unknown>>(
      source: string,
      params?: SQLiteBindParams,
    ): Row[] {
      const stmt = real.prepare(source);
      const args = toBetterSqliteArgs(params);
      // better-sqlite3 forbids .all() on a statement that returns no columns
      // (e.g. PRAGMA foreign_keys = ON). Detect and fall back to run().
      try {
        return stmt.all(...(args as [])) as Row[];
      } catch (e) {
        if (e instanceof Error && /does not return data/i.test(e.message)) {
          stmt.run(...(args as []));
          return [] as Row[];
        }
        throw e;
      }
    },
    withTransactionSync(task: () => void): void {
      real.transaction(task)();
    },
  };
}

// ── Test harness ─────────────────────────────────────────────────────────────
let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

function freshPair() {
  // Two independent DBs: one driven through the facade (via the fake), one used
  // directly as the better-sqlite3 oracle. Same schema, same operations.
  const facadeReal = new Database(':memory:');
  const oracle = new Database(':memory:');
  const ddl = `
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE quirks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE, title TEXT, body TEXT, severity TEXT,
      created_at_ms INTEGER, updated_at_ms INTEGER
    );
    CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, k TEXT, v TEXT);
  `;
  facadeReal.exec(ddl);
  oracle.exec(ddl);
  const facade = createFacade(makeFakeExpoDb(facadeReal));
  return { facade, oracle };
}

console.log('facade contract verification (oracle = better-sqlite3)\n');

// 1. Positional .run() → { changes, lastInsertRowid }; matches oracle.
check('positional run() result matches better-sqlite3', () => {
  const { facade, oracle } = freshPair();
  const fr = facade.prepare('INSERT INTO t (k, v) VALUES (?, ?)').run('a', '1');
  const or = oracle.prepare('INSERT INTO t (k, v) VALUES (?, ?)').run('a', '1');
  assert.equal(fr.changes, or.changes);
  assert.equal(Number(fr.lastInsertRowid), Number(or.lastInsertRowid));
  assert.equal(fr.changes, 1);
  assert.equal(Number(fr.lastInsertRowid), 1);
});

// 2. .get() returns the row, and undefined (NOT null) on a miss.
check('get() returns row, and undefined on no match', () => {
  const { facade, oracle } = freshPair();
  facade.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('k', 'v');
  oracle.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('k', 'v');

  const fHit = facade.prepare('SELECT value FROM settings WHERE key = ?').get('k');
  const oHit = oracle.prepare('SELECT value FROM settings WHERE key = ?').get('k');
  assert.deepEqual(fHit, oHit);
  assert.deepEqual(fHit, { value: 'v' });

  const fMiss = facade.prepare('SELECT value FROM settings WHERE key = ?').get('nope');
  const oMiss = oracle.prepare('SELECT value FROM settings WHERE key = ?').get('nope');
  assert.equal(fMiss, undefined);
  assert.equal(oMiss, undefined);
  // Critical: the fake's expo layer returned null; facade must coerce to undefined.
  assert.strictEqual(fMiss, undefined);
});

// 3. .all() returns an array of rows; matches oracle.
check('all() returns row array matching better-sqlite3', () => {
  const { facade, oracle } = freshPair();
  for (const [k, v] of [['a', '1'], ['b', '2'], ['c', '3']] as const) {
    facade.prepare('INSERT INTO t (k, v) VALUES (?, ?)').run(k, v);
    oracle.prepare('INSERT INTO t (k, v) VALUES (?, ?)').run(k, v);
  }
  const fa = facade.prepare('SELECT k, v FROM t ORDER BY id').all();
  const oa = oracle.prepare('SELECT k, v FROM t ORDER BY id').all();
  assert.deepEqual(fa, oa);
  assert.equal(fa.length, 3);
});

// 4. NAMED params, BARE keys (the upstream quirks-upsert pattern), with @now
//    referenced TWICE in the SQL but only once in the object.
check('named params (@x bare keys) bind like better-sqlite3', () => {
  const { facade, oracle } = freshPair();
  const SQL = `
    INSERT INTO quirks (slug, title, body, severity, created_at_ms, updated_at_ms)
    VALUES (@slug, @title, @body, @severity, @now, @now)
    ON CONFLICT(slug) DO UPDATE SET title = excluded.title, updated_at_ms = excluded.updated_at_ms
  `;
  const params = { slug: 's1', title: 'T', body: 'B', severity: 'info', now: 12345 };
  facade.prepare(SQL).run(params);
  oracle.prepare(SQL).run(params);

  const fRow = facade.prepare('SELECT slug, title, body, severity, created_at_ms, updated_at_ms FROM quirks WHERE slug = ?').get('s1');
  const oRow = oracle.prepare('SELECT slug, title, body, severity, created_at_ms, updated_at_ms FROM quirks WHERE slug = ?').get('s1');
  assert.deepEqual(fRow, oRow);
  assert.deepEqual(fRow, {
    slug: 's1', title: 'T', body: 'B', severity: 'info',
    created_at_ms: 12345, updated_at_ms: 12345,
  });
});

// 5. Named params with the OTHER prefixes ($x and :x) also normalize.
check('named params with $x and :x prefixes normalize', () => {
  const { facade } = freshPair();
  facade.prepare('INSERT INTO settings (key, value) VALUES ($key, $val)').run({ key: 'dollar', val: 'D' });
  facade.prepare('INSERT INTO settings (key, value) VALUES (:key, :val)').run({ key: 'colon', val: 'C' });
  assert.deepEqual(facade.prepare('SELECT value FROM settings WHERE key = ?').get('dollar'), { value: 'D' });
  assert.deepEqual(facade.prepare('SELECT value FROM settings WHERE key = ?').get('colon'), { value: 'C' });
});

// 6. ON CONFLICT upsert via setSetting-style SQL returns changes and updates.
check('upsert (INSERT ... ON CONFLICT DO UPDATE) works through facade', () => {
  const { facade } = freshPair();
  const upsert = (k: string, v: string) =>
    facade.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(k, v);
  upsert('s', 'first');
  upsert('s', 'second');
  assert.deepEqual(facade.prepare('SELECT value FROM settings WHERE key = ?').get('s'), { value: 'second' });
});

// 7. pragma() returns an array (matching better-sqlite3's convention).
check('pragma() returns an array', () => {
  const { facade } = freshPair();
  const setter = facade.pragma('foreign_keys = ON');   // setter → []
  assert.ok(Array.isArray(setter));
  const tableInfo = facade.pragma('table_info(settings)'); // query → rows
  assert.ok(Array.isArray(tableInfo));
  assert.ok((tableInfo as unknown[]).length >= 2);
});

// 8. transaction(): callable wrapper, forwards args, returns fn's value, commits.
check('transaction() commits and returns fn value', () => {
  const { facade } = freshPair();
  const insertMany = facade.transaction((rows: string[]) => {
    for (const r of rows) facade.prepare('INSERT INTO t (k, v) VALUES (?, ?)').run(r, r);
    return rows.length;
  });
  const n = insertMany(['x', 'y', 'z']);
  assert.equal(n, 3);
  assert.equal((facade.prepare('SELECT COUNT(*) AS c FROM t').get() as { c: number }).c, 3);
});

// 9. transaction(): rolls back on throw.
check('transaction() rolls back on throw', () => {
  const { facade } = freshPair();
  const boom = facade.transaction(() => {
    facade.prepare('INSERT INTO t (k, v) VALUES (?, ?)').run('a', 'a');
    throw new Error('boom');
  });
  assert.throws(() => boom(), /boom/);
  assert.equal((facade.prepare('SELECT COUNT(*) AS c FROM t').get() as { c: number }).c, 0);
});

// 10. Nested transaction(): inner call flattens into outer; outer rollback
//     reverts everything (atomicity preserved, matching upstream's reliance).
check('nested transaction() flattens and stays atomic', () => {
  const { facade } = freshPair();
  const inner = facade.transaction((tag: string) => {
    facade.prepare('INSERT INTO t (k, v) VALUES (?, ?)').run(tag, tag);
  });
  const outerOk = facade.transaction(() => { inner('a'); inner('b'); });
  outerOk();
  assert.equal((facade.prepare('SELECT COUNT(*) AS c FROM t').get() as { c: number }).c, 2);

  const outerFail = facade.transaction(() => { inner('c'); throw new Error('x'); });
  assert.throws(() => outerFail(), /x/);
  // 'c' must NOT survive — outer rollback covers the flattened inner write.
  assert.equal((facade.prepare('SELECT COUNT(*) AS c FROM t').get() as { c: number }).c, 2);
});

console.log(`\nAll ${passed} facade contract checks passed.`);
