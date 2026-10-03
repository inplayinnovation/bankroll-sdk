import { defineConfig } from 'tsup'

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
})
