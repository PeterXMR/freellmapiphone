// MUST be first: installs globalThis.crypto.getRandomValues on the Hermes/RN
// runtime (Hermes has no native Web Crypto). The ported upstream code in
// src/db/schema.ts and the keystore/sqlite shims derive their CSPRNG hex from
// globalThis.crypto.getRandomValues; without this side-effect import that global
// is undefined and initDb() throws "No CSPRNG available". Node 18+ provides the
// global natively, which is why the Node verification suites never caught this.
import 'react-native-get-random-values';
import { registerRootComponent } from 'expo';
import App from './App';

registerRootComponent(App);
