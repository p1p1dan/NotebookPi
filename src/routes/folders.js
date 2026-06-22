import { db, now } from '../db.js';
import { requireAuth } from '../auth.js';

const MAX_NAME = 200;

function validName(name) {
  return typeof name === 'string' && name.trim().length > 0 && name.length <= MAX_NAME;
}

// Walk ancestors of `parentId` to ensure `selfId` is not among them.
// Returns true if moving `selfId` under `parentId` would create a cycle.
function wouldCycle(selfId, parentId) {
  let cur = parentId;
  while (cur != null) {
    if (cur === selfId) return true;
    const row = db.prepare('SELECT parent_id FROM folders WHERE id = ?').get(cur);
    if (!row) return false;
    cur = row.parent_id;
  }
  return false;
}

export default async function folderRoutes(app) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/folders', async () => {
    const rows = db.prepare(
      `SELECT f.id, f.parent_id, f.name, f.created_at,
              (SELECT COUNT(*) FROM notes n WHERE n.folder_id = f.id) AS note_count
       FROM folders f
       ORDER BY f.name COLLATE NOCASE`
    ).all();
    return { folders: rows };
  });

  app.post('/api/folders', async (req, reply) => {
    const { parent_id = null, name } = req.body ?? {};
    if (!validName(name)) return reply.code(400).send({ error: 'invalid_name' });
    if (parent_id != null) {
      const parent = db.prepare('SELECT id FROM folders WHERE id = ?').get(parent_id);
      if (!parent) return reply.code(400).send({ error: 'parent_not_found' });
    }
    try {
      const info = db.prepare(
        'INSERT INTO folders (parent_id, name, created_at) VALUES (?, ?, ?)'
      ).run(parent_id, name.trim(), now());
      const folder = db.prepare(
        'SELECT id, parent_id, name, created_at FROM folders WHERE id = ?'
      ).get(info.lastInsertRowid);
      return reply.code(201).send({ folder });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        return reply.code(409).send({ error: 'name_conflict' });
      }
      throw e;
    }
  });

  app.patch('/api/folders/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'invalid_id' });
    const existing = db.prepare('SELECT id, parent_id, name FROM folders WHERE id = ?').get(id);
    if (!existing) return reply.code(404).send({ error: 'not_found' });

    const { name, parent_id } = req.body ?? {};
    const updates = {};
    if (name !== undefined) {
      if (!validName(name)) return reply.code(400).send({ error: 'invalid_name' });
      updates.name = name.trim();
    }
    if (parent_id !== undefined) {
      if (parent_id != null) {
        const parent = db.prepare('SELECT id FROM folders WHERE id = ?').get(parent_id);
        if (!parent) return reply.code(400).send({ error: 'parent_not_found' });
        if (wouldCycle(id, parent_id)) return reply.code(400).send({ error: 'cycle' });
      }
      updates.parent_id = parent_id;
    }
    if (Object.keys(updates).length === 0) return { folder: existing };

    const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    try {
      db.prepare(`UPDATE folders SET ${setClause} WHERE id = ?`).run(...Object.values(updates), id);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        return reply.code(409).send({ error: 'name_conflict' });
      }
      throw e;
    }
    const folder = db.prepare(
      'SELECT id, parent_id, name, created_at FROM folders WHERE id = ?'
    ).get(id);
    return { folder };
  });

  app.delete('/api/folders/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'invalid_id' });
    const info = db.prepare('DELETE FROM folders WHERE id = ?').run(id);
    if (info.changes === 0) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });
}
