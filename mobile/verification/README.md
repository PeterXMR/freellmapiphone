# Node verification suite

These tests prove the **reused upstream logic** the on-device app depends on, by
running this repo's *own* vendored `server/src` + `mobile/src` code in plain Node —
no Android device or Expo install required. They are the evidence behind the
"verified (Node)" markers in [`MOBILE-PLAN.md`](../../MOBILE-PLAN.md).

> They verify **logic**, not the on-device **runtime**. expo-sqlite,
> expo-secure-store, expo/fetch streaming, and Metro aliasing still need a real
> device build (Phase 5).

## Local-run prerequisite

Until `npm install` succeeds in this repo, borrow the native `better-sqlite3`
(ABI-matched) and `tsx` from a sibling `freellmapi` checkout via a **gitignored**
symlink at the repo root:

```bash
ln -sfn ../freellmapi/node_modules ./node_modules
```

(Once this repo can `npm install` on a working network, delete the symlink and
install normally — the tests are unchanged.)

## Run

```bash
DEV_MODE=true NODE_ENV=test npx tsx mobile/verification/provider-portability.test.mts
DEV_MODE=true NODE_ENV=test npx tsx mobile/verification/router-fallback.test.mts
DEV_MODE=true NODE_ENV=test npx tsx mobile/verification/facade.contract.mts
DEV_MODE=true NODE_ENV=test npx tsx mobile/verification/schema.test.mts
npx tsx mobile/src/adapters/keystore/crypto-shim.check.mts
```

## What each proves (all against this repo's own code)

| Test | Proves |
| --- | --- |
| `provider-portability` | providers run on plain `fetch` + the `getReader()` streaming parser works (3/3) |
| `router-fallback` | `resolveRoutingChain('auto')` + `routeRequest` selection, fallover, sticky-pin, 429 demotion/decay, exhaustion → 429 (9/9) — driven exactly as the bridge calls it |
| `facade.contract` | the expo-sqlite facade matches better-sqlite3 semantics (10/10) |
| `schema` | all tables + seed + V1–V25 migrations are valid SQLite, idempotent (65 assertions) |
| `crypto-shim.check` | Keystore-backed `maskKey`/ref/round-trip parity with upstream crypto |
