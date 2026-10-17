import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

// Vite serves `web/` as the source root, builds to `public/` at repo root.
// In dev, /api/* is proxied to the Fastify backend on :8454.
//
// Multi-page setup:
// - index.html        → main app shell (also served by Fastify in browser deploys)
// - quick-note.html   → desktop quick-note popup window (loaded by Tauri)
// - share.html        → public read-only page served by Fastify at /s/:token
//
// All end up under public/ after build, and Tauri picks them up from frontendDist.
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
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'web/index.html'),
        quickNote: resolve(import.meta.dirname, 'web/quick-note.html'),
        share: resolve(import.meta.dirname, 'web/share.html'),
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:8454',
    },
  },
});
