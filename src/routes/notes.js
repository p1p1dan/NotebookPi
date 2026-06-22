import { db, now } from '../db.js';
import { requireAuth } from '../auth.js';

const MAX_TITLE = 500;
const MAX_CONTENT = 1024 * 1024; // 1 MB per note — generous
const VALID_FORMATS = new Set(['txt', 'md']);
const MAX_VERSIONS_PER_NOTE = 50;

const validTitle   = (t) => typeof t === 'string' && t.length <= MAX_TITLE;
const validContent = (c) => typeof c === 'string' && c.length <= MAX_CONTENT;
const validFormat  = (f) => typeof f === 'string' && VALID_FORMATS.has(f);

// Field lists kept in one place so list/detail SELECTs stay aligned.
const LIST_COLS   = `id, folder_id, title, format, SUBSTR(content, 1, 240) AS excerpt, created_at, updated_at`;
const DETAIL_COLS = `id, folder_id, title, format, content, created_at, updated_at`;

// --- Helpers ---------------------------------------------------------------
const insertVersionStmt = db.prepare(
  `INSERT INTO note_versions (note_id, content, saved_at) VALUES (?, ?, ?)`
);
const trimVersionsStmt = db.prepare(`
  DELETE FROM note_versions
  WHERE note_id = ?
    AND id NOT IN (
      SELECT id FROM note_versions WHERE note_id = ? ORDER BY saved_at DESC LIMIT ?
    )
`);

function recordVersion(noteId, newContent, ts) {
  insertVersionStmt.run(noteId, newContent, ts);
  trimVersionsStmt.run(noteId, noteId, MAX_VERSIONS_PER_NOTE);
}

export default async function noteRoutes(app) {
  app.addHook('preHandler', requireAuth);

  // ---------- CRUD ----------
  app.get('/api/notes', async (req) => {
    const { folder_id } = req.query ?? {};
    let rows;
    if (folder_id === undefined || folder_id === '' || folder_id === 'null') {
      rows = db.prepare(
        `SELECT ${LIST_COLS} FROM notes WHERE folder_id IS NULL ORDER BY updated_at DESC`
      ).all();
    } else if (folder_id === 'all') {
      rows = db.prepare(
        `SELECT ${LIST_COLS} FROM notes ORDER BY updated_at DESC LIMIT 500`
      ).all();
    } else {
      const fid = Number(folder_id);
      if (!Number.isInteger(fid)) return { notes: [] };
      rows = db.prepare(
        `SELECT ${LIST_COLS} FROM notes WHERE folder_id = ? ORDER BY updated_at DESC`
      ).all(fid);
    }
    return { notes: rows };
  });

  app.get('/api/notes/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'invalid_id' });
    const note = db.prepare(`SELECT ${DETAIL_COLS} FROM notes WHERE id = ?`).get(id);
    if (!note) return reply.code(404).send({ error: 'not_found' });
    return { note };
  });

  app.post('/api/notes', async (req, reply) => {
    const { folder_id = null, title = '', content = '', format = 'txt' } = req.body ?? {};
    if (!validTitle(title))     return reply.code(400).send({ error: 'invalid_title' });
    if (!validContent(content)) return reply.code(400).send({ error: 'invalid_content' });
    if (!validFormat(format))   return reply.code(400).send({ error: 'invalid_format' });
    if (folder_id != null) {
      const exists = db.prepare('SELECT id FROM folders WHERE id = ?').get(folder_id);
      if (!exists) return reply.code(400).send({ error: 'folder_not_found' });
    }
    const ts = now();
    const info = db.prepare(
      `INSERT INTO notes (folder_id, title, content, format, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(folder_id, title, content, format, ts, ts);
    // Seed the first version only if content is non-empty (don't spam empty rows).
    if (content.length > 0) recordVersion(info.lastInsertRowid, content, ts);
    const note = db.prepare(`SELECT ${DETAIL_COLS} FROM notes WHERE id = ?`).get(info.lastInsertRowid);
    return reply.code(201).send({ note });
  });

  app.put('/api/notes/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'invalid_id' });
    const existing = db.prepare('SELECT content FROM notes WHERE id = ?').get(id);
    if (!existing) return reply.code(404).send({ error: 'not_found' });

    const { title, content, folder_id, format } = req.body ?? {};
    const updates = {};
    if (title !== undefined) {
      if (!validTitle(title)) return reply.code(400).send({ error: 'invalid_title' });
      updates.title = title;
    }
    if (content !== undefined) {
      if (!validContent(content)) return reply.code(400).send({ error: 'invalid_content' });
      updates.content = content;
    }
    if (folder_id !== undefined) {
      if (folder_id != null) {
        const exists = db.prepare('SELECT id FROM folders WHERE id = ?').get(folder_id);
        if (!exists) return reply.code(400).send({ error: 'folder_not_found' });
      }
      updates.folder_id = folder_id;
    }
    if (format !== undefined) {
      if (!validFormat(format)) return reply.code(400).send({ error: 'invalid_format' });
      updates.format = format;
    }
    if (Object.keys(updates).length === 0) {
      const note = db.prepare(`SELECT ${DETAIL_COLS} FROM notes WHERE id = ?`).get(id);
      return { note };
    }
    updates.updated_at = now();
    const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');

    // Transaction: snapshot + UPDATE atomically.
    const contentChanged = updates.content !== undefined && updates.content !== existing.content;
    const txn = db.transaction(() => {
      db.prepare(`UPDATE notes SET ${setClause} WHERE id = ?`).run(...Object.values(updates), id);
      if (contentChanged && updates.content.length > 0) {
        recordVersion(id, updates.content, updates.updated_at);
      }
    });
    txn();

    const note = db.prepare(`SELECT ${DETAIL_COLS} FROM notes WHERE id = ?`).get(id);
    return { note };
  });

  app.delete('/api/notes/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'invalid_id' });
    const info = db.prepare('DELETE FROM notes WHERE id = ?').run(id);
    if (info.changes === 0) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  // ---------- Versions ----------
  // List versions for a note (newest first). No content — that's a separate request.
  app.get('/api/notes/:id/versions', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'invalid_id' });
    const note = db.prepare('SELECT id FROM notes WHERE id = ?').get(id);
    if (!note) return reply.code(404).send({ error: 'not_found' });
    const versions = db.prepare(
      `SELECT id, saved_at, LENGTH(content) AS size
       FROM note_versions WHERE note_id = ?
       ORDER BY saved_at DESC LIMIT ?`
    ).all(id, MAX_VERSIONS_PER_NOTE);
    return { versions };
  });

  // Fetch a single version's full content.
  app.get('/api/notes/:id/versions/:vid', async (req, reply) => {
    const id  = Number(req.params.id);
    const vid = Number(req.params.vid);
    if (!Number.isInteger(id) || !Number.isInteger(vid)) {
      return reply.code(400).send({ error: 'invalid_id' });
    }
    const v = db.prepare(
      `SELECT id, note_id, content, saved_at FROM note_versions WHERE id = ? AND note_id = ?`
    ).get(vid, id);
    if (!v) return reply.code(404).send({ error: 'not_found' });
    return { version: v };
  });

  // Restore: overwrite current content with that version's content. Records a new version too.
  app.post('/api/notes/:id/versions/:vid/restore', async (req, reply) => {
    const id  = Number(req.params.id);
    const vid = Number(req.params.vid);
    if (!Number.isInteger(id) || !Number.isInteger(vid)) {
      return reply.code(400).send({ error: 'invalid_id' });
    }
    const v = db.prepare(
      `SELECT content FROM note_versions WHERE id = ? AND note_id = ?`
    ).get(vid, id);
    if (!v) return reply.code(404).send({ error: 'not_found' });
    const ts = now();
    const txn = db.transaction(() => {
      db.prepare(`UPDATE notes SET content = ?, updated_at = ? WHERE id = ?`).run(v.content, ts, id);
      recordVersion(id, v.content, ts);
    });
    txn();
    const note = db.prepare(`SELECT ${DETAIL_COLS} FROM notes WHERE id = ?`).get(id);
    if (!note) return reply.code(404).send({ error: 'not_found' });
    return { note };
  });
}
