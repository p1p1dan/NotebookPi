import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { authRoutes } from './auth.js';
import folderRoutes from './routes/folders.js';
import noteRoutes from './routes/notes.js';
import searchRoutes from './routes/search.js';
import importRoutes from './routes/import.js';
import shareRoutes from './routes/shares.js';
import './db.js'; // initialize schema on boot

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, '../public');

const PORT = Number(process.env.PORT) || 8454;
const HOST = '0.0.0.0';

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info' },
  bodyLimit: 2 * 1024 * 1024, // 2 MB — slightly above per-note cap
  trustProxy: true,            // honors X-Forwarded-* when behind nginx/Caddy
});

await app.register(cookie);
await app.register(authRoutes);
await app.register(folderRoutes);
await app.register(noteRoutes);
await app.register(searchRoutes);
await app.register(importRoutes);
await app.register(shareRoutes);

app.get('/api/health', async () => ({ ok: true, ts: Date.now() }));

// Serve the built SPA. If `public/` doesn't exist yet (dev before first `vite build`),
// log a friendly hint instead of crashing.
if (existsSync(PUBLIC_DIR)) {
  await app.register(fastifyStatic, {
    root: PUBLIC_DIR,
    prefix: '/',
    index: ['index.html'],
  });
  // SPA fallback: any non-/api GET returns index.html (so client routing works).
  // Re-read from disk each time so rebuilds are picked up without a server restart.
  const indexHtmlPath = join(PUBLIC_DIR, 'index.html');
  // Public read-only share page; the note itself is fetched from /api/public/shares/:token.
  const shareHtmlPath = join(PUBLIC_DIR, 'share.html');
  app.get('/s/:token', (_req, reply) => {
    reply
      .header('Referrer-Policy', 'no-referrer')   // keep the token out of outbound Referer headers
      .header('X-Robots-Tag', 'noindex, nofollow')
      .type('text/html')
      .send(readFileSync(shareHtmlPath, 'utf-8'));
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/')) {
      return reply.type('text/html').send(readFileSync(indexHtmlPath, 'utf-8'));
    }
    return reply.code(404).send({ error: 'not_found' });
  });
} else {
  app.log.warn(`public/ not found at ${PUBLIC_DIR} — run "npm run build" to build the frontend`);
}

const shutdown = async (signal) => {
  app.log.info({ signal }, 'shutting down');
  try { await app.close(); } finally { process.exit(0); }
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

try {
  await app.listen({ host: HOST, port: PORT });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
