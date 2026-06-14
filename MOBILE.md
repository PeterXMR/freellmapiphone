# MOBILE.md — the adapter seams (read this before merging upstream)

This repo tracks [tashfeenahmed/freellmapi](https://github.com/tashfeenahmed/freellmapi)
and ships an Android app (`mobile/`) built **on top of** its provider/router core.
The whole point is that upstream changes flow in with a plain `git merge` and
**no upstream file is ever edited** — see [`MOBILE-PLAN.md`](MOBILE-PLAN.md) for the
architecture and why.

That cleanliness has a cost: the app depends on upstream through a handful of
**seams** (Metro aliases, a global-`fetch` override, a SQLite facade) that are
invisible in a normal diff. If an upstream change moves a file or shifts a
contract a seam relies on, nothing in the upstream diff looks wrong — the app
just breaks at bundle time or on device. **This file is the map of those seams,
and the CI that guards them.**

> New to the app? Build/sign/install lives in [`mobile/docs/BUILD.md`](mobile/docs/BUILD.md);
> the Node proofs behind each seam live in [`mobile/verification/`](mobile/verification/README.md).

## Merge runbook

```bash
git checkout main
git fetch upstream
git merge upstream/main          # expected: clean (we never edit upstream files)

npm install                      # upstream workspace deps — provides better-sqlite3
                                 # (the facade's test oracle) at the repo root, where
                                 # the reused server/src resolves it. Not an app dep.
cd mobile
npm install                      # the app's own deps, for the Metro bundle
npm run verify:portability && npm run verify:router \
  && npm run verify:facade && npm run verify:schema
npx tsx src/adapters/keystore/crypto-shim.check.mts
npx expo export --platform android          # the real gate — must bundle
```

> The local dev shortcut in [`mobile/verification/README.md`](mobile/verification/README.md)
> (symlinking `../freellmapi/node_modules` at the repo root) is an alternative to the
> first `npm install` when offline — but keep that sibling checkout current, or it
> drags a stale `shared/types` into resolution.

If the merge **conflicts**, an upstream file you depend on moved *and* a mobile
change touched it — that should never happen by design; find the edited upstream
file and move the change into an adapter instead. If the merge is **clean but a
step above fails**, an upstream change broke one of the seams below — the failing
step tells you which.

You don't have to remember to run this: **CI runs it for you** (see
[CI guards](#ci-guards)). The weekly `mobile-upstream-sync` job performs this exact
merge against the latest upstream and opens an issue if it breaks.

## Adapter seams

All wiring is in [`mobile/metro.config.js`](mobile/metro.config.js) (the resolver)
and [`mobile/index.ts`](mobile/index.ts) / [`mobile/src/core/`](mobile/src/core)
(the global installs). Each row is a place upstream and the app touch.

| # | Seam | Upstream side | Mobile side | Breaks when upstream… | Caught by |
| - | ---- | ------------- | ----------- | --------------------- | --------- |
| 1 | **DB** | `import '../db/index.js'` (raw better-sqlite3) | Metro-aliased to [`src/adapters/sqlite/db-shim.ts`](mobile/src/adapters/sqlite/db-shim.ts) → [`facade.ts`](mobile/src/adapters/sqlite/facade.ts) over `expo-sqlite` | renames/moves `server/src/db/index.ts`, or uses a better-sqlite3 API the facade doesn't implement | `expo export` (alias miss) + `verify:facade` |
| 2 | **Crypto** | `import '../lib/crypto.js'` (Node `crypto`) | Metro-aliased to [`src/adapters/keystore/crypto-shim.ts`](mobile/src/adapters/keystore/crypto-shim.ts) (Android Keystore via `expo-secure-store`) | renames/moves `server/src/lib/crypto.ts`, or changes the `maskKey`/encrypt/ref signatures | `expo export` + `crypto-shim.check.mts` |
| 3 | **Proxy / net** | `import '../lib/proxy.js'` (Node `http(s)`, `undici`, `socks-proxy-agent`) | Metro-aliased to [`src/adapters/net/proxy-shim.ts`](mobile/src/adapters/net/proxy-shim.ts) (pass-through to global `fetch`) | renames/moves `server/src/lib/proxy.ts`, or routes provider calls through a new Node-only path | `expo export` (would pull Node built-ins into the bundle) |
| 4 | **NodeNext `.js`→`.ts`** | every internal upstream import carries an explicit `.js` extension (`../providers/index.js`) | resolver strips `.js` for specifiers **originating in** `server/src/` + `shared/` so Metro re-resolves to `.ts` | adds a *new* upstream code root outside `server/src` + `shared` (the `upstreamCodeRoots` allow-list) | `expo export` (unresolved import) |
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
- When the local dev borrow `node_modules -> ../freellmapi/node_modules` is in
  place (see [`mobile/verification/README.md`](mobile/verification/README.md)), a
  *stale sibling* copy of `shared/types` gets dragged into resolution, producing
  phantom `Platform`/`ChatMessage` mismatches that vanish on a clean `npm install`.

So a green `tsc` is neither necessary nor sufficient. The **authoritative gate is
`expo export`**: Babel strips types (type noise can't fail it) but Metro's
*resolver runs for real*, so a genuinely broken seam (a moved alias target, an
unresolvable import) fails the bundle. The Node `verify:*` suites cover the
behavioural contracts (facade semantics, router fallback, schema, crypto parity).
`tsc` stays as a useful local smell-test, not a CI gate.

## CI guards

Two **new** workflows (they never edit upstream's `ci.yml`/`docker.yml`, so merges
stay clean):

- [`.github/workflows/mobile-ci.yml`](.github/workflows/mobile-ci.yml) — on every
  push/PR to `main` that touches `mobile/`, `server/`, or `shared/`: install →
  run the five Node verification checks → `expo export`. This catches a seam break
  the moment an upstream change lands in this repo.
- [`.github/workflows/mobile-upstream-sync.yml`](.github/workflows/mobile-upstream-sync.yml)
  — weekly (and on-demand via *Run workflow*): `git merge upstream/main`, then the
  same verify + bundle on the merged tree. It fails loudly — opening/refreshing a
  tracking issue — if either the **merge conflicts** (clean-merge invariant broken)
  or the **merged tree fails to build** (an upstream change broke an adapter
  contract). This finds the breakage on CI's schedule instead of mid-sync.

Neither needs the Android SDK or JDK: `expo export` produces the JS/Hermes bundle,
which is where every seam above lives. The signed-APK build (Gradle, JDK 17) stays
a local/manual step — see [`mobile/docs/BUILD.md`](mobile/docs/BUILD.md).
