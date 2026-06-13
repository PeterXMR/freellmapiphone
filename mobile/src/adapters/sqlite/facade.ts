// better-sqlite3 → expo-sqlite facade.
//
// The reused upstream code (server/src/db, server/src/services/router.ts,
// ratelimit.ts) talks to a SYNCHRONOUS better-sqlite3 surface:
//
//   db.prepare(sql).get(...) / .run(...) / .all(...)
//   db.exec(sql)
//   db.pragma(source)
//   db.transaction(fn)            // used by the schema/migrations layer
//
// expo-sqlite exposes a matching *synchronous* surface
// (prepareSync / getFirstSync / getAllSync / runSync / execSync /
// withTransactionSync), so this thin facade re-shapes one onto the other.
//
// Everything here is the small, well-understood translation layer between the
// two libraries. The non-trivial parts — and the gaps that can only be closed
// on a real device — are called out inline with "GAP:" / "VERIFIED:" markers
// and summarised at the bottom of the file.

import type {
  BetterSqliteLike,
  RunResult,
  Statement,
} from '../contracts';

// ── Minimal structural typing for the expo-sqlite surface we consume ─────────
// We deliberately do NOT `import type { SQLiteDatabase } from 'expo-sqlite'`
// here so this module type-checks in plain Node (the verification harness) and
// in the sibling repo where expo-sqlite is not installed. On-device the real
// SQLiteDatabase structurally satisfies this interface. The shapes below mirror
// expo-sqlite's public sync API as of expo-sqlite ~14/15 (SDK 51+).

/** A bound value expo-sqlite accepts for a single parameter slot. */
export type SQLiteBindValue = string | number | bigint | boolean | null | Uint8Array;

/** expo-sqlite's runSync result. */
export interface ExpoRunResult {
  lastInsertRowId: number;
  changes: number;
}

/** expo-sqlite's prepared statement (the sync subset we use). */
export interface ExpoSQLiteStatement {
  executeSync<Row>(params: SQLiteBindParams): ExpoSQLiteExecuteResult<Row>;
  finalizeSync(): void;
}

/**
 * Result of statement.executeSync(). expo-sqlite returns an iterable cursor
 * plus the run-style metadata; we drain/inspect it depending on get/all/run.
 */
export interface ExpoSQLiteExecuteResult<Row> {
  getFirstSync(): Row | null;
  getAllSync(): Row[];
  readonly lastInsertRowId: number;
  readonly changes: number;
  /** Releases the cursor. Always called by the facade after reading. */
  resetSync(): void;
}

/**
 * expo-sqlite accepts EITHER a positional array OR a single object whose keys
 * carry the parameter prefix ($x / :x / @x). This is the central impedance
 * mismatch with better-sqlite3 — see normalizeParams().
 */
export type SQLiteBindParams =
  | SQLiteBindValue[]
  | Record<string, SQLiteBindValue>;

/** The subset of expo-sqlite's SQLiteDatabase we depend on. */
export interface ExpoSQLiteDatabaseLike {
  prepareSync(source: string): ExpoSQLiteStatement;
  execSync(source: string): void;
  getAllSync<Row = Record<string, unknown>>(
    source: string,
    params?: SQLiteBindParams,
  ): Row[];
  withTransactionSync(task: () => void): void;
}

// ── Param normalization ──────────────────────────────────────────────────────
//
// better-sqlite3 call shapes the upstream code uses:
//   stmt.run('a', 'b')                         positional, variadic
//   stmt.get(keyId)                            single positional scalar
//   stmt.run({ slug, title, body, severity, now })   NAMED, BARE keys
//
// better-sqlite3 NAMED semantics: the SQL contains @slug / $slug / :slug, and
// you pass an object whose keys are the BARE names ({ slug: ... }) — NO prefix.
// (VERIFIED against better-sqlite3 in verification/facade.contract.mts.)
//
// expo-sqlite NAMED semantics: you pass an object whose keys INCLUDE the prefix
// that appears in the SQL, e.g. { $slug: ... } or { ':slug': ... }. (Per the
// expo-sqlite docs and runSync signature.) GAP: the two libraries disagree on
// whether the prefix is part of the key. This function bridges that gap.
//
// Strategy: if the single argument is a plain object (the better-sqlite3 named
// form), re-key it for expo-sqlite by re-attaching whichever prefix the SQL
// actually uses for each name. We scan the SQL once for `[$:@]name` tokens and
// map bare name → prefixed key. A bare name appearing under more than one prefix
// in the same SQL would be ambiguous; better-sqlite3 forbids that too, so we
// treat the first prefix seen as authoritative (and the upstream's only named
// statement — the quirks upsert — uses a single consistent prefix, @).

const NAMED_TOKEN_RE = /[$:@]([A-Za-z_][A-Za-z0-9_]*)/g;

function buildNameToPrefixedKey(sql: string): Map<string, string> {
  const map = new Map<string, string>();
  let m: RegExpExecArray | null;
  NAMED_TOKEN_RE.lastIndex = 0;
  while ((m = NAMED_TOKEN_RE.exec(sql)) !== null) {
    const bare = m[1];
    if (!map.has(bare)) {
      // m[0] is the full token including its prefix char, e.g. "@now".
      map.set(bare, m[0]);
    }
  }
  return map;
}

function isPlainParamObject(v: unknown): v is Record<string, SQLiteBindValue> {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    !(v instanceof Uint8Array)
  );
}

/**
 * Translate better-sqlite3 variadic args into the single params value
 * expo-sqlite's executeSync expects.
 */
function normalizeParams(sql: string, params: unknown[]): SQLiteBindParams {
  // Named form: exactly one argument, and it's a plain object.
  if (params.length === 1 && isPlainParamObject(params[0])) {
    const bare = params[0];
    const nameToKey = buildNameToPrefixedKey(sql);
    const out: Record<string, SQLiteBindValue> = {};
    for (const [name, value] of Object.entries(bare)) {
      // Re-attach the prefix the SQL uses for this name. If the name isn't
      // found in the SQL (shouldn't happen for valid calls), pass it through
      // unprefixed so the underlying driver surfaces a clear bind error rather
      // than us silently dropping it.
      const key = nameToKey.get(name) ?? name;
      out[key] = value as SQLiteBindValue;
    }
    return out;
  }

  // Positional form: better-sqlite3 booleans → SQLite has no bool; better-sqlite3
  // actually REJECTS booleans, but upstream never binds one, so we pass values
  // straight through. undefined is not a valid bind value in either library.
  return params as SQLiteBindValue[];
}

// ── lastInsertRowid typing ───────────────────────────────────────────────────
// better-sqlite3's RunResult.lastInsertRowid is `number | bigint` (bigint only
// when the value exceeds 2^53 AND the DB is in bigint mode). expo-sqlite returns
// a plain JS `number` (its `lastInsertRowId`, capital I). GAP: rowids above
// 2^53 lose precision in expo-sqlite — but every upstream table uses
// AUTOINCREMENT INTEGER PRIMARY KEY starting at 1, so this ceiling is
// unreachable in practice. We expose the number directly to match the contract's
// `number | bigint` without forcing bigint.

function toRunResult(r: { lastInsertRowId: number; changes: number }): RunResult {
  return { changes: r.changes, lastInsertRowid: r.lastInsertRowId };
}

// ── Statement wrapper ────────────────────────────────────────────────────────
//
// better-sqlite3 prepares ONCE and lets you call get/run/all many times with
// different params. expo-sqlite's prepared statement is re-executable too
// (executeSync per call), so we prepare lazily-but-once and re-execute. Each
// executeSync yields a cursor we must reset() after reading to free it.

class FacadeStatement<Row> implements Statement<Row> {
  constructor(
    private readonly db: ExpoSQLiteDatabaseLike,
    private readonly sql: string,
  ) {}

  private exec(params: unknown[]): ExpoSQLiteExecuteResult<Row> {
    const stmt = this.db.prepareSync(this.sql);
    // We finalize per-call. better-sqlite3 keeps one compiled statement for the
    // life of the object; expo-sqlite statements are cheap to (re)prepare and
    // finalizing per call avoids leaking native cursors across React-Native's
    // JS/native boundary. Correctness-equivalent for our usage; see GAP note.
    try {
      return stmt.executeSync<Row>(normalizeParams(this.sql, params));
    } finally {
      // executeSync's result holds the cursor; finalize the statement only
      // after the caller has drained it. We therefore finalize in the public
      // methods below, not here. (Kept structurally simple: see get/all/run.)
    }
  }

  get(...params: unknown[]): Row | undefined {
    const stmt = this.db.prepareSync(this.sql);
    try {
      const res = stmt.executeSync<Row>(normalizeParams(this.sql, params));
      const row = res.getFirstSync();
      res.resetSync();
      // better-sqlite3 returns `undefined` (not null) when no row matches.
      return row == null ? undefined : row;
    } finally {
      stmt.finalizeSync();
    }
  }

  all(...params: unknown[]): Row[] {
    const stmt = this.db.prepareSync(this.sql);
    try {
      const res = stmt.executeSync<Row>(normalizeParams(this.sql, params));
      const rows = res.getAllSync();
      res.resetSync();
      return rows;
    } finally {
      stmt.finalizeSync();
    }
  }

  run(...params: unknown[]): RunResult {
    const stmt = this.db.prepareSync(this.sql);
    try {
      const res = stmt.executeSync<Row>(normalizeParams(this.sql, params));
      // For a write, the metadata lives on the execute result. Draining it
      // (getAllSync) is unnecessary; resetSync releases the cursor.
      const out = toRunResult({
        lastInsertRowId: res.lastInsertRowId,
        changes: res.changes,
      });
      res.resetSync();
      return out;
    } finally {
      stmt.finalizeSync();
    }
  }
}

// ── pragma() ─────────────────────────────────────────────────────────────────
//
// better-sqlite3's pragma() is multi-shape:
//   db.pragma('foreign_keys = ON')      → side-effecting, returns []
//   db.pragma('journal_mode = WAL')     → returns [{ journal_mode: 'wal' }]
//   db.pragma('table_info(requests)')   → returns array of column-info rows
//
// The upstream code uses it three ways:
//   db.pragma('journal_mode = WAL')   (db/index.ts — NON-memory only)
//   db.pragma('foreign_keys = ON')    (db/index.ts)
//   db.prepare('PRAGMA table_info(...)').all()  (migrations — via prepare, not
//                                                pragma(); handled by .all())
//
// expo-sqlite has no pragma() method, but `PRAGMA ...` is just SQL. A
// value-returning pragma (journal_mode=WAL, table_info) is a query → getAllSync;
// a pure-setter pragma (foreign_keys=ON) returns no rows → still safe via
// getAllSync, which yields []. better-sqlite3 returns an ARRAY of row objects,
// so getAllSync matches that shape. (VERIFIED shape against better-sqlite3.)
//
// NOTE: expo-sqlite recommends enabling foreign_keys / WAL at open time via
// SQLiteDatabase options; running them as PRAGMA SQL also works and keeps the
// upstream db/index.ts code path unchanged. WAL on-device: expo-sqlite opens
// WAL by default, so this is effectively a no-op confirmation there.

function facadePragma(db: ExpoSQLiteDatabaseLike, source: string): unknown {
  const trimmed = source.trim();
  const sql = /^pragma\b/i.test(trimmed) ? trimmed : `PRAGMA ${trimmed}`;
  // getAllSync returns [] for setter pragmas and the row(s) for query pragmas,
  // mirroring better-sqlite3's return convention.
  return db.getAllSync(sql);
}

// ── transaction() ────────────────────────────────────────────────────────────
//
// NOT part of the BetterSqliteLike contract interface, but the upstream
// schema/migrations layer (server/src/db/migrations.ts) calls
// `db.transaction(fn)` heavily, and applySchema (written by the schema agent)
// re-uses that exact code. To keep this facade a TRUE drop-in for
// better-sqlite3 we expose transaction() as an extension.
//
// better-sqlite3 semantics we must preserve:
//   - transaction(fn) returns a CALLABLE wrapper; calling it runs fn inside
//     BEGIN/COMMIT (ROLLBACK on throw) and RETURNS fn's return value.
//   - The wrapper forwards its arguments to fn.
//   - Nested wrapper calls use SAVEPOINTs (no "cannot start a transaction
//     within a transaction" error). (VERIFIED in the harness.)
//
// expo-sqlite gives us withTransactionSync(task): runs task in BEGIN/COMMIT,
// ROLLBACK on throw, but task takes no args and returns void, and it does NOT
// auto-savepoint when already inside a transaction.
//
// GAP: nesting. We track depth ourselves: the outermost call uses
// withTransactionSync; an inner call (already inside one) just runs fn directly,
// relying on the outer BEGIN/COMMIT. This matches better-sqlite3's observable
// behavior for the upstream's pattern (migrations wrap several inner
// transactions inside an outer one) — atomicity is preserved because the outer
// transaction still rolls back everything on a throw. It does NOT replicate
// true SAVEPOINT partial-rollback, which the upstream never relies on.
//   GATE: only the no-partial-rollback nesting path is proven by reasoning +
//   the better-sqlite3 oracle; the on-device withTransactionSync wiring itself
//   is build-gated.

interface TransactionFn<A extends unknown[], R> {
  (...args: A): R;
}

function makeTransactionFactory(db: ExpoSQLiteDatabaseLike) {
  // Module-instance depth flag, scoped to this facade/db.
  const depth = { n: 0 };

  return function transaction<A extends unknown[], R>(
    fn: TransactionFn<A, R>,
  ): TransactionFn<A, R> {
    return function wrapped(...args: A): R {
      if (depth.n > 0) {
        // Already inside an outer transaction → just run inline.
        return fn(...args);
      }
      let result!: R;
      depth.n++;
      try {
        db.withTransactionSync(() => {
          result = fn(...args);
        });
      } finally {
        depth.n--;
      }
      return result;
    };
  };
}

// ── Facade type ──────────────────────────────────────────────────────────────
// BetterSqliteLike + the transaction() extension the schema layer needs.
export interface SqliteFacade extends BetterSqliteLike {
  transaction<A extends unknown[], R>(
    fn: (...args: A) => R,
  ): (...args: A) => R;
}

/**
 * Wrap an expo-sqlite database in a synchronous better-sqlite3-shaped facade.
 *
 * @param db an expo-sqlite SQLiteDatabase (or any object structurally matching
 *           ExpoSQLiteDatabaseLike — see the verification harness's fake).
 */
export function createFacade(db: ExpoSQLiteDatabaseLike): SqliteFacade {
  const transaction = makeTransactionFactory(db);
  return {
    prepare<Row = unknown>(sql: string): Statement<Row> {
      return new FacadeStatement<Row>(db, sql);
    },
    exec(sql: string): void {
      db.execSync(sql);
    },
    pragma(source: string): unknown {
      return facadePragma(db, source);
    },
    transaction,
  };
}

/*
 * ── SEMANTIC GAPS: better-sqlite3 vs expo-sqlite (summary) ───────────────────
 *
 * 1. NAMED PARAM KEY SHAPE  (handled — normalizeParams)
 *    better-sqlite3: object keys are BARE  ({ slug })   for SQL @slug/$slug/:slug
 *    expo-sqlite:    object keys are PREFIXED ({ '@slug' })
 *    → We rewrite bare keys to the prefix the SQL actually uses.
 *
 * 2. lastInsertRowid TYPE  (handled — toRunResult)
 *    better-sqlite3: number | bigint (bigint only > 2^53 in bigint mode)
 *    expo-sqlite:    number (capital-I `lastInsertRowId`)
 *    → We expose the number. Unreachable ceiling for the upstream's
 *      AUTOINCREMENT-from-1 schema.
 *
 * 3. NO-ROW RETURN  (handled — get)
 *    better-sqlite3 .get() → undefined ; expo-sqlite getFirstSync → null.
 *    → We coerce null → undefined so upstream `row?.value` / `as X | undefined`
 *      checks behave identically.
 *
 * 4. pragma()  (handled — facadePragma)
 *    better-sqlite3 has db.pragma(); expo-sqlite does not. PRAGMA is plain SQL.
 *    → getAllSync returns [] for setters and rows for queries, matching
 *      better-sqlite3's array convention.
 *
 * 5. transaction() nesting  (partially handled — makeTransactionFactory)
 *    better-sqlite3 nests via SAVEPOINT; expo-sqlite's withTransactionSync does
 *    not. We flatten nested calls into the outer transaction. Atomicity holds
 *    (outer rollback covers all); true partial SAVEPOINT rollback is NOT
 *    replicated. Upstream never relies on partial rollback.
 *
 * PROVEN IN NODE (verification/facade.contract.mts): the param-normalization
 * LOGIC and the expected get/run/all/transaction RESULTS, using real
 * better-sqlite3 as the oracle and a tiny in-memory fake of the expo-sqlite
 * surface that delegates to better-sqlite3.
 *
 * BUILD-GATED (needs a real Android/expo build): that expo-sqlite's actual
 * prepareSync/executeSync/getFirstSync/getAllSync/runSync/withTransactionSync
 * behave as documented and as our fake assumes. This file imports NO expo
 * module at module load, so it is import-safe to unit-test in Node.
 */
