# freellmapiphone — Android app plan

A React Native (Expo) Android app built **on top of** [freellmapi](https://github.com/tashfeenahmed/freellmapi),
reusing its provider/router logic so that upstream changes (new providers, routing
fixes) flow into the phone app with minimal effort.

This repo is an **independent tracking repo**, not a GitHub fork: it `git clone`s the
upstream and only ever *pulls* from it. freellmapi is **MIT-licensed**, so
redistributing its code here is permitted as long as `LICENSE` and the copyright
notice are retained (they are).

## Repo / branch model

- `upstream` remote → `https://github.com/tashfeenahmed/freellmapi` (pull only).
- `origin` remote → this repo (PeterXMR/freellmapiphone).
- `main` branch → **pristine mirror** of `upstream/main`. Never hand-edited.
- `mobile` branch → all phone work (the `mobile/` workspace + adapters).

### Sync workflow

```bash
git checkout main
git fetch upstream
git merge --ff-only upstream/main   # main stays a clean mirror
git push origin main
git checkout mobile
git merge main                      # absorb upstream into the app
```

Conflicts are rare **by design**: we never edit upstream files (see "Clean-merge
technique"). New providers land entirely inside upstream's `providers/` + `services/`
and are picked up automatically.

## Architecture (ports & adapters)

freellmapi's `server/` mixes three concerns. We reuse only the portable core and
supply mobile implementations for the platform-specific seams.

| Layer | Upstream files | On mobile |
| --- | --- | --- |
| **Providers** (HTTP logic) | `server/src/providers/*` | Reused as-is. `fetch` → `expo/fetch` for streaming |
| **Router / ratelimit / health** | `server/src/services/*` | Reused as-is via injected DB/crypto seams |
| **Shared types** | `shared/types.ts` | Reused as-is |
| **Crypto** | `server/src/lib/crypto.ts` | Replaced by `expo-secure-store` (Android Keystore) |
| **DB** | `server/src/db/index.ts` | Replaced by `expo-sqlite` behind a better-sqlite3 facade |
| **Express transport / routes / middleware** | `server/src/routes/*`, `app.ts`, `index.ts` | Not used — UI calls the router in-process |

### Clean-merge technique

The router imports `../db/index.js` and `../lib/crypto.js` directly. Rather than
edit those upstream files (which would cause merge conflicts forever), the mobile
build uses a **Metro custom resolver** to redirect those exact module paths to
mobile implementations. Upstream files stay byte-identical → `git merge` is clean.

### The better-sqlite3 facade (key risk area)

`router.ts` uses raw synchronous SQL: `db.prepare(sql).get()/.run()/.all()`.
`expo-sqlite` exposes matching sync methods (`prepareSync`, `getFirstSync`,
`getAllSync`, `runSync`). A thin facade makes expo-sqlite *look like*
better-sqlite3, so the upstream router runs unchanged on-device. This facade is the
trickiest piece and the main thing to validate on a real build.

## Verified tooling (June 2026)

- **Streaming**: Expo SDK 52+ `expo/fetch` supports `res.body.getReader()` — the exact
  pattern in `providers/openai-compat.ts`.
- **Monorepo**: Expo SDK 52+ auto-configures Metro for npm workspaces.
- **Drizzle**: `drizzle-orm/expo-sqlite` + `useLiveQuery` is *available* for reactive UI,
  but v1 does NOT use it (see Phase 4) — it reuses upstream's raw SQL through the facade.

## Product scope (v1)

On-device, freellmapi stops being an exposed API endpoint and becomes a **chat app
powered by your stacked free tiers + key/usage management**. Keys live in the
Android Keystore and never touch a network.

- **In**: chat with streaming + provider fallback; key management (add / reorder /
  per-provider usage); settings.
- **Deferred (YAGNI)**: charts, drag-drop reorder, iOS build, re-exposing a local
  OpenAI endpoint to other apps.

## Phased TODO

- **Phase 0 — Repo & sync skeleton** ✅
  - Tracking clone, `upstream`/`origin` remotes, `main` mirror + `mobile` branch, this doc.
- **Phase 1 — Mobile workspace** ✅ (code) — standalone Expo app, NOT an npm workspace
  - `mobile/` Expo app (TS), Metro `watchFolders` → repo root + `resolveRequest` alias.
    Decision: standalone (own `node_modules`) instead of a root-`package.json` workspace,
    so no upstream file is edited and merges stay clean.
- **Phase 2 — Platform adapters** ✅ (code) / ⚠️ runtime build-gated
  - better-sqlite3 facade over `expo-sqlite`; KeyStore (`expo-secure-store`) +
    `crypto-shim`; DB schema/migrations port; Metro alias of `db/index.js` +
    `lib/crypto.js`; providers' fetch → `expo/fetch`.
- **Phase 3 — Headless proof (Node)** ✅
  - Provider + streaming portability, facade (10/10), schema (65/65), crypto parity, and
    the router + fallback engine (7/7) all proven in Node against real better-sqlite3.
    (The on-device equivalent of this smoke test moves to Phase 5.)
- **Phase 4 — UI (v1)** ✅ (code) / ⚠️ runtime build-gated
  - Chat (streaming + fallback), Keys/Providers, Settings; bottom-tab nav.
    Note: v1 uses raw SQL through the facade + TanStack Query for reactivity rather than
    `drizzle-orm`/`useLiveQuery` (matches upstream's raw-SQL router; less surface to sync).
- **Phase 5 — First device bring-up** ✅ (emulator-verified, commit `abcfb07`)
  - Verified end-to-end on a Pixel_4a_API_34 emulator: build + bundle + launch +
    add/delete key + streamed chat completion with provider fallback. Fixed three
    device-only defects the Node suites structurally cannot catch: CSPRNG missing on
    Hermes (`react-native-get-random-values` imported first), WHATWG `Headers/Request/
    Response` globals clobbered by the `expo/fetch` streaming override, and Metro's
    NodeNext `.js`→`.ts` resolution for upstream-origin relative imports.
  - Validated the expo-sqlite facade, `expo-secure-store`, `expo/fetch` streaming, and
    the Metro alias on a real Android runtime.
- **Phase 6 — Build & distribution** ✅ (local Gradle, signed release APK)
  - `npm run build:apk` produces a signed `app-release.apk` via local Gradle (JDK 17 pinned;
    RN 0.79/Gradle 8.13 reject JDK 21+). Release signing is injected at prebuild time by the
    `withReleaseSigning` Expo config plugin (reads gitignored `credentials/keystore.properties`),
    so a *signed* build is reproducible from source and the `android/` dir stays gitignored →
    `git merge upstream/main` stays clean. The app-signing keystore is **separate** from the
    `expo-secure-store` Android Keystore that holds API keys.
  - Distribution: **sideload** the universal APK (`adb install -r …/app-release.apk`); Play
    `.aab` deferred (YAGNI for v1). See `mobile/docs/BUILD.md`.
- **Phase 7 — Harden the sync loop** ✅
  - Two CI workflows (both *new* files → upstream `ci.yml`/`docker.yml` untouched → merges
    stay clean): `mobile-ci.yml` gates every push/PR touching `mobile/`/`server/`/`shared/`
    (install → 5 Node verify checks → `expo export`), and `mobile-upstream-sync.yml` runs
    weekly/on-demand to `git merge upstream/main` and bundle+verify the *merged* tree,
    opening a tracking issue if the merge conflicts or an adapter contract breaks.
  - The authoritative gate is `expo export` (a real Metro bundle through the custom
    resolver against live upstream source) — `tsc` is deliberately not a gate because it
    type-checks shimmed-away upstream files that import Node-only deps (`undici`,
    `socks-proxy-agent`). `better-sqlite3` is installed ephemerally in CI as the facade's
    test oracle (not an app dependency). `MOBILE.md` documents all seven adapter seams,
    the merge runbook, and why `tsc` isn't the gate.

## Verification boundary

Phases 0–4 are **code-complete and verified in Node** (git tracking, portability,
facade, schema, crypto, router/fallback). What remains unproven is purely **runtime**:
the expo-sqlite facade, Metro aliasing, `expo-secure-store`, and `expo/fetch` streaming
on a real device. Phase 5 is that gate — until a device build passes, Phases 2 and 4
are "done (code)" but not "done (runtime)".
