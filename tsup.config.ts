import { defineConfig } from 'tsup'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/server.ts',
    'src/privy.ts',
    'src/next.ts',
    'src/react.tsx',
    'src/store/index.ts',
    'src/store/fs.ts',
    'src/store/vercel.ts',
  ],
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'es2022',
})
