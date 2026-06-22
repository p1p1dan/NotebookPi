import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

// Vite serves `web/` as the source root, builds to `public/` at repo root.
// In dev, /api/* is proxied to the Fastify backend on :8454.
export default defineConfig({
  root: 'web',
  publicDir: false,
  plugins: [tailwindcss()],
  resolve: {
    alias: { '@': resolve(import.meta.dirname, 'web/src') },
  },
  build: {
    outDir: '../public',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:8454',
    },
  },
});
