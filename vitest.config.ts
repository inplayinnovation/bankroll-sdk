import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

// Next loads .env.test.local on its own; vitest does not. Without this the Blob
// conformance cases skip silently and only the filesystem backend is covered,
// which reads as "the store is tested" when the backend every deployment
// actually uses is not.
//
// loadEnv is Vite's own loader, so it handles quoting and `export` prefixes
// properly rather than by hand. vite is already here underneath vitest, but it
// is declared as a devDependency rather than relied on as a transitive — that
// is the kind of thing a fresh install with different hoisting breaks. The
// empty prefix is deliberate: it defaults to VITE_, and nothing here is
// client-side.
//
// Existing environment wins, so CI can supply the token without a file.
export default defineConfig(({ mode }) => {
  for (const [key, value] of Object.entries(loadEnv(mode, process.cwd(), ''))) {
    process.env[key] ??= value;
  }
  return {};
});
