// Verifies the REUSED router + fallback engine in plain Node — against the
// pinned upstream submodule's server/src at vendor/freellmapi (the exact code
// the on-device bridge reuses), NOT a sibling checkout, which may sit on a
// different branch with a different routeRequest signature.
//
// Local-run prerequisite: the upstream workspace deps (better-sqlite3 + the
// rest) come from `npm install` inside vendor/freellmapi; tsx comes from mobile's
// own devDeps. Run from mobile/:
//   (cd ../vendor/freellmapi && npm install)   # once — installs the oracle
//   DEV_MODE=true NODE_ENV=test npm run verify:router
process.env.DEV_MODE = 'true';
process.env.NODE_ENV = 'test';

// The pinned upstream submodule's server/src (vendor/freellmapi, two levels up
// from mobile/verification/).
const SRC = new URL('../../vendor/freellmapi/server/src', import.meta.url).pathname;
const { initDb, getDb } = await import(`${SRC}/db/index.ts`);
const { encrypt } = await import(`${SRC}/lib/crypto.ts`);
const { getProvider } = await import(`${SRC}/providers/index.ts`);
const { routeRequest, resolveRoutingChain, recordRateLimitHit, recordSuccess, getAllPenalties } =
  await import(`${SRC}/services/router.ts`);

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? (pass++, console.log('  ok ', m)) : (fail++, console.log('  XX ', m)); };

initDb(':memory:');
const db = getDb();

// Resolve the 'auto' routing chain exactly as the on-device bridge does, then
// discover the first two DISTINCT provider-backed platforms IN THAT CHAIN.
const resolved = resolveRoutingChain('auto');
const chainRows = resolved.chain as Array<{ model_db_id: number; platform: string }>;
ok(Array.isArray(chainRows) && chainRows.length > 0, `resolveRoutingChain('auto') returns a chain (${chainRows.length} models)`);

const platforms: string[] = [];
const modelByPlatform = new Map<string, number>();
for (const row of chainRows) {
  if (!getProvider(row.platform as any)) continue;
  if (!platforms.includes(row.platform)) { platforms.push(row.platform); modelByPlatform.set(row.platform, row.model_db_id); }
  if (platforms.length === 2) break;
}
const [A, B] = platforms;
ok(!!A && !!B && A !== B, `discovered two provider-backed platforms in the auto chain: A=${A}, B=${B}`);

// Insert a real (encrypted) API key for each platform.
const insertKey = (platform: string) => {
  const e = encrypt(`secret-${platform}`);
  db.prepare(
    "INSERT INTO api_keys (platform, encrypted_key, iv, auth_tag, status, enabled) VALUES (?, ?, ?, ?, 'unknown', 1)"
  ).run(platform, e.encrypted, e.iv, e.authTag);
};
insertKey(A);
insertKey(B);

// Call routeRequest the SAME way the bridge does — with the resolved chain.
const route = (skipKeys?: Set<string>, preferred?: number, skipModels?: Set<number>) =>
  routeRequest(1000, skipKeys, preferred, false, false, skipModels, resolved.chain);

// 1. Selection: returns one of the two keyed platforms, with a correctly decrypted key.
const r1 = route();
ok(r1.platform === A || r1.platform === B, `routes to a keyed platform from the chain (got ${r1.platform})`);
ok(r1.apiKey === `secret-${r1.platform}`, 'decrypts the stored key for the chosen platform');

// 2. Fallover: disable the chosen platform's key -> routing moves to the other keyed platform.
const other = r1.platform === A ? B : A;
db.prepare('UPDATE api_keys SET enabled = 0 WHERE platform = ?').run(r1.platform);
const r2 = route();
ok(r2.platform === other, `falls over to the other platform when one is unavailable (got ${r2.platform})`);
db.prepare('UPDATE api_keys SET enabled = 1 WHERE platform = ?').run(r1.platform); // restore

// 3. Explicit pin: preferredModelDbId forces a specific model to the front (sticky session).
const pinModel = modelByPlatform.get(B)!;
const r3 = route(undefined, pinModel);
ok(r3.modelDbId === pinModel && r3.platform === B, `pinning preferredModelDbId routes to that model (got dbId=${r3.modelDbId}, platform=${r3.platform})`);

// 4. 429 penalty is recorded, demotes the model, and decays on success.
for (let i = 0; i < 4; i++) recordRateLimitHit(r1.modelDbId);
const penalized = getAllPenalties().find(p => p.modelDbId === r1.modelDbId);
ok(!!penalized && penalized.penalty > 0, `recordRateLimitHit demotes the model (penalty=${penalized?.penalty})`);
const before = penalized!.penalty;
recordSuccess(r1.modelDbId);
const after = getAllPenalties().find(p => p.modelDbId === r1.modelDbId)?.penalty ?? 0;
ok(after < before, `recordSuccess decays the penalty (${before} -> ${after})`);

// 5. Exhaustion: no usable keys anywhere -> throws a 429.
db.prepare('UPDATE api_keys SET enabled = 0').run();
let threw = false, status = 0;
try { route(); } catch (e: any) { threw = true; status = e.status; }
ok(threw && status === 429, `throws 429 when all models are exhausted (threw=${threw}, status=${status})`);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
