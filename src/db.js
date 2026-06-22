import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const DB_PATH = resolve(process.env.DB_PATH || './data/notebook.db');
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

// --- Schema ----------------------------------------------------------------
// folders: nullable parent_id allows nesting; NULL = root.
// notes:   folder_id NULL = root-level note. content is markdown source.
// notes_fts: FTS5 external-content table, kept in sync via triggers.
//           trigram tokenizer handles Chinese + English without a custom segmenter.
// note_versions: append-only snapshot per save; cleanup to 50 is done in app code.
// shares: random tokens → read-only public access to a note.
db.exec(`
CREATE TABLE IF NOT EXISTS folders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id   INTEGER REFERENCES folders(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE(parent_id, name)
);

CREATE TABLE IF NOT EXISTS notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_id   INTEGER REFERENCES folders(id) ON DELETE SET NULL,
  title       TEXT    NOT NULL DEFAULT '',
  content     TEXT    NOT NULL DEFAULT '',
  format      TEXT    NOT NULL DEFAULT 'txt' CHECK (format IN ('txt', 'md')),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_folder    ON notes(folder_id);
CREATE INDEX IF NOT EXISTS idx_notes_updated   ON notes(updated_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  title, content,
  content='notes', content_rowid='id',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;
CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
END;
CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
  INSERT INTO notes_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;

CREATE TABLE IF NOT EXISTS note_versions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id    INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  content    TEXT    NOT NULL,
  saved_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_versions_note ON note_versions(note_id, saved_at DESC);

CREATE TABLE IF NOT EXISTS shares (
  token       TEXT    PRIMARY KEY,
  note_id     INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_shares_note ON shares(note_id);
`);

// --- Lightweight migrations ------------------------------------------------
// Existing dev DBs created before the format column was added need it backfilled.
// Use a one-shot ALTER guarded by a check on the table schema.
const cols = db.prepare("PRAGMA table_info(notes)").all().map(r => r.name);
if (!cols.includes('format')) {
  db.exec(`ALTER TABLE notes ADD COLUMN format TEXT NOT NULL DEFAULT 'txt'`);
}

export const now = () => Date.now();
