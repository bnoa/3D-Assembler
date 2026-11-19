/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  // Relative paths: the same build works at a site root, in a sub-folder (GitHub Pages) and in the desktop app.
  base: './',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  // manifold-3d ships its own WASM loader; pre-bundling breaks its file lookup.
  optimizeDeps: { exclude: ['manifold-3d'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  worker: { format: 'es' },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
