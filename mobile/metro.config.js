// Metro config for the standalone mobile app. The reused upstream code is the
// pinned git submodule at vendor/freellmapi (see MOBILE.md).
//
// Two jobs:
//   1. watchFolders → the submodule's server/ + shared/, so Metro can bundle the
//      reused upstream code under vendor/freellmapi/server/src and
//      vendor/freellmapi/shared (imported by relative path).
//   2. resolveRequest → redirect the Node-only upstream modules
//      (db/index.js, lib/crypto.js, lib/proxy.js) to mobile adapters, so the
//      vendored upstream source stays byte-identical to upstream.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, '..');
// Only imports ORIGINATING in upstream server code are redirected. Without this
// guard the suffix regexes below would hijack any module whose path happens to
// end in db/index or lib/crypto — including node_modules internals and future
// mobile-local files.
const upstreamSrcRoot = path.join(repoRoot, 'vendor', 'freellmapi', 'server', 'src') + path.sep;
// The reused upstream TS source (server/src + shared) is authored in NodeNext
// ESM style: every relative import carries an explicit `.js` extension that is
// understood to map to the `.ts` source on disk (e.g. `../providers/index.js`
// → `providers/index.ts`). Node + tsx perform that rewrite; Metro does NOT, so
// without help every internal upstream import fails to resolve. We strip the
// `.js` for relative imports ORIGINATING in these roots and let Metro re-resolve
// via sourceExts (.ts/.tsx). Scoped to these roots so genuine `.js` files in
// node_modules are never touched.
const upstreamCodeRoots = [
  path.join(repoRoot, 'vendor', 'freellmapi', 'server', 'src') + path.sep,
  path.join(repoRoot, 'vendor', 'freellmapi', 'shared') + path.sep,
];
function isUpstreamOrigin(originModulePath) {
  return !!originModulePath && upstreamCodeRoots.some(root => originModulePath.startsWith(root));
}

const config = getDefaultConfig(projectRoot);

// The reused upstream source — server/src + shared from the pinned submodule at
// vendor/freellmapi. Scoped to these two dirs (not all of vendor/freellmapi) so
// Metro never crawls the submodule's node_modules / client / desktop workspaces
// (which would slow the crawl and risk Haste-map name collisions).
config.watchFolders = [
  path.join(repoRoot, 'vendor', 'freellmapi', 'server'),
  path.join(repoRoot, 'vendor', 'freellmapi', 'shared'),
];
// Metro needs both the mobile app's node_modules AND react-native's nested
// node_modules — RN ships some of its own runtime deps (@react-native/
// virtualized-lists, etc.) inside its package rather than hoisted. With
// disableHierarchicalLookup=true these would otherwise be unresolvable, since
// the flag turns off the standard parent-walk that normally finds them.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(projectRoot, 'node_modules/react-native/node_modules'),
];
config.resolver.disableHierarchicalLookup = true;

// Alias targets — these files are provided by the mobile adapters (see agents).
const DB_SHIM = path.resolve(projectRoot, 'src/adapters/sqlite/db-shim.ts');
const CRYPTO_SHIM = path.resolve(projectRoot, 'src/adapters/keystore/crypto-shim.ts');
// lib/proxy.js top-level imports Node http/https (plus lazy undici /
// socks-proxy-agent) for proxy dispatch — unresolvable under Metro on Android.
// The shim is a direct pass-through to the global (expo/) fetch.
const PROXY_SHIM = path.resolve(projectRoot, 'src/adapters/net/proxy-shim.ts');

function redirects(moduleName) {
  // Match the upstream relative imports `../db/index.js`, `../lib/crypto.js`
  // and `../lib/proxy.js` (also without the .js extension, just in case).
  if (/(^|\/)db\/index(\.js)?$/.test(moduleName)) return DB_SHIM;
  if (/(^|\/)lib\/crypto(\.js)?$/.test(moduleName)) return CRYPTO_SHIM;
  if (/(^|\/)lib\/proxy(\.js)?$/.test(moduleName)) return PROXY_SHIM;
  return null;
}

const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  // Scope the redirects to imports made BY upstream server files; everything
  // else (node_modules, mobile-local code) resolves normally.
  if (context.originModulePath && context.originModulePath.startsWith(upstreamSrcRoot)) {
    const target = redirects(moduleName);
    if (target) {
      return { type: 'sourceFile', filePath: target };
    }
  }
  // NodeNext `.js` → `.ts` rewrite for upstream-origin relative imports (see
  // upstreamCodeRoots above). Done AFTER the redirect check so the shimmed
  // modules still win, and only for relative specifiers so bare package names
  // are untouched.
  if (
    isUpstreamOrigin(context.originModulePath) &&
    /^\.\.?\//.test(moduleName) &&
    moduleName.endsWith('.js')
  ) {
    moduleName = moduleName.slice(0, -'.js'.length);
  }
  if (defaultResolveRequest) {
    return defaultResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
