/*
 * Verification for mobile/src/db/schema.ts (applySchema).
 *
 * WHAT THIS PROVES (in plain Node, no device):
 *   - applySchema runs end-to-end (createTables + seedModels + every
 *     migrateModels V1–V25 + applyModelPricing + embeddings + quirks +
 *     ensureUnifiedKey + migrateProfilesInit) against a REAL SQLite engine
 *     without throwing, with foreign_keys=ON (the constraint the upstream
 *     delete-before-model ordering depends on).
 *   - Every expected table and the migration-added columns exist with the
 *     EXACT names the reused upstream queries use.
 *   - Seed/migration DATA landed: model rows, fallback_config rows, the
 *     Default profile + profile_models, the unified_api_key, embeddings,
 *     quirks + quirk_targets, and paid pricing.
 *   - It is IDEMPOTENT: a second applySchema on the same DB neither throws
 *     nor changes the model/fallback/quirk/embedding counts.
 *
 * WHY better-sqlite3 directly: applySchema's parameter type is
 * BetterSqliteLike + transaction() — and a real better-sqlite3 Database
 * natively provides prepare/exec/pragma/transaction with exactly those
 * semantics, so it IS the oracle for the facade. (facade.contract.mts
 * separately proves the expo-sqlite facade reproduces this surface.)
 *
 * WHAT THIS DOES NOT PROVE (build-gated, needs a real Android/expo build):
 *   - That expo-sqlite's execSync/prepareSync/withTransactionSync behave
 *     identically to better-sqlite3 (covered by facade.contract.mts's fake,
 *     still device-gated for the real driver).
 *   - That the Keystore-backed initEncryptionKey (called separately by
 *     db-shim, NOT by applySchema) works on-device.
 *
 * RUN:
 *   cd /Users/accountname/Documents/projects/freellmapi && \
 *     npx tsx /Users/accountname/Documents/projects/freellmapiphone/mobile/verification/schema.test.mts
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// better-sqlite3 lives in the SIBLING repo's node_modules. ESM bare-import
// resolution won't cross repos, so require it via a require rooted at the
// sibling's package.json (same approach as facade.contract.mts).
const siblingRequire = createRequire('/Users/accountname/Documents/projects/freellmapi/package.json');
const Database = siblingRequire('better-sqlite3') as typeof import('better-sqlite3');
type DatabaseT = import('better-sqlite3').Database;

import { applySchema } from '../src/db/schema.ts';

let passed = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  assert.ok(cond, `FAIL: ${name}${detail !== undefined ? ` — got ${JSON.stringify(detail)}` : ''}`);
  passed++;
  console.log(`  ok: ${name}`);
}

function tableNames(db: DatabaseT): Set<string> {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
  return new Set(rows.map(r => r.name));
}
function columnNames(db: DatabaseT, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(rows.map(r => r.name));
}
function count(db: DatabaseT, sql: string, ...params: unknown[]): number {
  const row = db.prepare(sql).get(...params) as { c: number };
  return row.c;
}

// ── Run applySchema against a fresh in-memory DB ──────────────────────────────
const db = new Database(':memory:') as DatabaseT;
db.pragma('foreign_keys = ON');

// better-sqlite3 Database structurally satisfies BetterSqliteLike + transaction().
applySchema(db as unknown as Parameters<typeof applySchema>[0]);

// ── Tables ────────────────────────────────────────────────────────────────────
const expectedTables = [
  'models', 'api_keys', 'requests', 'rate_limit_usage', 'rate_limit_cooldowns',
  'fallback_config', 'profiles', 'profile_models', 'settings', 'users',
  'sessions', 'embedding_models', 'quirks', 'quirk_targets',
];
const tables = tableNames(db);
for (const t of expectedTables) check(`table exists: ${t}`, tables.has(t), [...tables]);

// ── Migration-added columns (exact names the reused queries depend on) ────────
const modelCols = columnNames(db, 'models');
for (const c of [
  'platform', 'model_id', 'display_name', 'intelligence_rank', 'speed_rank',
  'size_label', 'rpm_limit', 'rpd_limit', 'tpm_limit', 'tpd_limit',
  'monthly_token_budget', 'context_window', 'enabled',
  'supports_vision',     // V16
  'key_id',              // ensureModelsKeyIdColumn
  'supports_tools',      // V22
  'paid_input_per_m', 'paid_output_per_m', // applyModelPricing
]) check(`models.${c} exists`, modelCols.has(c), [...modelCols]);

const reqCols = columnNames(db, 'requests');
for (const c of ['key_id', 'requested_model', 'ttfb_ms', 'request_type']) {
  check(`requests.${c} exists`, reqCols.has(c), [...reqCols]);
}
check('api_keys.base_url exists', columnNames(db, 'api_keys').has('base_url'));

// ── Seed / migration data ─────────────────────────────────────────────────────
const modelCount = count(db, 'SELECT COUNT(*) c FROM models');
check('models seeded (>40 rows)', modelCount > 40, modelCount);

const fbCount = count(db, 'SELECT COUNT(*) c FROM fallback_config');
check('fallback_config rows == models rows', fbCount === modelCount, { fbCount, modelCount });

// Every model has exactly one fallback row (UNIQUE(model_db_id)) and no orphans.
const orphanFb = count(db, `
  SELECT COUNT(*) c FROM fallback_config f
  LEFT JOIN models m ON m.id = f.model_db_id WHERE m.id IS NULL
`);
check('no orphan fallback_config rows', orphanFb === 0, orphanFb);

// A spot-check of model identity correctness through the migration chain:
// V11 renamed cerebras qwen3-235b → qwen-3-235b-a22b-instruct-2507 (and V14
// disabled it); the old id must be gone.
check(
  'cerebras qwen3-235b renamed (old id absent)',
  count(db, "SELECT COUNT(*) c FROM models WHERE platform='cerebras' AND model_id='qwen3-235b'") === 0,
);
check(
  'cerebras qwen-3-235b-a22b-instruct-2507 present',
  count(db, "SELECT COUNT(*) c FROM models WHERE platform='cerebras' AND model_id='qwen-3-235b-a22b-instruct-2507'") === 1,
);
// V2 reverted GitHub gpt-5 → gpt-4o.
check(
  'github gpt-4o present (gpt-5 reverted)',
  count(db, "SELECT COUNT(*) c FROM models WHERE platform='github' AND model_id='gpt-4o'") === 1,
);
// V23 dropped sambanova entirely.
check(
  'sambanova fully removed (V23)',
  count(db, "SELECT COUNT(*) c FROM models WHERE platform='sambanova'") === 0,
);

// supports_vision / supports_tools were actually set by rules (not all-zero).
check('some models supports_vision=1', count(db, 'SELECT COUNT(*) c FROM models WHERE supports_vision=1') > 0);
check('some models supports_tools=1', count(db, 'SELECT COUNT(*) c FROM models WHERE supports_tools=1') > 0);

// Pricing applied to at least the bulk of mapped models.
check('pricing populated (paid_input_per_m set on many rows)',
  count(db, 'SELECT COUNT(*) c FROM models WHERE paid_input_per_m IS NOT NULL') > 30);

// Unified API key seeded with the right prefix.
const keyRow = db.prepare("SELECT value FROM settings WHERE key='unified_api_key'").get() as { value: string } | undefined;
check('unified_api_key present', !!keyRow);
check('unified_api_key has freellmapi- prefix', !!keyRow && keyRow.value.startsWith('freellmapi-'), keyRow?.value);

// Default profile + its profile_models (seeded from fallback_config).
const defProfile = db.prepare("SELECT id, emoji FROM profiles WHERE type='default'").get() as { id: number; emoji: string } | undefined;
check('Default profile exists', !!defProfile);
check('Default profile emoji is gear', !!defProfile && defProfile.emoji === '⚙️', defProfile?.emoji);
check('active_profile_id setting set',
  !!db.prepare("SELECT value FROM settings WHERE key='active_profile_id'").get());
const pmCount = count(db, 'SELECT COUNT(*) c FROM profile_models WHERE profile_id = ?', defProfile!.id);
check('profile_models seeded from fallback_config', pmCount === fbCount, { pmCount, fbCount });

// Embeddings seeded + default family setting.
check('embedding_models seeded', count(db, 'SELECT COUNT(*) c FROM embedding_models') >= 10);
check('embeddings_default_family set',
  !!db.prepare("SELECT value FROM settings WHERE key='embeddings_default_family'").get());

// Quirks + targets seeded; stale slug removed.
const quirkCount = count(db, 'SELECT COUNT(*) c FROM quirks');
check('quirks seeded', quirkCount >= 11, quirkCount);
check('quirk_targets seeded', count(db, 'SELECT COUNT(*) c FROM quirk_targets') > 0);
check('stale nvidia-credits-based quirk absent',
  count(db, "SELECT COUNT(*) c FROM quirks WHERE slug='nvidia-credits-based'") === 0);
check('nvidia-rate-limited quirk present',
  count(db, "SELECT COUNT(*) c FROM quirks WHERE slug='nvidia-rate-limited'") === 1);

// ── Idempotency: a second run must not throw or change counts ─────────────────
const before = {
  models: modelCount,
  fb: fbCount,
  quirks: quirkCount,
  embeddings: count(db, 'SELECT COUNT(*) c FROM embedding_models'),
  profiles: count(db, 'SELECT COUNT(*) c FROM profiles'),
  qt: count(db, 'SELECT COUNT(*) c FROM quirk_targets'),
};
applySchema(db as unknown as Parameters<typeof applySchema>[0]);
const after = {
  models: count(db, 'SELECT COUNT(*) c FROM models'),
  fb: count(db, 'SELECT COUNT(*) c FROM fallback_config'),
  quirks: count(db, 'SELECT COUNT(*) c FROM quirks'),
  embeddings: count(db, 'SELECT COUNT(*) c FROM embedding_models'),
  profiles: count(db, 'SELECT COUNT(*) c FROM profiles'),
  qt: count(db, 'SELECT COUNT(*) c FROM quirk_targets'),
};
check('idempotent: model count unchanged', before.models === after.models, after);
check('idempotent: fallback_config count unchanged', before.fb === after.fb, after);
check('idempotent: quirks count unchanged', before.quirks === after.quirks, after);
check('idempotent: quirk_targets count unchanged', before.qt === after.qt, after);
check('idempotent: embeddings count unchanged', before.embeddings === after.embeddings, after);
check('idempotent: profiles count unchanged (no duplicate Default)', before.profiles === after.profiles, after);

db.close();
console.log(`\nALL PASSED — ${passed} assertions. models=${modelCount}, fallback=${fbCount}, quirks=${quirkCount}, embeddings=${before.embeddings}.`);
