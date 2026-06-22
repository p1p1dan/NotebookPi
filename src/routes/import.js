import { db, now } from '../db.js';
import { requireAuth } from '../auth.js';

const MAX_NOTES_PER_IMPORT = 100;
const MAX_PATH_DEPTH       = 10;
const MAX_TITLE            = 500;
const MAX_CONTENT          = 1024 * 1024;
const MAX_SEGMENT_LEN      = 200;
const VALID_FORMATS        = new Set(['txt', 'md']);

// Resolve a slash-separated folder path, creating any missing segments under root.
// Returns the deepest folder id, or null for "no folder" (root / 未归类).
function ensureFolderPath(path) {
  if (path == null || path === '') return null;
  const segments = String(path).split('/').map(s => s.trim()).filter(Boolean);
  if (segments.length === 0) return null;
  if (segments.length > MAX_PATH_DEPTH) { const e = new Error('path_too_deep'); throw e; }

  let parentId = null;
  for (const name of segments) {
    if (name.length > MAX_SEGMENT_LEN) { const e = new Error('segment_too_long'); throw e; }
    const row = parentId == null
      ? db.prepare('SELECT id FROM folders WHERE parent_id IS NULL AND name = ?').get(name)
      : db.prepare('SELECT id FROM folders WHERE parent_id = ?         AND name = ?').get(parentId, name);
    if (row) {
      parentId = row.id;
    } else {
      const info = db.prepare(
        'INSERT INTO folders (parent_id, name, created_at) VALUES (?, ?, ?)'
      ).run(parentId, name, now());
      parentId = info.lastInsertRowid;
    }
  }
  return parentId;
}

export default async function importRoutes(app) {
  app.addHook('preHandler', requireAuth);

  // POST /api/import — atomic bulk import.
  //
  // Body:
  //   {
  //     "folder": "工作/2025/Q3",          // optional; null/empty → 未归类
  //     "notes": [
  //       { "title": "...", "content": "...", "format": "txt" | "md" },
  //       ...
  //     ]
  //   }
  //
  // Folder path segments are looked up (case-sensitive) and created when missing.
  // Wraps everything in a single transaction — either all notes import, or none.
  app.post('/api/import', async (req, reply) => {
    const { folder, notes } = req.body ?? {};
    if (!Array.isArray(notes) || notes.length === 0) {
      return reply.code(400).send({ error: 'notes_required' });
    }
    if (notes.length > MAX_NOTES_PER_IMPORT) {
      return reply.code(400).send({ error: 'too_many_notes', max: MAX_NOTES_PER_IMPORT });
    }
    // Pre-validate everything before opening a transaction.
    for (const n of notes) {
      if (typeof n !== 'object' || n === null) {
        return reply.code(400).send({ error: 'invalid_note_shape' });
      }
      const title   = n.title   ?? '';
      const content = n.content ?? '';
      const format  = n.format  ?? 'txt';
      if (typeof title   !== 'string' || title.length   > MAX_TITLE)   return reply.code(400).send({ error: 'invalid_title' });
      if (typeof content !== 'string' || content.length > MAX_CONTENT) return reply.code(400).send({ error: 'invalid_content' });
      if (typeof format  !== 'string' || !VALID_FORMATS.has(format))   return reply.code(400).send({ error: 'invalid_format' });
    }

    const insertNote = db.prepare(
      `INSERT INTO notes (folder_id, title, content, format, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const selectNote = db.prepare(
      `SELECT id, folder_id, title, format, content, created_at, updated_at FROM notes WHERE id = ?`
    );
    const insertVersion = db.prepare(
      `INSERT INTO note_versions (note_id, content, saved_at) VALUES (?, ?, ?)`
    );

    let folderId = null;
    let created  = [];
    try {
      db.transaction(() => {
        folderId = ensureFolderPath(folder);
        const ts = now();
        for (const n of notes) {
          const title   = n.title   ?? '';
          const content = n.content ?? '';
          const format  = n.format  ?? 'txt';
          const info = insertNote.run(folderId, title, content, format, ts, ts);
          if (content.length > 0) insertVersion.run(info.lastInsertRowid, content, ts);
          created.push(selectNote.get(info.lastInsertRowid));
        }
      })();
    } catch (e) {
      const msg = String(e?.message || '');
      if (msg === 'path_too_deep' || msg === 'segment_too_long') {
        return reply.code(400).send({ error: msg });
      }
      throw e;
    }

    return reply.code(201).send({
      folder_id:   folderId,
      folder_path: folder ?? null,
      count:       created.length,
      notes:       created,
    });
  });
}
