# MOBILE.md — the adapter seams (read this before bumping the upstream submodule)

This repo ships an Android app (`mobile/`) built **on top of** the
[tashfeenahmed/freellmapi](https://github.com/tashfeenahmed/freellmapi)
provider/router core. That core is consumed as a **pinned git submodule** at
[`vendor/freellmapi`](vendor/freellmapi), and **no upstream file is ever edited** —
see [`MOBILE-PLAN.md`](MOBILE-PLAN.md) for the architecture and why.

That cleanliness has a cost: the app depends on upstream through a handful of
**seams** (Metro aliases, a global-`fetch` override, a SQLite facade) that are
invisible in a normal diff. If an upstream change moves a file or shifts a
contract a seam relies on, nothing in the upstream diff looks wrong — the app
just breaks at bundle time or on device. **This file is the map of those seams,
and the CI that guards them.**

> New to the app? Build/sign/install lives in [`mobile/docs/BUILD.md`](mobile/docs/BUILD.md);
> the Node proofs behind each seam live in [`mobile/verification/`](mobile/verification/README.md).

## Upstream source — the pinned submodule

The reused upstream code (`server/src` providers + router, `shared` types) lives
ONLY in the git submodule at [`vendor/freellmapi`](vendor/freellmapi), pinned to a
specific commit (currently `2f04a63` — `v0.3.0+55`). The repo root holds just the
fork: `mobile/`, this doc, and CI. Metro and the Node suites resolve all upstream
code from the submodule (see [seams](#adapter-seams) and [runbook](#update-runbook)).

Clone or refresh with the submodule:

```bash
git clone --recurse-submodules https://github.com/PeterXMR/freellmapiphone.git
# already cloned:
git submodule update --init vendor/freellmapi
```

## Update runbook

Upstream updates are **submodule pin bumps**, not tree merges. To move to a newer
upstream release and verify the seams still hold:

```bash
# Bump the pin to a chosen upstream release tag (e.g. v0.4.0):
git -C vendor/freellmapi fetch --tags
git -C vendor/freellmapi checkout v0.4.0
git add vendor/freellmapi

# Verify the seams against the new upstream:
(cd vendor/freellmapi && npm install)   # upstream workspace deps — the oracle the
                                        # router/portability Node suites resolve
cd mobile
npm install                             # app deps (incl. the better-sqlite3 oracle
                                        # for the facade/schema suites) + Metro bundle
npm run verify:portability && npm run verify:router \
  && npm run verify:facade && npm run verify:schema
npx tsx src/adapters/keystore/crypto-shim.check.mts
npx expo export --platform android      # the real gate — must bundle
```

If a step **fails**, the new upstream broke one of the seams below — the failing
step tells you which; fix the relevant adapter (never edit upstream). If it all
passes, commit the bumped pin and open a PR.

You don't have to do this by hand: an **update bot** (added in a follow-up PR)
opens the pin-bump PR per upstream release, and [`mobile-ci.yml`](#ci-guards) runs
this exact verify + bundle on it.

## Adapter seams

All wiring is in [`mobile/metro.config.js`](mobile/metro.config.js) (the resolver)
and [`mobile/index.ts`](mobile/index.ts) / [`mobile/src/core/`](mobile/src/core)
(the global installs). Each row is a place upstream and the app touch.

| # | Seam | Upstream side | Mobile side | Breaks when upstream… | Caught by |
| - | ---- | ------------- | ----------- | --------------------- | --------- |
| 1 | **DB** | `import '../db/index.js'` (raw better-sqlite3) | Metro-aliased to [`src/adapters/sqlite/db-shim.ts`](mobile/src/adapters/sqlite/db-shim.ts) → [`facade.ts`](mobile/src/adapters/sqlite/facade.ts) over `expo-sqlite` | renames/moves `server/src/db/index.ts`, or uses a better-sqlite3 API the facade doesn't implement | `expo export` (alias miss) + `verify:facade` |
| 2 | **Crypto** | `import '../lib/crypto.js'` (Node `crypto`) | Metro-aliased to [`src/adapters/keystore/crypto-shim.ts`](mobile/src/adapters/keystore/crypto-shim.ts) (Android Keystore via `expo-secure-store`) | renames/moves `server/src/lib/crypto.ts`, or changes the `maskKey`/encrypt/ref signatures | `expo export` + `crypto-shim.check.mts` |
| 3 | **Proxy / net** | `import '../lib/proxy.js'` (Node `http(s)`, `undici`, `socks-proxy-agent`) | Metro-aliased to [`src/adapters/net/proxy-shim.ts`](mobile/src/adapters/net/proxy-shim.ts) (pass-through to global `fetch`) | renames/moves `server/src/lib/proxy.ts`, or routes provider calls through a new Node-only path | `expo export` (would pull Node built-ins into the bundle) |
| 4 | **NodeNext `.js`→`.ts`** | every internal upstream import carries an explicit `.js` extension (`../providers/index.js`) | resolver strips `.js` for specifiers **originating in** `vendor/freellmapi/server/src/` + `vendor/freellmapi/shared/` so Metro re-resolves to `.ts` | adds a *new* upstream code root outside those two dirs (the `upstreamCodeRoots` allow-list) | `expo export` (unresolved import) |
| 5 | **Streaming fetch** | providers call `res.body.getReader()` (WHATWG streams) via `proxyFetch` → global `fetch` | [`src/core/fetch.ts`](mobile/src/core/fetch.ts) overwrites `globalThis.fetch` with `expo/fetch` + restores WHATWG `Headers/Request/Response` globals | stops going through `proxyFetch`/global `fetch`, or relies on a stream API `expo/fetch` lacks | `verify:portability` (Node) + on-device smoke |
| 6 | **CSPRNG** | ported schema/keystore derive hex from `globalThis.crypto.getRandomValues` | [`mobile/index.ts`](mobile/index.ts) imports `react-native-get-random-values` **first** (Hermes has no Web Crypto; Node does — why suites miss it) | adds a new module that needs Web Crypto *before* the entry side-effect runs | on-device smoke (Phase 5) |
| 7 | **Shared types** | `shared/types.ts` (`Platform` union, `ChatMessage`, …) | reused **as-is** (no shim); `src/core/bridge.ts` + screens consume it | adds a `Platform` the UI's key/provider list doesn't handle, or changes a reused type's shape | `verify:router` + bundle; mobile UI follows up |

### Why `tsc` is not the gate

Running `npm run typecheck` (`tsc --noEmit`) over the app **also type-checks the
reused upstream files**, and that is noisy by construction:

- The shimmed-away upstream files (e.g. `lib/proxy.ts`) `import 'undici'` /
  `'socks-proxy-agent'` — Node-only packages the app deliberately does **not**
  depend on. `tsc` follows the real import (Metro doesn't — it aliases the file
  away), so it reports `Cannot find module 'undici'` for code that never ships.
- `tsc` also type-checks the submodule's upstream `server/src` (under
  `vendor/freellmapi`), which carries its own strictness expectations and Node-only
  imports — more noise that has nothing to do with whether the app bundles.

So a green `tsc` is neither necessary nor sufficient. The **authoritative gate is
`expo export`**: Babel strips types (type noise can't fail it) but Metro's
*resolver runs for real*, so a genuinely broken seam (a moved alias target, an
unresolvable import) fails the bundle. The Node `verify:*` suites cover the
behavioural contracts (facade semantics, router fallback, schema, crypto parity).
`tsc` stays as a useful local smell-test, not a CI gate.

## CI guards

[`.github/workflows/mobile-ci.yml`](.github/workflows/mobile-ci.yml) — on every
push/PR to `main` that touches `mobile/`, the `vendor/freellmapi` pin, or
`.gitmodules`: install the upstream workspace deps in the submodule + the app deps
→ run the five Node verification checks → `expo export`. This catches a seam break
the moment an upstream pin-bump (or an app change) lands — it fails on the same
things the [update runbook](#update-runbook) would: a moved alias target, a shifted
facade/router/schema contract, an unresolvable import.

It needs no Android SDK or JDK: `expo export` produces the JS/Hermes bundle, which
is where every seam above lives. The signed-APK build (Gradle, JDK 17) stays a
local/manual step — see [`mobile/docs/BUILD.md`](mobile/docs/BUILD.md).

> The old `mobile-upstream-sync.yml` (which ran `git merge upstream/main`) was
> removed in the submodule cutover — there is no tree to merge anymore. Its job is
> replaced by the update bot that bumps the `vendor/freellmapi` pin. Upstream's own
> `ci.yml`/`docker.yml` are gone too (they lived in the deleted root tree).
