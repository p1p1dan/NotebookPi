// Database access layer.
//
// Single-file SQLite under app_local_data_dir/notebookpi.db, opened through an
// r2d2 connection pool so sync workers, IPC commands, and tray actions can
// share the same DB without serialising on a single Mutex.
//
// Migrations are append-only: bump SCHEMA_VERSION and add a new block. We use
// `user_version` PRAGMA so older DBs upgrade in place.

use anyhow::{anyhow, Context, Result};
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::params;
use std::path::PathBuf;

pub type DbPool = Pool<SqliteConnectionManager>;
pub type PooledConn = r2d2::PooledConnection<SqliteConnectionManager>;

const SCHEMA_VERSION: i32 = 2;

pub fn open(db_path: &PathBuf) -> Result<DbPool> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let manager = SqliteConnectionManager::file(db_path).with_init(|c| {
        c.pragma_update(None, "journal_mode", "WAL")?;
        c.pragma_update(None, "foreign_keys", "ON")?;
        c.pragma_update(None, "synchronous", "NORMAL")?;
        Ok(())
    });
    let pool = Pool::builder()
        .max_size(8)
        .build(manager)
        .context("build sqlite pool")?;
    let conn = pool.get()?;
    migrate(&conn)?;
    Ok(pool)
}

fn migrate(conn: &PooledConn) -> Result<()> {
    let v: i32 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap_or(0);
    if v >= SCHEMA_VERSION {
        return Ok(());
    }

    if v < 1 {
        conn.execute_batch(MIGRATION_V1).context("apply v1 schema")?;
    }
    if v < 2 {
        conn.execute_batch(MIGRATION_V2).context("apply v2 schema")?;
    }

    conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    Ok(())
}

const MIGRATION_V1: &str = r#"
CREATE TABLE IF NOT EXISTS folders (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    remote_id         INTEGER UNIQUE,
    parent_remote_id  INTEGER,
    name              TEXT NOT NULL,
    path              TEXT NOT NULL,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_folders_path ON folders(path);

CREATE TABLE IF NOT EXISTS notes (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    remote_id         INTEGER UNIQUE,
    folder_remote_id  INTEGER,
    folder_path       TEXT,
    title             TEXT NOT NULL DEFAULT '',
    content           TEXT NOT NULL DEFAULT '',
    format            TEXT NOT NULL DEFAULT 'txt',
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    last_synced_at    INTEGER,
    sync_status       TEXT NOT NULL DEFAULT 'synced',
    deleted           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_notes_folder_remote_id ON notes(folder_remote_id);
CREATE INDEX IF NOT EXISTS idx_notes_sync_status ON notes(sync_status);
CREATE INDEX IF NOT EXISTS idx_notes_updated_at ON notes(updated_at DESC);

CREATE TABLE IF NOT EXISTS sync_queue (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    operation         TEXT NOT NULL,            -- 'create' | 'update' | 'delete'
    note_local_id     INTEGER,
    remote_id         INTEGER,
    payload_json      TEXT NOT NULL DEFAULT '{}',
    status            TEXT NOT NULL DEFAULT 'pending',  -- pending | running | failed | done
    retry_count       INTEGER NOT NULL DEFAULT 0,
    last_error        TEXT,
    next_attempt_at   INTEGER NOT NULL DEFAULT 0,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON sync_queue(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"#;

// v2: store the server-provided excerpt so list views never show "empty" before
// the full content is fetched on demand.
const MIGRATION_V2: &str = r#"
ALTER TABLE notes ADD COLUMN excerpt TEXT NOT NULL DEFAULT '';
"#;

pub fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn get_setting(conn: &PooledConn, key: &str) -> Result<Option<String>> {
    let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
    let mut rows = stmt.query(params![key])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row.get(0)?))
    } else {
        Ok(None)
    }
}

pub fn put_setting(conn: &PooledConn, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO settings(key, value) VALUES(?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub fn delete_setting(conn: &PooledConn, key: &str) -> Result<()> {
    conn.execute("DELETE FROM settings WHERE key = ?1", params![key])?;
    Ok(())
}

pub fn count_pending(conn: &PooledConn) -> Result<(i64, i64)> {
    let pending: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sync_queue WHERE status IN ('pending','running')",
        [],
        |r| r.get(0),
    )?;
    let failed: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sync_queue WHERE status = 'failed'",
        [],
        |r| r.get(0),
    )?;
    Ok((pending, failed))
}

pub fn last_error(conn: &PooledConn) -> Result<Option<String>> {
    let mut stmt =
        conn.prepare("SELECT last_error FROM sync_queue WHERE status = 'failed' ORDER BY updated_at DESC LIMIT 1")?;
    let mut rows = stmt.query([])?;
    if let Some(row) = rows.next()? {
        Ok(row.get::<_, Option<String>>(0)?)
    } else {
        Ok(None)
    }
}

pub fn ensure_present(path: &PathBuf) -> Result<()> {
    if !path.exists() {
        return Err(anyhow!("db file missing at {}", path.display()));
    }
    Ok(())
}
