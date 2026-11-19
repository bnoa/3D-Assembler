/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
  // manifold-3d ships its own WASM loader; pre-bundling breaks its file lookup.
  optimizeDeps: { exclude: ['manifold-3d'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  worker: { format: 'es' },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
