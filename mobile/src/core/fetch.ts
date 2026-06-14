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
// whatwg-fetch ALWAYS exports the WHATWG classes (see its `exports.Headers = …`),
// even though it only installs them as GLOBALS behind an `if (!global.fetch)` guard.
// We read the exports directly so we can populate the globals ourselves, decoupled
// from fetch-install order — see ensureWhatwgGlobals() below.
import * as WhatwgFetch from 'whatwg-fetch';

let installed = false;

// expo/fetch's request normalizer branches on `value instanceof Headers|Request|
// Response` (node_modules/expo/src/winter/fetch/RequestUtils.ts). Those classes are
// installed as globals lazily by whatwg-fetch, but ONLY when no global `fetch`
// exists yet (`if (!global.fetch)`). Because installStreamingFetch() overwrites
// global.fetch with expo/fetch, that guard never fires, leaving Headers/Request/
// Response undefined — so `headers instanceof Headers` throws "right operand of
// 'instanceof' is not an object" on the FIRST network request (every chat send).
// React Native's own setUpXHR has the same fetch-guarded laziness, so it doesn't
// save us. Assign the classes ourselves, before the fetch override, to fix it.
function ensureWhatwgGlobals(): void {
  const g = globalThis as Record<string, unknown>;
  const w = WhatwgFetch as unknown as {
    Headers?: unknown;
    Request?: unknown;
    Response?: unknown;
  };
  if (typeof g.Headers === 'undefined' && w.Headers) g.Headers = w.Headers;
  if (typeof g.Request === 'undefined' && w.Request) g.Request = w.Request;
  if (typeof g.Response === 'undefined' && w.Response) g.Response = w.Response;
}

/**
 * Install expo/fetch as the global fetch used by the upstream provider layer.
 * Idempotent — safe to call from multiple entry points.
 */
export function installStreamingFetch(): void {
  if (installed) return;
  // Ensure the WHATWG Headers/Request/Response globals exist BEFORE we replace
  // global.fetch (which would otherwise suppress whatwg-fetch's own installer).
  ensureWhatwgGlobals();
  // expo/fetch's type is structurally compatible with the DOM fetch signature
  // the provider layer expects; the cast satisfies TS across the lib boundary.
  (globalThis as unknown as { fetch: typeof fetch }).fetch =
    expoFetch as unknown as typeof fetch;
  installed = true;
}

// Install on import so simply `import './fetch'` is enough.
installStreamingFetch();
