// Metro config for the standalone mobile app living inside the freellmapi clone.
//
// Two jobs:
//   1. watchFolders → repo root, so Metro can bundle the reused upstream code
//      under ../server/src and ../shared (imported by relative path).
//   2. resolveRequest → redirect the two Node-only upstream modules
//      (db/index.js, lib/crypto.js) to mobile adapters, so upstream source files
//      stay byte-identical and `git merge upstream/main` never conflicts.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, '..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [repoRoot];
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, 'node_modules')];
config.resolver.disableHierarchicalLookup = true;

// Alias targets — these files are provided by the mobile adapters (see agents).
const DB_SHIM = path.resolve(projectRoot, 'src/adapters/sqlite/db-shim.ts');
const CRYPTO_SHIM = path.resolve(projectRoot, 'src/adapters/keystore/crypto-shim.ts');

function redirects(moduleName) {
  // Match the upstream relative imports `../db/index.js` and `../lib/crypto.js`
  // (also without the .js extension, just in case).
  if (/(^|\/)db\/index(\.js)?$/.test(moduleName)) return DB_SHIM;
  if (/(^|\/)lib\/crypto(\.js)?$/.test(moduleName)) return CRYPTO_SHIM;
  return null;
}

const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const target = redirects(moduleName);
  if (target) {
    return { type: 'sourceFile', filePath: target };
  }
  if (defaultResolveRequest) {
    return defaultResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
