use crate::commands::CmdResult;
use crate::db::now_ms;
use crate::models::Folder;
use crate::AppState;
use rusqlite::params;
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub fn cmd_list_folders(state: State<'_, AppState>) -> CmdResult<Vec<Folder>> {
    let conn = state.pool.get().map_err(map_err)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, remote_id, parent_remote_id, name, path, created_at, updated_at,
                  (SELECT COUNT(*) FROM notes
                     WHERE notes.folder_remote_id = folders.remote_id
                       AND notes.deleted = 0)
              FROM folders
             ORDER BY path ASC",
        )
        .map_err(map_err)?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Folder {
                id: r.get(0)?,
                remote_id: r.get(1)?,
                parent_remote_id: r.get(2)?,
                name: r.get(3)?,
                path: r.get(4)?,
                created_at: r.get(5)?,
                updated_at: r.get(6)?,
                note_count: Some(r.get(7)?),
            })
        })
        .map_err(map_err)?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// Create a folder hierarchy locally so unsynced notes can be filed.
/// Returns the leaf folder. Server creation happens on next sync via /api/import.
#[tauri::command]
pub fn cmd_ensure_folder_path(state: State<'_, AppState>, path: String) -> CmdResult<Folder> {
    let path = path.trim().trim_matches('/').to_string();
    if path.is_empty() {
        return Err("empty folder path".into());
    }
    let parts: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let conn = state.pool.get().map_err(map_err)?;
    let now = now_ms();
    let mut acc = String::new();
    let mut last_id: Option<i64> = None;
    for p in parts {
        if !acc.is_empty() {
            acc.push('/');
        }
        acc.push_str(p);
        // Find existing entry by path.
        let existing: Option<i64> = conn
            .query_row(
                "SELECT id FROM folders WHERE path=?1",
                params![acc],
                |r| r.get(0),
            )
            .ok();
        if let Some(id) = existing {
            last_id = Some(id);
            continue;
        }
        conn.execute(
            "INSERT INTO folders(remote_id, parent_remote_id, name, path, created_at, updated_at)
             VALUES (NULL, NULL, ?1, ?2, ?3, ?3)",
            params![p, acc, now],
        )
        .map_err(map_err)?;
        last_id = Some(conn.last_insert_rowid());
    }

    let id = last_id.ok_or("folder insert failed")?;
    let f = conn
        .query_row(
            "SELECT id, remote_id, parent_remote_id, name, path, created_at, updated_at
                FROM folders WHERE id=?1",
            params![id],
            |r| {
                Ok(Folder {
                    id: r.get(0)?,
                    remote_id: r.get(1)?,
                    parent_remote_id: r.get(2)?,
                    name: r.get(3)?,
                    path: r.get(4)?,
                    created_at: r.get(5)?,
                    updated_at: r.get(6)?,
                    note_count: Some(0),
                })
            },
        )
        .map_err(map_err)?;
    Ok(f)
}

fn map_err<E: std::fmt::Display>(e: E) -> crate::commands::CmdError {
    e.into()
}

// ---------- 桌面端 folder CRUD ----------
// 老王的务实方案:不走 sync_queue,直接打远端 API,然后立刻 pull 一次本地缓存同步。
// 离线时报错让用户知道。私人应用 99% 在线,这权衡值得。

/// 拉全量 folders 重写本地缓存。失败不抛,只 warn。
async fn refresh_folder_cache(state: &AppState, client: &crate::http::ApiClient) {
    if let Ok(folders) = client.list_folders().await {
        // 复用 sync.rs 的 upsert 逻辑会拖一堆依赖,这里直接清表重建,简单粗暴。
        if let Ok(conn) = state.pool.get() {
            let _ = conn.execute("DELETE FROM folders", []);
            let now = now_ms();
            // 路径计算:跟 sync.rs 里的 path_of 同款,但内联避免跨模块
            use std::collections::HashMap;
            let by_id: HashMap<i64, &crate::http::RemoteFolder> =
                folders.iter().map(|f| (f.id, f)).collect();
            for f in &folders {
                let mut parts = Vec::new();
                let mut cur = f.id;
                for _ in 0..32 {
                    let g = match by_id.get(&cur) { Some(g) => *g, None => break };
                    parts.push(g.name.clone());
                    match g.parent_id { Some(p) => cur = p, None => break };
                }
                parts.reverse();
                let path = parts.join("/");
                let _ = conn.execute(
                    "INSERT INTO folders(remote_id, parent_remote_id, name, path, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![f.id, f.parent_id, f.name, path, f.created_at, now],
                );
            }
        }
    }
}

#[tauri::command]
pub async fn cmd_create_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    parent_id: Option<i64>,
    name: String,
) -> CmdResult<Folder> {
    let client = state
        .engine
        .build_client_async()
        .ok_or_else(|| crate::commands::CmdError::from("not configured"))?;
    let remote = client
        .create_folder(parent_id, name.trim())
        .await
        .map_err(map_err)?;
    refresh_folder_cache(&state, &client).await;
    let _ = app.emit("notebookpi://notes-changed", &());
    let conn = state.pool.get().map_err(map_err)?;
    let f = conn.query_row(
        "SELECT id, remote_id, parent_remote_id, name, path, created_at, updated_at,
              (SELECT COUNT(*) FROM notes WHERE folder_remote_id = folders.remote_id AND deleted = 0)
         FROM folders WHERE remote_id = ?1",
        params![remote.id],
        |r| Ok(Folder {
            id: r.get(0)?,
            remote_id: r.get(1)?,
            parent_remote_id: r.get(2)?,
            name: r.get(3)?,
            path: r.get(4)?,
            created_at: r.get(5)?,
            updated_at: r.get(6)?,
            note_count: Some(r.get(7)?),
        }),
    ).map_err(map_err)?;
    Ok(f)
}

#[tauri::command]
pub async fn cmd_rename_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    id: i64,
    name: String,
) -> CmdResult<Folder> {
    let client = state
        .engine
        .build_client_async()
        .ok_or_else(|| crate::commands::CmdError::from("not configured"))?;
    let remote = client
        .rename_folder(id, name.trim())
        .await
        .map_err(map_err)?;
    refresh_folder_cache(&state, &client).await;
    let _ = app.emit("notebookpi://notes-changed", &());
    let conn = state.pool.get().map_err(map_err)?;
    let f = conn.query_row(
        "SELECT id, remote_id, parent_remote_id, name, path, created_at, updated_at,
              (SELECT COUNT(*) FROM notes WHERE folder_remote_id = folders.remote_id AND deleted = 0)
         FROM folders WHERE remote_id = ?1",
        params![remote.id],
        |r| Ok(Folder {
            id: r.get(0)?,
            remote_id: r.get(1)?,
            parent_remote_id: r.get(2)?,
            name: r.get(3)?,
            path: r.get(4)?,
            created_at: r.get(5)?,
            updated_at: r.get(6)?,
            note_count: Some(r.get(7)?),
        }),
    ).map_err(map_err)?;
    Ok(f)
}

#[tauri::command]
pub async fn cmd_delete_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    id: i64,
) -> CmdResult<()> {
    let client = state
        .engine
        .build_client_async()
        .ok_or_else(|| crate::commands::CmdError::from("not configured"))?;
    client.delete_folder(id).await.map_err(map_err)?;
    refresh_folder_cache(&state, &client).await;
    // 删了文件夹,里面的笔记被服务端 set 到 NULL 了,本地 folder_remote_id 引用要清
    if let Ok(conn) = state.pool.get() {
        let _ = conn.execute(
            "UPDATE notes SET folder_remote_id = NULL, updated_at = ?1
              WHERE folder_remote_id = ?2",
            params![now_ms(), id],
        );
    }
    let _ = app.emit("notebookpi://notes-changed", &());
    Ok(())
}
