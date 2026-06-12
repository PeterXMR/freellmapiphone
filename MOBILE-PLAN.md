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
- **Drizzle**: `drizzle-orm/expo-sqlite` + `useLiveQuery` for reactive UI.

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
- **Phase 3 — Headless proof** ✅ (Node) / ⚠️ on-device pending
  - Provider + streaming portability proven in Node; facade (10/10) + schema (65/65) +
    crypto parity verified against real better-sqlite3. Real key → router → on-device
    stream still needs a device build.
- **Phase 4 — UI (v1)** ✅ (code) / ⚠️ runtime build-gated
  - Chat (streaming + fallback), Keys/Providers, Settings; bottom-tab nav.
    Note: v1 uses raw SQL through the facade + TanStack Query for reactivity rather than
    `drizzle-orm`/`useLiveQuery` (matches upstream's raw-SQL router; less surface to sync).
- **Phase 5 — Harden the sync loop** — TODO
  - Install deps on a real machine (`npx expo install --fix`), `expo export` bundle check,
    then a device build. CI: `git merge upstream/main` must still build mobile.

## Verification boundary

The git tracking, monorepo baseline, and code-portability claims are verifiable in a
plain dev environment. The **runtime** behavior of the expo-sqlite facade, Metro
aliasing, and on-device streaming can only be proven with an Android emulator/device
build — that's the gate before Phases 2–4 can be called "done".
