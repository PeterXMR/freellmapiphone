# Node verification suite

These tests prove the **reused upstream logic** the on-device app depends on, by
running the pinned upstream submodule's `server/src` (at `vendor/freellmapi`) +
`mobile/src` code in plain Node — no Android device or Expo install required. They
are the evidence behind the "verified (Node)" markers in
[`MOBILE-PLAN.md`](../../MOBILE-PLAN.md).

> They verify **logic**, not the on-device **runtime**. expo-sqlite,
> expo-secure-store, expo/fetch streaming, and Metro aliasing still need a real
> device build (Phase 5).

## Local-run prerequisite

The test oracle (`better-sqlite3`) is resolved two ways, so install both:

```bash
(cd ../vendor/freellmapi && npm install)   # upstream workspace deps — what the
                                           # router/portability suites' upstream code
                                           # resolves (better-sqlite3, undici, …)
npm install                                # from mobile/: app deps + the better-sqlite3
                                           # devDep the facade/schema suites resolve
```

## Run

From `mobile/`:

```bash
DEV_MODE=true NODE_ENV=test npm run verify:portability
DEV_MODE=true NODE_ENV=test npm run verify:router
DEV_MODE=true NODE_ENV=test npm run verify:facade
DEV_MODE=true NODE_ENV=test npm run verify:schema
npx tsx src/adapters/keystore/crypto-shim.check.mts
```

## What each proves (all against the upstream submodule + mobile/src)

| Test | Proves |
| --- | --- |
| `provider-portability` | providers run on plain `fetch` + the `getReader()` streaming parser works (3/3) |
| `router-fallback` | `resolveRoutingChain('auto')` + `routeRequest` selection, fallover, sticky-pin, 429 demotion/decay, exhaustion → 429 (9/9) — driven exactly as the bridge calls it |
| `facade.contract` | the expo-sqlite facade matches better-sqlite3 semantics (10/10) |
| `schema` | all tables + seed + V1–V25 migrations are valid SQLite, idempotent (65 assertions) |
| `crypto-shim.check` | Keystore-backed `maskKey`/ref/round-trip parity with upstream crypto |
