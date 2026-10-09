import { readFileSync } from 'node:fs'

import { defineConfig } from 'tsup'

// This package's version, baked in at build time: init() tells the host which
// SDK a page runs.
const { version } = JSON.parse(readFileSync('./package.json', 'utf8'))

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/server.ts',
    'src/matchmaking.ts',
    'src/manifest.ts',
    'src/restrictions.ts',
    'src/game-core.ts',
    'src/privy.ts',
    'src/next.ts',
    'src/webhooks.ts',
    'src/react.tsx',
    'src/game.tsx',
    'src/mock.ts',
    'src/store/index.ts',
    'src/store/fs.ts',
    'src/store/vercel.ts',
  ],
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'es2022',
  define: { __SDK_VERSION__: JSON.stringify(version) },
})
