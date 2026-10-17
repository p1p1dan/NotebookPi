use crate::commands::CmdResult;
use crate::db::{now_ms, DbPool};
use crate::models::{
    CreateNoteInput, Note, NoteFormat, NoteLite, SyncStatus, UpdateNoteInput,
};
use crate::AppState;
use rusqlite::params;
use serde::Deserialize;
use tauri::{AppHandle, Emitter, State};

const EXCERPT_LEN: usize = 240;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
#[serde(tag = "kind", content = "value")]
pub enum FolderFilter {
    All,
    Unfiled,
    Remote(i64),
    LocalPath(String),
}

#[tauri::command]
pub fn cmd_list_notes(
    state: State<'_, AppState>,
    folder_id: Option<serde_json::Value>,
) -> CmdResult<Vec<NoteLite>> {
    let pool = &state.pool;
    let mut where_sql = String::from("WHERE deleted=0");
    let mut binds: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    match folder_id {
        Some(serde_json::Value::String(s)) if s == "all" => {}
        Some(serde_json::Value::Null) | None => {
            where_sql.push_str(" AND folder_remote_id IS NULL");
        }
        Some(serde_json::Value::Number(n)) => {
            if let Some(id) = n.as_i64() {
                where_sql.push_str(" AND folder_remote_id = ?1");
                binds.push(Box::new(id));
            }
        }
        Some(other) => {
            return Err(format!("invalid folder_id: {other:?}").into());
        }
    }
    let conn = pool.get().map_err(crate::commands::CmdError::from)?;
    let sql = format!(
        "SELECT id, remote_id, folder_remote_id, folder_path, title, content, format,
              created_at, updated_at, last_synced_at, sync_status, deleted, excerpt, pinned
              FROM notes {where_sql}
             ORDER BY pinned DESC, updated_at DESC"
    );
    let mut stmt = conn.prepare(&sql).map_err(crate::commands::CmdError::from)?;
    let binds_ref: Vec<&dyn rusqlite::ToSql> = binds.iter().map(|b| b.as_ref()).collect();
    let rows = stmt
        .query_map(binds_ref.as_slice(), |r| {
            let content: String = r.get(5)?;
            let stored_excerpt: String = r.get(12).unwrap_or_default();
            // Prefer the cached server-side excerpt; fall back to a head-of-content
            // truncation when only local content exists.
            let excerpt = if !stored_excerpt.is_empty() {
                Some(stored_excerpt)
            } else if !content.is_empty() {
                Some(truncate(&content, EXCERPT_LEN))
            } else {
                None
            };
            Ok(NoteLite {
                id: r.get(0)?,
                remote_id: r.get(1)?,
                folder_remote_id: r.get(2)?,
                folder_path: r.get(3)?,
                title: r.get(4)?,
                format: NoteFormat::from_str_or_default(&r.get::<_, String>(6)?),
                excerpt,
                created_at: r.get(7)?,
                updated_at: r.get(8)?,
                last_synced_at: r.get(9)?,
                sync_status: SyncStatus::from_str_or_synced(&r.get::<_, String>(10)?),
                deleted: r.get::<_, i64>(11)? != 0,
                pinned: r.get::<_, i64>(13)? != 0,
            })
        })
        .map_err(crate::commands::CmdError::from)?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub async fn cmd_get_note(state: State<'_, AppState>, local_id: i64) -> CmdResult<Note> {
    let pool = state.pool.clone();
    // First pull the local snapshot.
    let local = read_full(&pool, local_id)?;

    // Best-effort fresh fetch when synced and online — keeps content current
    // without forcing a full sync cycle.
    if local.sync_status == SyncStatus::Synced {
        if let Some(remote_id) = local.remote_id {
            if let Some(client) = state.engine.build_client_async() {
                if let Ok(rn) = client.get_note(remote_id).await {
                    let conn = pool.get().map_err(crate::commands::CmdError::from)?;
                    crate::sync::upsert_note_full(&conn, &rn)
                        .map_err(crate::commands::CmdError::from)?;
                    return Ok(read_full(&pool, local_id)?);
                }
            }
        }
    }
    Ok(local)
}

fn read_full(pool: &DbPool, local_id: i64) -> Result<Note, crate::commands::CmdError> {
    let conn = pool.get().map_err(crate::commands::CmdError::from)?;
    conn.query_row(
        "SELECT id, remote_id, folder_remote_id, folder_path, title, content, format,
                created_at, updated_at, last_synced_at, sync_status, deleted, pinned
            FROM notes WHERE id=?1",
        params![local_id],
        |r| {
            Ok(Note {
                id: r.get(0)?,
                remote_id: r.get(1)?,
                folder_remote_id: r.get(2)?,
                folder_path: r.get(3)?,
                title: r.get(4)?,
                content: r.get(5)?,
                format: NoteFormat::from_str_or_default(&r.get::<_, String>(6)?),
                created_at: r.get(7)?,
                updated_at: r.get(8)?,
                last_synced_at: r.get(9)?,
                sync_status: SyncStatus::from_str_or_synced(&r.get::<_, String>(10)?),
                deleted: r.get::<_, i64>(11)? != 0,
                pinned: r.get::<_, i64>(12)? != 0,
            })
        },
    )
    .map_err(crate::commands::CmdError::from)
}

#[tauri::command]
pub async fn cmd_create_note(
    app: AppHandle,
    state: State<'_, AppState>,
    input: CreateNoteInput,
) -> CmdResult<Note> {
    let pool = state.pool.clone();
    let now = now_ms();
    let format = input.format.unwrap_or(NoteFormat::Txt);
    let title = input.title.unwrap_or_default();
    let content = input.content.unwrap_or_default();
    let excerpt: String = content.chars().take(EXCERPT_LEN).collect();

    // Resolve folder_path / folder_remote_id locally so list view filters work
    // even before the next sync. Path takes precedence when supplied.
    let (folder_remote_id, folder_path) = if let Some(p) = input.folder_path.as_deref() {
        let p = p.trim().trim_matches('/').to_string();
        let resolved_id = if p.is_empty() {
            None
        } else {
            let conn = pool.get().map_err(crate::commands::CmdError::from)?;
            conn.query_row(
                "SELECT remote_id FROM folders WHERE path=?1",
                params![p],
                |r| r.get::<_, Option<i64>>(0),
            )
            .ok()
            .flatten()
        };
        (resolved_id, if p.is_empty() { None } else { Some(p) })
    } else {
        (input.folder_remote_id, None)
    };

    let local_id = {
        let conn = pool.get().map_err(crate::commands::CmdError::from)?;
        conn.execute(
            "INSERT INTO notes(remote_id, folder_remote_id, folder_path, title, content, format,
                                 created_at, updated_at, last_synced_at, sync_status, deleted, excerpt)
             VALUES (NULL, ?1, ?2, ?3, ?4, ?5, ?6, ?6, NULL, 'pending_create', 0, ?7)",
            params![
                folder_remote_id,
                folder_path,
                title,
                content,
                format.as_str(),
                now,
                excerpt,
            ],
        )
        .map_err(crate::commands::CmdError::from)?;
        let id = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO sync_queue(operation, note_local_id, remote_id, payload_json,
                                      status, retry_count, last_error, next_attempt_at,
                                      created_at, updated_at)
             VALUES ('create', ?1, NULL, '{}', 'pending', 0, NULL, 0, ?2, ?2)",
            params![id, now],
        )
        .map_err(crate::commands::CmdError::from)?;
        id
    };

    state.engine.kicker.notify_one();
    let n = read_full(&pool, local_id)?;
    // Notify any open window (main + quick-note) that the cache changed.
    let _ = app.emit("notebookpi://notes-changed", &n.id);
    Ok(n)
}

#[tauri::command]
pub async fn cmd_update_note(
    app: AppHandle,
    state: State<'_, AppState>,
    local_id: i64,
    patch: UpdateNoteInput,
) -> CmdResult<Note> {
    let pool = state.pool.clone();
    let now = now_ms();

    let mut sets = Vec::<&'static str>::new();
    let mut binds: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    if let Some(t) = patch.title.as_ref() {
        sets.push("title=?");
        binds.push(Box::new(t.clone()));
    }
    if let Some(c) = patch.content.as_ref() {
        sets.push("content=?");
        binds.push(Box::new(c.clone()));
        // keep excerpt in sync so list view reflects new preview immediately
        let excerpt: String = c.chars().take(EXCERPT_LEN).collect();
        sets.push("excerpt=?");
        binds.push(Box::new(excerpt));
    }
    if let Some(f) = patch.format {
        sets.push("format=?");
        binds.push(Box::new(f.as_str().to_string()));
    }
    if let Some(folder) = patch.folder_remote_id {
        sets.push("folder_remote_id=?");
        binds.push(Box::new(folder));
    }
    // Pinning alone isn't an edit: it must not reorder the note by recency.
    let edits_content = !sets.is_empty();
    if let Some(p) = patch.pinned {
        sets.push("pinned=?");
        binds.push(Box::new(p));
    }
    if sets.is_empty() {
        return Ok(read_full(&pool, local_id)?);
    }
    if edits_content {
        sets.push("updated_at=?");
        binds.push(Box::new(now));
        sets.push(
            "sync_status=CASE WHEN sync_status='pending_create' THEN 'pending_create' ELSE 'pending_update' END",
        );
    }

    let sql = format!(
        "UPDATE notes SET {} WHERE id=?",
        sets.join(", ")
    );
    binds.push(Box::new(local_id));

    let conn = pool.get().map_err(crate::commands::CmdError::from)?;
    let binds_ref: Vec<&dyn rusqlite::ToSql> = binds.iter().map(|b| b.as_ref()).collect();
    conn.execute(&sql, binds_ref.as_slice())
        .map_err(crate::commands::CmdError::from)?;

    // Pin-only changes get their own op that sends just the flag: the list-view cache may
    // hold stale content, and a full-snapshot update would overwrite newer server edits.
    if !edits_content {
        conn.execute(
            "INSERT INTO sync_queue(operation, note_local_id, remote_id, payload_json,
                                     status, retry_count, last_error, next_attempt_at,
                                     created_at, updated_at)
             SELECT 'pin', ?1, remote_id, '{}', 'pending', 0, NULL, 0, ?2, ?2
               FROM notes
              WHERE id=?1
                AND NOT EXISTS (SELECT 1 FROM sync_queue
                                 WHERE note_local_id=?1 AND operation='pin' AND status='pending')",
            params![local_id, now],
        )
        .map_err(crate::commands::CmdError::from)?;
        state.engine.kicker.notify_one();
        let n = read_full(&pool, local_id)?;
        let _ = app.emit("notebookpi://notes-changed", &local_id);
        return Ok(n);
    }

    // Enqueue (skip if a pending_create or earlier pending_update is still in flight).
    let needs_queue: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sync_queue
                WHERE note_local_id=?1 AND status IN ('pending','running')
                  AND operation IN ('create','update')",
            params![local_id],
            |r| r.get::<_, i64>(0),
        )
        .map_err(crate::commands::CmdError::from)?
        == 0;

    if needs_queue {
        // Find remote_id (may be NULL if create still pending).
        let remote_id: Option<i64> = conn
            .query_row(
                "SELECT remote_id FROM notes WHERE id=?1",
                params![local_id],
                |r| r.get(0),
            )
            .ok()
            .flatten();
        conn.execute(
            "INSERT INTO sync_queue(operation, note_local_id, remote_id, payload_json,
                                     status, retry_count, last_error, next_attempt_at,
                                     created_at, updated_at)
             VALUES ('update', ?1, ?2, '{}', 'pending', 0, NULL, 0, ?3, ?3)",
            params![local_id, remote_id, now],
        )
        .map_err(crate::commands::CmdError::from)?;
    }

    state.engine.kicker.notify_one();
    let n = read_full(&pool, local_id)?;
    let _ = app.emit("notebookpi://notes-changed", &local_id);
    Ok(n)
}

#[tauri::command]
pub async fn cmd_delete_note(
    app: AppHandle,
    state: State<'_, AppState>,
    local_id: i64,
) -> CmdResult<()> {
    let pool = state.pool.clone();
    let now = now_ms();
    let conn = pool.get().map_err(crate::commands::CmdError::from)?;
    let remote_id: Option<i64> = conn
        .query_row(
            "SELECT remote_id FROM notes WHERE id=?1",
            params![local_id],
            |r| r.get(0),
        )
        .ok()
        .flatten();

    // Soft-delete locally so list view hides it immediately.
    conn.execute(
        "UPDATE notes SET deleted=1, sync_status='pending_delete', updated_at=?1 WHERE id=?2",
        params![now, local_id],
    )
    .map_err(crate::commands::CmdError::from)?;

    // Cancel any in-flight create/update/pin for this note.
    conn.execute(
        "UPDATE sync_queue
            SET status='done', updated_at=?1, last_error='superseded by delete'
          WHERE note_local_id=?2 AND status='pending' AND operation IN ('create','update','pin')",
        params![now, local_id],
    )
    .map_err(crate::commands::CmdError::from)?;

    if remote_id.is_some() {
        conn.execute(
            "INSERT INTO sync_queue(operation, note_local_id, remote_id, payload_json,
                                     status, retry_count, last_error, next_attempt_at,
                                     created_at, updated_at)
             VALUES ('delete', ?1, ?2, '{}', 'pending', 0, NULL, 0, ?3, ?3)",
            params![local_id, remote_id, now],
        )
        .map_err(crate::commands::CmdError::from)?;
    } else {
        // Local-only note that was never synced: hard-delete.
        conn.execute("DELETE FROM notes WHERE id=?1", params![local_id])
            .map_err(crate::commands::CmdError::from)?;
    }

    state.engine.kicker.notify_one();
    let _ = app.emit("notebookpi://notes-changed", &local_id);
    Ok(())
}

fn truncate(s: &str, n: usize) -> String {
    let mut out = String::new();
    for (i, ch) in s.chars().enumerate() {
        if i >= n {
            break;
        }
        out.push(ch);
    }
    out
}

// ---------- 版本历史:全部代理到远端,本地不缓存 ----------
// 老王注:之前 tauri-api.ts 这三个方法是 notSupported,桌面端用户一点"版本历史"就 throw。
// 实现思路:接收 local_id,查 notes.remote_id,有 remote_id 才查远端,否则报错(本地新建未同步的笔记没历史)。

async fn resolve_remote_id(state: &AppState, local_id: i64) -> Result<i64, crate::commands::CmdError> {
    let conn = state.pool.get().map_err(crate::commands::CmdError::from)?;
    let remote: Option<i64> = conn
        .query_row(
            "SELECT remote_id FROM notes WHERE id=?1",
            params![local_id],
            |r| r.get(0),
        )
        .ok()
        .flatten();
    remote.ok_or_else(|| crate::commands::CmdError::from("note not synced yet — no history available"))
}

#[tauri::command]
pub async fn cmd_list_versions(
    state: State<'_, AppState>,
    note_id: i64,
) -> CmdResult<Vec<crate::http::RemoteNoteVersion>> {
    let remote_id = resolve_remote_id(&state, note_id).await?;
    let client = state
        .engine
        .build_client_async()
        .ok_or_else(|| crate::commands::CmdError::from("not configured"))?;
    let versions = client.list_versions(remote_id).await.map_err(crate::commands::CmdError::from)?;
    Ok(versions)
}

#[tauri::command]
pub async fn cmd_get_version(
    state: State<'_, AppState>,
    note_id: i64,
    vid: i64,
) -> CmdResult<crate::http::RemoteNoteVersionFull> {
    let remote_id = resolve_remote_id(&state, note_id).await?;
    let client = state
        .engine
        .build_client_async()
        .ok_or_else(|| crate::commands::CmdError::from("not configured"))?;
    let v = client.get_version(remote_id, vid).await.map_err(crate::commands::CmdError::from)?;
    Ok(v)
}

#[tauri::command]
pub async fn cmd_restore_version(
    app: AppHandle,
    state: State<'_, AppState>,
    note_id: i64,
    vid: i64,
) -> CmdResult<Note> {
    let remote_id = resolve_remote_id(&state, note_id).await?;
    let client = state
        .engine
        .build_client_async()
        .ok_or_else(|| crate::commands::CmdError::from("not configured"))?;
    let restored = client
        .restore_version(remote_id, vid)
        .await
        .map_err(crate::commands::CmdError::from)?;
    // 同步本地缓存的 content/updated_at,避免下一次 pull 才更新
    {
        let conn = state.pool.get().map_err(crate::commands::CmdError::from)?;
        conn.execute(
            "UPDATE notes
                SET content=?1, updated_at=?2, last_synced_at=?2,
                    excerpt=?3, sync_status='synced'
              WHERE id=?4",
            params![
                restored.content,
                restored.updated_at,
                truncate(&restored.content, EXCERPT_LEN),
                note_id
            ],
        ).map_err(crate::commands::CmdError::from)?;
    }
    let _ = app.emit("notebookpi://notes-changed", &note_id);
    read_full(&state.pool, note_id)
}

