// whatwg-fetch ships no TypeScript declarations. src/core/fetch.ts imports its
// always-exported Headers/Request/Response classes to backfill the WHATWG globals
// on Hermes (whatwg-fetch only *installs* them as globals behind an
// `if (!global.fetch)` guard, which our expo/fetch override defeats). Declare the
// module so tsc does not flag that import as implicit-any (TS7016). The exports are
// typed `unknown`; fetch.ts narrows them with an explicit cast.
declare module 'whatwg-fetch' {
  export const Headers: unknown;
  export const Request: unknown;
  export const Response: unknown;
  export const fetch: unknown;
}
