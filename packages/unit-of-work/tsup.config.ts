import { defineConfig } from 'tsup'

// Two builds: development (with dev-only checks) and production (checks compiled away).
export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    splitting: false,
    define: { 'process.env.NODE_ENV': '"development"' },
    outDir: 'dist/dev',
  },
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: false,
    sourcemap: true,
    clean: true,
    splitting: false,
    define: { 'process.env.NODE_ENV': '"production"' },
    outDir: 'dist/prod',
  },
])
