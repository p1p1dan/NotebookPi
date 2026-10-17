// 分享链接:全部代理到远端。链接用配置的服务器地址拼接,笔记必须已同步(有 remote_id)。

use crate::commands::{CmdError, CmdResult};
use crate::http::{ApiClient, RemoteShare};
use crate::AppState;
use rusqlite::params;
use serde::Serialize;
use tauri::State;

#[derive(Debug, Serialize)]
pub struct ShareInfo {
    pub token: String,
    pub url: String,
    pub created_at: i64,
}

fn to_info(client: &ApiClient, s: RemoteShare) -> ShareInfo {
    ShareInfo {
        url: client.share_url(&s.token),
        token: s.token,
        created_at: s.created_at,
    }
}

/// The frontend matches on "not_synced" to explain why sharing is unavailable.
fn remote_and_client(state: &AppState, local_id: i64) -> CmdResult<(i64, ApiClient)> {
    let remote_id: Option<i64> = {
        let conn = state.pool.get().map_err(CmdError::from)?;
        conn.query_row(
            "SELECT remote_id FROM notes WHERE id=?1",
            params![local_id],
            |r| r.get(0),
        )
        .ok()
        .flatten()
    };
    let remote_id = remote_id.ok_or_else(|| CmdError::from("not_synced"))?;
    let client = state
        .engine
        .build_client_async()
        .ok_or_else(|| CmdError::from("not configured"))?;
    Ok((remote_id, client))
}

#[tauri::command]
pub async fn cmd_get_share(
    state: State<'_, AppState>,
    note_id: i64,
) -> CmdResult<Option<ShareInfo>> {
    let (remote_id, client) = remote_and_client(&state, note_id)?;
    let share = client.get_share(remote_id).await.map_err(CmdError::from)?;
    Ok(share.map(|s| to_info(&client, s)))
}

#[tauri::command]
pub async fn cmd_create_share(state: State<'_, AppState>, note_id: i64) -> CmdResult<ShareInfo> {
    let (remote_id, client) = remote_and_client(&state, note_id)?;
    let share = client.create_share(remote_id).await.map_err(CmdError::from)?;
    Ok(to_info(&client, share))
}

#[tauri::command]
pub async fn cmd_revoke_share(state: State<'_, AppState>, note_id: i64) -> CmdResult<()> {
    let (remote_id, client) = remote_and_client(&state, note_id)?;
    client.revoke_share(remote_id).await.map_err(CmdError::from)?;
    Ok(())
}
