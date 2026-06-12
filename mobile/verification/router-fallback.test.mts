// Verifies the REUSED upstream router + fallback engine in plain Node.
//
// The mobile app runs this exact code (server/src/services/router.ts) on-device,
// against the expo-sqlite facade (proven byte-equivalent to better-sqlite3 in
// facade.contract.mts). So driving the real router here — with the sibling
// freellmapi repo's installed better-sqlite3 — validates the on-device routing +
// fallback core WITHOUT needing Expo installed.
//
// Run: cd /Users/accountname/Documents/projects/freellmapi && \
//      npx tsx /Users/accountname/Documents/projects/freellmapiphone/mobile/verification/router-fallback.test.mts
process.env.DEV_MODE = 'true';
process.env.NODE_ENV = 'test';

const SRC = '/Users/accountname/Documents/projects/freellmapi/server/src';
const { initDb, getDb } = await import(`${SRC}/db/index.ts`);
const { encrypt } = await import(`${SRC}/lib/crypto.ts`);
const { getProvider } = await import(`${SRC}/providers/index.ts`);
const { routeRequest, recordRateLimitHit, recordSuccess, getAllPenalties } =
  await import(`${SRC}/services/router.ts`);

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? (pass++, console.log('  ok ', m)) : (fail++, console.log('  XX ', m)); };

initDb(':memory:');
const db = getDb();

// Discover the first two DISTINCT, provider-backed platforms in the fallback chain.
const chain = db.prepare(`
  SELECT m.platform AS platform, m.id AS model_db_id, fc.priority AS priority
  FROM models m JOIN fallback_config fc ON fc.model_db_id = m.id
  WHERE m.enabled = 1 AND fc.enabled = 1
  ORDER BY fc.priority ASC
`).all() as Array<{ platform: string; model_db_id: number; priority: number }>;

const platforms: string[] = [];
for (const row of chain) {
  if (getProvider(row.platform as any) && !platforms.includes(row.platform)) platforms.push(row.platform);
  if (platforms.length === 2) break;
}
const [A, B] = platforms;
ok(!!A && !!B && A !== B, `discovered two provider-backed platforms in chain: A=${A}, B=${B}`);

// Insert a real (encrypted) API key for each platform.
const insertKey = (platform: string, secret: string) => {
  const e = encrypt(secret);
  db.prepare(
    "INSERT INTO api_keys (platform, encrypted_key, iv, auth_tag, status, enabled) VALUES (?, ?, ?, ?, 'unknown', 1)"
  ).run(platform, e.encrypted, e.iv, e.authTag);
};
insertKey(A, 'secret-key-for-A');
insertKey(B, 'secret-key-for-B');

// 1. Picks the highest-priority platform that has a usable key.
const r1 = routeRequest(1000);
ok(r1.platform === A, `routes to highest-priority platform with a key (got ${r1.platform})`);
ok(r1.apiKey === 'secret-key-for-A', 'decrypts the stored key correctly');

// 2. Fallover: when A has no usable key, routing moves to the next platform B.
db.prepare('UPDATE api_keys SET enabled = 0 WHERE platform = ?').run(A);
const r2 = routeRequest(1000);
ok(r2.platform === B, `falls over to next platform when A is unavailable (got ${r2.platform})`);

// 3. 429 penalty is recorded, demotes the model, and decays on success.
db.prepare('UPDATE api_keys SET enabled = 1 WHERE platform = ?').run(A); // restore
for (let i = 0; i < 4; i++) recordRateLimitHit(r1.modelDbId);
const penalized = getAllPenalties().find(p => p.modelDbId === r1.modelDbId);
ok(!!penalized && penalized.penalty > 0, `recordRateLimitHit demotes the model (penalty=${penalized?.penalty})`);
const before = penalized!.penalty;
recordSuccess(r1.modelDbId);
const after = getAllPenalties().find(p => p.modelDbId === r1.modelDbId)?.penalty ?? 0;
ok(after < before, `recordSuccess decays the penalty (${before} -> ${after})`);

// 4. Exhaustion: no usable keys anywhere -> throws a 429.
db.prepare('UPDATE api_keys SET enabled = 0').run();
let threw = false, status = 0;
try { routeRequest(1000); } catch (e: any) { threw = true; status = e.status; }
ok(threw && status === 429, `throws 429 when all models are exhausted (threw=${threw}, status=${status})`);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
