import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/server.ts', 'src/privy.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'es2022',
})
