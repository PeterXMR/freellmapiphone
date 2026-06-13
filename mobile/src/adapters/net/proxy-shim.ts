// proxy-shim — on-device replacement for the upstream `server/src/lib/proxy.ts`.
//
// WHY THIS EXISTS
// ---------------
// Every reused provider reaches the network through `proxyFetch` from
// server/src/lib/proxy.ts (providers/base.ts, providers/google.ts). That module
// top-level imports Node's `http`/`https` (and lazily `undici` /
// `socks-proxy-agent`) to build proxy dispatchers — none of which resolve under
// Metro on Android, so without this shim the bundle fails with
// "Unable to resolve module 'http'" before the app even starts.
//
// On a phone there is no outbound SOCKS/HTTP proxy support: `proxyFetch` is a
// direct pass-through to the GLOBAL fetch, which mobile/src/core/fetch.ts has
// upgraded to expo/fetch (streaming-capable). The rest of the upstream surface
// (the proxy settings accessors used by routes/settings.ts on the server) is
// mirrored with inert implementations for signature parity, so any reused
// module that imports them keeps working.
//
// The Metro resolver (mobile/metro.config.js) redirects upstream imports of
// `../lib/proxy.js` here — upstream files stay byte-identical.
//
// UPSTREAM MERGE NOTE: if upstream adds exports to lib/proxy.ts, mirror the
// SIGNATURES here (inert where they concern proxy dispatch).

let _proxyUrl = '';
let _proxyEnabled = false;
let _bypassPlatforms: string[] = [];

export function applyProxyUrl(dbValue: string): void {
  _proxyUrl = (dbValue ?? '').trim();
}

export function getProxyUrl(): string {
  return _proxyUrl;
}

export function applyProxyEnabled(enabled: boolean): void {
  _proxyEnabled = enabled;
}

export function isProxyEnabled(): boolean {
  return _proxyEnabled;
}

export function applyProxyBypass(platformsCsv: string): void {
  _bypassPlatforms = (platformsCsv ?? '')
    .split(',')
    .map(p => p.trim())
    .filter(Boolean);
}

export function getProxyBypassPlatforms(): string[] {
  return [..._bypassPlatforms];
}

/**
 * Drop-in replacement for upstream `proxyFetch(url, init, platform)`.
 * On-device there is no proxy dispatcher — always a direct pass-through to the
 * global fetch (expo/fetch, installed by mobile/src/core/fetch.ts, so streamed
 * responses expose res.body.getReader()).
 */
export async function proxyFetch(
  url: string,
  init?: RequestInit,
  _platform?: string,
): Promise<Response> {
  return fetch(url, init);
}

/** Always false on-device: proxy dispatch is not supported in the mobile app. */
export function isProxyActive(): boolean {
  return false;
}
