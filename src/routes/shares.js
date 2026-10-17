import { db, now } from '../db.js';
import { requireAuth, newShareToken } from '../auth.js';

const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

const activeShare = (noteId) => db.prepare(
  `SELECT token, created_at, expires_at FROM shares
   WHERE note_id = ? AND (expires_at IS NULL OR expires_at > ?)
   ORDER BY created_at DESC LIMIT 1`
).get(noteId, now()) ?? null;

const noteExists = (id) => !!db.prepare('SELECT id FROM notes WHERE id = ?').get(id);

async function shareAdminRoutes(app) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/notes/:id/share', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'invalid_id' });
    if (!noteExists(id)) return reply.code(404).send({ error: 'not_found' });
    return { share: activeShare(id) };
  });

  // Idempotent: returns the existing link instead of minting a second one.
  app.post('/api/notes/:id/share', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'invalid_id' });
    if (!noteExists(id)) return reply.code(404).send({ error: 'not_found' });
    const existing = activeShare(id);
    if (existing) return { share: existing };
    const share = { token: newShareToken(), created_at: now(), expires_at: null };
    db.prepare(
      'INSERT INTO shares (token, note_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
    ).run(share.token, id, share.created_at, share.expires_at);
    return reply.code(201).send({ share });
  });

  app.delete('/api/notes/:id/share', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'invalid_id' });
    db.prepare('DELETE FROM shares WHERE note_id = ?').run(id);
    return { ok: true };
  });
}

// No auth hook here: anyone holding the token can read the note.
async function sharePublicRoutes(app) {
  app.get('/api/public/shares/:token', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { token } = req.params;
    if (!TOKEN_RE.test(token)) return reply.code(404).send({ error: 'not_found' });
    const note = db.prepare(
      `SELECT n.title, n.format, n.content, n.updated_at
       FROM shares s JOIN notes n ON n.id = s.note_id
       WHERE s.token = ? AND (s.expires_at IS NULL OR s.expires_at > ?)`
    ).get(token, now());
    if (!note) return reply.code(404).send({ error: 'not_found' });
    return { note };
  });
}

export default async function shareRoutes(app) {
  await app.register(shareAdminRoutes);
  await app.register(sharePublicRoutes);
}
