// Streaming fetch installer.
//
// WHY THIS EXISTS
// ---------------
// The reused upstream provider layer streams responses with the WHATWG pattern
//   const reader = res.body.getReader();
// (see server/src/providers/base.ts readSseStream). On React Native, the global
// `fetch` is implemented on top of XMLHttpRequest and DOES NOT expose a readable
// `res.body` stream — `res.body` is null, so `.getReader()` throws and every
// streamed completion dies before the first token.
//
// Expo SDK 52+ ships `expo/fetch`: a WinterCG-compliant fetch whose Response DOES
// expose `body` as a ReadableStream, so `res.body.getReader()` works exactly like
// it does in Node/undici on the server. Every provider reaches the network through
// `proxyFetch` (server/src/lib/proxy.ts), which in the no-proxy case is a direct
// pass-through to the GLOBAL `fetch`. So by overwriting `globalThis.fetch` with
// expo/fetch we transparently upgrade the entire upstream provider layer to real
// streaming — with zero edits to upstream source (keeps `git merge` clean).
//
// This module has a side effect on import. Import it ONCE, as early as possible
// (before any provider call), e.g. at the top of the bridge / app entry.

import { fetch as expoFetch } from 'expo/fetch';

let installed = false;

/**
 * Install expo/fetch as the global fetch used by the upstream provider layer.
 * Idempotent — safe to call from multiple entry points.
 */
export function installStreamingFetch(): void {
  if (installed) return;
  // expo/fetch's type is structurally compatible with the DOM fetch signature
  // the provider layer expects; the cast satisfies TS across the lib boundary.
  (globalThis as unknown as { fetch: typeof fetch }).fetch =
    expoFetch as unknown as typeof fetch;
  installed = true;
}

// Install on import so simply `import './fetch'` is enough.
installStreamingFetch();
