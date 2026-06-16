# freellmapiphone

An **Android app** (React Native / Expo) built on top of the
[freellmapi](https://github.com/tashfeenahmed/freellmapi) provider/router core —
the same OpenAI-compatible multi-provider routing engine, running **in-process on
the device** instead of behind an Express server. Add your free-tier provider keys,
and the app routes + falls over across providers on-device, with keys stored in the
Android Keystore.

## How upstream is consumed

The reused upstream code (`server/src` providers + router, `shared` types) is a
**pinned git submodule** at [`vendor/freellmapi`](vendor/freellmapi). The app bundles
it through Metro without editing a single upstream file (the Node-only seams — SQLite,
crypto, proxy — are swapped for on-device adapters at resolve time). Upstream updates
arrive as **version-pin bumps** the update bot opens as PRs, not whole-tree merges.

Clone with the submodule:

```bash
git clone --recurse-submodules https://github.com/PeterXMR/freellmapiphone.git
# already cloned:
git submodule update --init vendor/freellmapi
```

## Docs

- [`MOBILE.md`](MOBILE.md) — the adapter seams, the submodule model, and the CI that guards them. **Read this first.**
- [`MOBILE-PLAN.md`](MOBILE-PLAN.md) — architecture and design rationale.
- [`mobile/docs/BUILD.md`](mobile/docs/BUILD.md) — build, sign, and install the APK.
- [`mobile/verification/`](mobile/verification) — the Node proofs behind each seam.

## License

[MIT](./LICENSE). Upstream [freellmapi](https://github.com/tashfeenahmed/freellmapi)
is MIT © its authors; this fork is MIT and retains that attribution.
