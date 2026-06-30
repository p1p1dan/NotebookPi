// Sync engine: pull-from-remote then drain the local write queue.
//
// State transitions per note (`notes.sync_status`):
//   pending_create  -- POST  /api/notes  --> synced (with remote_id)
//   pending_update  -- PUT   /api/notes/:id --> synced
//   pending_delete  -- DEL   /api/notes/:id --> hard-deleted locally
//   conflict        -- user resolves manually (out of scope for v1 worker)
//
// Queue items mirror these operations and carry their own retry counter so
// failures are isolated: one bad item never blocks the next.

use crate::db::{count_pending, last_error, now_ms, DbPool, PooledConn};
use crate::http::{ApiClient, ApiError, RemoteFolder, RemoteNote, RemoteNoteLite};
use crate::models::{NoteFormat, SyncStatusReport};
use anyhow::{Context, Result};
use rusqlite::params;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::{Mutex, Notify};

const MAX_RETRIES: i64 = 8;
// 1s, 5s, 30s, 5m, 30m, 2h cap.
const BACKOFF_MS: [i64; 6] = [1_000, 5_000, 30_000, 300_000, 1_800_000, 7_200_000];

pub struct Engine {
    pool: DbPool,
    app_data_dir: std::path::PathBuf,
    last_sync_at: Mutex<Option<i64>>,
    running: AtomicBool,
    online: AtomicBool,
    /// Wakes the loop ahead of schedule (cmd_sync_now / write events).
    pub kicker: Arc<Notify>,
}

impl Engine {
    pub fn new(pool: DbPool, app_data_dir: std::path::PathBuf) -> Self {
        Self {
            pool,
            app_data_dir,
            last_sync_at: Mutex::new(None),
            running: AtomicBool::new(false),
            online: AtomicBool::new(false),
            kicker: Arc::new(Notify::new()),
        }
    }

    fn build_client(&self) -> Option<ApiClient> {
        self.build_client_async()
    }

    /// Public alias so command handlers can pull a client when needed.
    /// Synchronous since it only reads disk and decrypts the token.
    pub fn build_client_async(&self) -> Option<ApiClient> {
        let pool = self.pool.clone();
        let server = match pool.get().ok().and_then(|c| {
            crate::db::get_setting(&c, "server_url")
                .ok()
                .flatten()
        }) {
            Some(s) => s,
            None => return None,
        };
        let token = match crate::secrets::read_token(&self.app_data_dir).ok().flatten() {
            Some(t) => t,
            None => return None,
        };
        ApiClient::new(&server, &token).ok()
    }

    pub async fn status(&self) -> Result<SyncStatusReport> {
        let conn = self.pool.get()?;
        let (pending, failed) = count_pending(&conn)?;
        let last_err = last_error(&conn)?;
        let configured = self.build_client().is_some();
        let last_at = *self.last_sync_at.lock().await;
        Ok(SyncStatusReport {
            configured,
            online: self.online.load(Ordering::Relaxed),
            last_sync_at: last_at,
            pending,
            failed,
            last_error: last_err,
            running: self.running.load(Ordering::Relaxed),
        })
    }

    /// Run a single sync cycle: pull then drain queue. Returns Ok even when
    /// individual queue items fail — those go to `sync_failed`.
    pub async fn sync_once(&self) -> Result<()> {
        if self.running.swap(true, Ordering::SeqCst) {
            return Ok(()); // already running
        }
        let res = self.run_cycle().await;
        self.running.store(false, Ordering::SeqCst);
        res
    }

    async fn run_cycle(&self) -> Result<()> {
        let client = match self.build_client() {
            Some(c) => c,
            None => {
                self.online.store(false, Ordering::Relaxed);
                return Ok(());
            }
        };

        // Reachability ping. A failure here keeps us offline but doesn't error.
        match client.ping().await {
            Ok(_) => self.online.store(true, Ordering::Relaxed),
            Err(_) => {
                self.online.store(false, Ordering::Relaxed);
                return Ok(());
            }
        }

        if let Err(e) = self.pull(&client).await {
            log::warn!("pull failed: {e}");
        }
        if let Err(e) = self.drain(&client).await {
            log::warn!("drain failed: {e}");
        }

        let now = now_ms();
        *self.last_sync_at.lock().await = Some(now);
        let _ = crate::config::write_last_sync_at(&self.pool, now);
        Ok(())
    }

    // ---------------- pull ----------------

    async fn pull(&self, client: &ApiClient) -> Result<()> {
        let folders = client.list_folders().await.context("list folders")?;
        let notes = client.list_all_notes().await.context("list notes")?;

        let pool = self.pool.clone();
        let conn = pool.get()?;

        upsert_folders(&conn, &folders).context("upsert folders")?;
        upsert_notes_lite(&conn, &notes).context("upsert notes")?;
        Ok(())
    }

    // ---------------- queue drain ----------------

    async fn drain(&self, client: &ApiClient) -> Result<()> {
        let now = now_ms();
        let items: Vec<QueueItem> = {
            let conn = self.pool.get()?;
            load_due_queue(&conn, now)?
        };

        for item in items {
            // Mark running.
            {
                let conn = self.pool.get()?;
                conn.execute(
                    "UPDATE sync_queue SET status='running', updated_at=?1 WHERE id=?2",
                    params![now_ms(), item.id],
                )?;
            }

            let outcome = self.execute_item(client, &item).await;
            let conn = self.pool.get()?;
            match outcome {
                Ok(_) => {
                    conn.execute(
                        "UPDATE sync_queue SET status='done', updated_at=?1, last_error=NULL WHERE id=?2",
                        params![now_ms(), item.id],
                    )?;
                }
                Err(e) => {
                    let retry = item.retry_count + 1;
                    let final_failed = retry >= MAX_RETRIES;
                    let next_attempt =
                        now_ms() + BACKOFF_MS[(retry as usize - 1).min(BACKOFF_MS.len() - 1)];
                    conn.execute(
                        "UPDATE sync_queue
                            SET status = CASE WHEN ?1 THEN 'failed' ELSE 'pending' END,
                                retry_count = ?2,
                                last_error = ?3,
                                next_attempt_at = ?4,
                                updated_at = ?5
                            WHERE id = ?6",
                        params![
                            final_failed,
                            retry,
                            e.to_string(),
                            next_attempt,
                            now_ms(),
                            item.id
                        ],
                    )?;
                    if final_failed {
                        if let Some(local_id) = item.note_local_id {
                            // Promote the note to sync_failed only if it's still in a pending
                            // state — user may have edited again, generating a fresh queue
                            // item that hasn't run yet.
                            conn.execute(
                                "UPDATE notes
                                    SET sync_status='sync_failed', updated_at=?1
                                  WHERE id=?2 AND sync_status LIKE 'pending_%'",
                                params![now_ms(), local_id],
                            )?;
                        }
                    }
                }
            }
        }
        Ok(())
    }

    async fn execute_item(&self, client: &ApiClient, item: &QueueItem) -> Result<()> {
        match item.operation.as_str() {
            "create" => self.exec_create(client, item).await,
            "update" => self.exec_update(client, item).await,
            "delete" => self.exec_delete(client, item).await,
            other => Err(anyhow::anyhow!("unknown op {other}")),
        }
    }

    async fn exec_create(&self, client: &ApiClient, item: &QueueItem) -> Result<()> {
        let local_id = item.note_local_id.context("create needs local_id")?;
        // Snapshot current note state (user may have edited since enqueue).
        let snap: NoteSnapshot = {
            let conn = self.pool.get()?;
            load_note_snapshot(&conn, local_id)?
        };
        if snap.deleted {
            // User deleted before create ever ran. Drop locally.
            let conn = self.pool.get()?;
            conn.execute("DELETE FROM notes WHERE id=?1", params![local_id])?;
            return Ok(());
        }
        let folder_id = self.resolve_folder(client, snap.folder_path.as_deref()).await?;
        let remote = client
            .create_note(folder_id, &snap.title, &snap.content, snap.format)
            .await?;
        // Save remote_id, clear pending status.
        let conn = self.pool.get()?;
        conn.execute(
            "UPDATE notes
                SET remote_id=?1, folder_remote_id=?2,
                    sync_status='synced', last_synced_at=?3
              WHERE id=?4",
            params![remote.id, remote.folder_id, now_ms(), local_id],
        )?;
        // Any later pending update/delete in queue for this local_id needs the new remote_id.
        conn.execute(
            "UPDATE sync_queue SET remote_id=?1 WHERE note_local_id=?2 AND remote_id IS NULL",
            params![remote.id, local_id],
        )?;
        Ok(())
    }

    async fn exec_update(&self, client: &ApiClient, item: &QueueItem) -> Result<()> {
        let local_id = item.note_local_id.context("update needs local_id")?;
        let snap: NoteSnapshot = {
            let conn = self.pool.get()?;
            load_note_snapshot(&conn, local_id)?
        };
        let remote_id = match snap.remote_id.or(item.remote_id) {
            Some(id) => id,
            None => {
                // Note was queued for update before its create finished.
                // Drop this queue item; the create will leave the note synced.
                return Ok(());
            }
        };
        let patch = serde_json::json!({
            "title": snap.title,
            "content": snap.content,
            "format": snap.format.as_str(),
            "folder_id": snap.folder_remote_id,
        });
        let _ = client.update_note(remote_id, &patch).await?;
        let conn = self.pool.get()?;
        conn.execute(
            "UPDATE notes
                SET sync_status='synced', last_synced_at=?1
              WHERE id=?2 AND sync_status='pending_update'",
            params![now_ms(), local_id],
        )?;
        Ok(())
    }

    async fn exec_delete(&self, client: &ApiClient, item: &QueueItem) -> Result<()> {
        let remote_id = match item.remote_id {
            Some(id) => id,
            None => {
                // Local-only note that never made it to the server: just hard-delete.
                if let Some(local_id) = item.note_local_id {
                    let conn = self.pool.get()?;
                    conn.execute("DELETE FROM notes WHERE id=?1", params![local_id])?;
                }
                return Ok(());
            }
        };
        match client.delete_note(remote_id).await {
            Ok(_) => {}
            Err(ApiError::Server { status: 404, .. }) => {
                // Already gone server-side, treat as success.
            }
            Err(e) => return Err(e.into()),
        }
        if let Some(local_id) = item.note_local_id {
            let conn = self.pool.get()?;
            conn.execute("DELETE FROM notes WHERE id=?1", params![local_id])?;
        }
        Ok(())
    }

    async fn resolve_folder(
        &self,
        client: &ApiClient,
        folder_path: Option<&str>,
    ) -> Result<Option<i64>> {
        let p = match folder_path {
            Some(p) if !p.trim().is_empty() => p.trim(),
            _ => return Ok(None), // 未归类
        };
        // Try local cache first.
        {
            let conn = self.pool.get()?;
            if let Some(id) = lookup_folder_remote_id(&conn, p)? {
                return Ok(Some(id));
            }
        }
        // Ask server (creates if missing).
        let r = client.ensure_folder_path(p).await?;
        // Re-pull folders so the new id lands in cache.
        if let Ok(fs) = client.list_folders().await {
            let conn = self.pool.get()?;
            upsert_folders(&conn, &fs).ok();
        }
        Ok(r.id)
    }
}

// ---------------- helpers ----------------

#[derive(Debug, Clone)]
struct QueueItem {
    id: i64,
    operation: String,
    note_local_id: Option<i64>,
    remote_id: Option<i64>,
    retry_count: i64,
}

fn load_due_queue(conn: &PooledConn, now: i64) -> Result<Vec<QueueItem>> {
    let mut stmt = conn.prepare(
        "SELECT id, operation, note_local_id, remote_id, retry_count
            FROM sync_queue
            WHERE status IN ('pending')
              AND next_attempt_at <= ?1
            ORDER BY created_at ASC",
    )?;
    let rows = stmt.query_map(params![now], |r| {
        Ok(QueueItem {
            id: r.get(0)?,
            operation: r.get(1)?,
            note_local_id: r.get(2)?,
            remote_id: r.get(3)?,
            retry_count: r.get(4)?,
        })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[derive(Debug, Clone)]
struct NoteSnapshot {
    remote_id: Option<i64>,
    folder_remote_id: Option<i64>,
    folder_path: Option<String>,
    title: String,
    content: String,
    format: NoteFormat,
    deleted: bool,
}

fn load_note_snapshot(conn: &PooledConn, local_id: i64) -> Result<NoteSnapshot> {
    let mut stmt = conn.prepare(
        "SELECT remote_id, folder_remote_id, folder_path, title, content, format, deleted
            FROM notes WHERE id=?1",
    )?;
    let row = stmt.query_row(params![local_id], |r| {
        Ok(NoteSnapshot {
            remote_id: r.get(0)?,
            folder_remote_id: r.get(1)?,
            folder_path: r.get(2)?,
            title: r.get(3)?,
            content: r.get(4)?,
            format: NoteFormat::from_str_or_default(&r.get::<_, String>(5)?),
            deleted: r.get::<_, i64>(6)? != 0,
        })
    })?;
    Ok(row)
}

fn lookup_folder_remote_id(conn: &PooledConn, path: &str) -> Result<Option<i64>> {
    let mut stmt =
        conn.prepare("SELECT remote_id FROM folders WHERE path=?1 AND remote_id IS NOT NULL")?;
    let mut rows = stmt.query(params![path])?;
    if let Some(row) = rows.next()? {
        return Ok(Some(row.get(0)?));
    }
    Ok(None)
}

fn upsert_folders(conn: &PooledConn, remote: &[RemoteFolder]) -> Result<()> {
    // First pass: index remote folders by id.
    let by_id: HashMap<i64, &RemoteFolder> = remote.iter().map(|f| (f.id, f)).collect();

    // Compute path for each remote folder.
    fn path_of(by_id: &HashMap<i64, &RemoteFolder>, id: i64) -> String {
        let mut parts = Vec::new();
        let mut cur = id;
        for _ in 0..32 {
            let f = match by_id.get(&cur) {
                Some(f) => *f,
                None => break,
            };
            parts.push(f.name.clone());
            match f.parent_id {
                Some(p) => cur = p,
                None => break,
            }
        }
        parts.reverse();
        parts.join("/")
    }

    let now = now_ms();
    for f in remote {
        let path = path_of(&by_id, f.id);
        conn.execute(
            "INSERT INTO folders(remote_id, parent_remote_id, name, path, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(remote_id) DO UPDATE SET
                parent_remote_id = excluded.parent_remote_id,
                name = excluded.name,
                path = excluded.path,
                updated_at = excluded.updated_at",
            params![f.id, f.parent_id, f.name, path, f.created_at, now],
        )?;
    }
    Ok(())
}

fn upsert_notes_lite(conn: &PooledConn, remote: &[RemoteNoteLite]) -> Result<()> {
    let now = now_ms();
    for n in remote {
        // 1) Skip notes the local user is still editing offline.
        let local_status: Option<String> = conn
            .query_row(
                "SELECT sync_status FROM notes WHERE remote_id=?1",
                params![n.id],
                |r| r.get(0),
            )
            .ok();
        if let Some(s) = local_status.as_deref() {
            if s.starts_with("pending_") || s == "sync_failed" || s == "conflict" {
                continue;
            }
        }
        // 2) Respect last_synced_at: only overwrite when remote is newer.
        let local_synced_at: Option<i64> = conn
            .query_row(
                "SELECT last_synced_at FROM notes WHERE remote_id=?1",
                params![n.id],
                |r| r.get(0),
            )
            .ok();
        if let Some(ts) = local_synced_at {
            if n.updated_at <= ts {
                continue;
            }
        }
        conn.execute(
            "INSERT INTO notes(remote_id, folder_remote_id, title, content, format,
                                 created_at, updated_at, last_synced_at, sync_status, deleted, excerpt)
             VALUES (?1, ?2, ?3, COALESCE((SELECT content FROM notes WHERE remote_id=?1), ''),
                     ?4, ?5, ?6, ?7, 'synced', 0, ?8)
             ON CONFLICT(remote_id) DO UPDATE SET
                folder_remote_id = excluded.folder_remote_id,
                title = excluded.title,
                format = excluded.format,
                updated_at = excluded.updated_at,
                last_synced_at = excluded.last_synced_at,
                sync_status = 'synced',
                deleted = 0,
                excerpt = excluded.excerpt",
            params![
                n.id,
                n.folder_id,
                n.title,
                n.format,
                n.created_at,
                n.updated_at,
                now,
                n.excerpt.as_deref().unwrap_or("")
            ],
        )?;
    }
    Ok(())
}

/// Replace the local cached note's content with the full server payload.
/// Called on demand by `cmd_get_note` so list views stay lean.
pub fn upsert_note_full(conn: &PooledConn, n: &RemoteNote) -> Result<()> {
    let now = now_ms();
    let excerpt: String = n.content.chars().take(240).collect();
    conn.execute(
        "INSERT INTO notes(remote_id, folder_remote_id, title, content, format,
                             created_at, updated_at, last_synced_at, sync_status, deleted, excerpt)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'synced', 0, ?9)
         ON CONFLICT(remote_id) DO UPDATE SET
            folder_remote_id = excluded.folder_remote_id,
            title = excluded.title,
            content = excluded.content,
            format = excluded.format,
            updated_at = excluded.updated_at,
            last_synced_at = excluded.last_synced_at,
            sync_status = 'synced',
            deleted = 0,
            excerpt = excluded.excerpt",
        params![
            n.id,
            n.folder_id,
            n.title,
            n.content,
            n.format,
            n.created_at,
            n.updated_at,
            now,
            excerpt
        ],
    )?;
    Ok(())
}
