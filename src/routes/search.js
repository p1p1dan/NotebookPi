import { db } from '../db.js';
import { requireAuth } from '../auth.js';

const MAX_RESULTS = 50;
const MAX_QUERY_LEN = 200;

// FTS5 trigram tokenizer needs ≥3 chars to produce any token, so short queries
// fall back to LIKE on title + content. Above that, MATCH is much faster and
// gives us snippet() highlighting for free.
const MIN_FTS_LEN = 3;

// Escape user input for an FTS5 quoted-phrase query.
const ftsPhrase = (s) => '"' + s.replace(/"/g, '""') + '"';
// Escape user input for SQL LIKE (with ESCAPE '\\').
const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);

export default async function searchRoutes(app) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/search', async (req, reply) => {
    const q = String(req.query?.q ?? '').trim();
    if (!q) return { query: '', results: [] };
    if (q.length > MAX_QUERY_LEN) {
      return reply.code(400).send({ error: 'query_too_long' });
    }

    let results;
    if (q.length >= MIN_FTS_LEN) {
      try {
        results = db.prepare(
          `SELECT n.id, n.folder_id, n.title, n.format, n.updated_at,
                  snippet(notes_fts, 1, '<mark>', '</mark>', '…', 16) AS snippet
           FROM notes_fts
           JOIN notes n ON n.id = notes_fts.rowid
           WHERE notes_fts MATCH ?
           ORDER BY rank
           LIMIT ?`
        ).all(ftsPhrase(q), MAX_RESULTS);
      } catch (e) {
        // Invalid MATCH expression — fall through to LIKE.
        app.log.warn({ err: String(e), q }, 'FTS query rejected, falling back to LIKE');
        results = null;
      }
    }

    if (!results) {
      const pat = `%${escapeLike(q)}%`;
      results = db.prepare(
        `SELECT id, folder_id, title, format, updated_at,
                SUBSTR(content, 1, 240) AS snippet
         FROM notes
         WHERE title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\'
         ORDER BY updated_at DESC
         LIMIT ?`
      ).all(pat, pat, MAX_RESULTS);
    }

    return { query: q, results };
  });
}
