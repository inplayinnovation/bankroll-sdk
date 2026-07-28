// Guards the two ways the React entry ships broken without failing the build.
//
// Both were reproduced empirically before this existed:
//
//   dropped directive   esbuild only preserves 'use client' when it is the
//           first statement of a file listed in tsup's `entry`. On a bundled
//           non-entry module it is removed with NO warning, and the component
//           then ships as a server component that throws on import.
//   bundled React   tsup externalizes only exact package names found in
//           dependencies/peerDependencies. Drop `react` from peerDependencies
//           and it inlines its own copy, so every hook runs against a different
//           React instance than the app's — "Invalid hook call" at first render.
//
// Neither shows up in tests, typecheck, or the build's own output.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const DIST = 'dist';
const CLIENT_ENTRY = 'react.js';
const DIRECTIVE = '"use client";';
// The inlined CommonJS copy of React, if it ever gets bundled.
const INLINED_REACT = 'react.production';

const failures = [];

async function jsFiles(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await jsFiles(path)));
    else if (entry.name.endsWith('.js')) found.push(path);
  }
  return found;
}

const files = await jsFiles(DIST);
const clientEntry = join(DIST, CLIENT_ENTRY);

const client = await readFile(clientEntry, 'utf8');

if (!client.startsWith(DIRECTIVE)) {
  failures.push(
    `${clientEntry} must start with ${DIRECTIVE} — it starts with ${JSON.stringify(
      client.slice(0, 40),
    )}. The directive is dropped unless the file is a tsup entry with it on line 1.`,
  );
}

if (client.includes(INLINED_REACT)) {
  failures.push(
    `${clientEntry} has React bundled into it. Add "react" to peerDependencies so tsup treats it as external.`,
  );
}

// A directive anywhere else means a server-only entry would be treated as a
// client module by the consuming bundler.
for (const file of files) {
  if (file === clientEntry) continue;
  const contents = await readFile(file, 'utf8');
  if (contents.startsWith(DIRECTIVE)) failures.push(`${file} unexpectedly carries ${DIRECTIVE}`);
}

if (failures.length) {
  console.error('Build verification failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`Build verified: ${files.length} files, client entry intact, React external.`);
