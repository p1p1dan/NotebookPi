use crate::commands::CmdResult;
use crate::models::SyncStatusReport;
use crate::AppState;
use rusqlite::params;
use tauri::State;

#[tauri::command]
pub async fn cmd_sync_status(state: State<'_, AppState>) -> CmdResult<SyncStatusReport> {
    let mut s = state
        .engine
        .status()
        .await
        .map_err(crate::commands::CmdError::from)?;
    if s.last_sync_at.is_none() {
        s.last_sync_at = crate::config::read_last_sync_at(&state.pool).ok().flatten();
    }
    Ok(s)
}

#[tauri::command]
pub async fn cmd_sync_now(state: State<'_, AppState>) -> CmdResult<SyncStatusReport> {
    state
        .engine
        .sync_once()
        .await
        .map_err(crate::commands::CmdError::from)?;
    state
        .engine
        .status()
        .await
        .map_err(crate::commands::CmdError::from)
}

#[tauri::command]
pub async fn cmd_retry_failed(state: State<'_, AppState>) -> CmdResult<SyncStatusReport> {
    {
        let conn = state.pool.get().map_err(crate::commands::CmdError::from)?;
        conn.execute(
            "UPDATE sync_queue
                SET status='pending', retry_count=0, last_error=NULL, next_attempt_at=0,
                    updated_at=?1
              WHERE status='failed'",
            params![crate::db::now_ms()],
        )
        .map_err(crate::commands::CmdError::from)?;
    }
    state
        .engine
        .sync_once()
        .await
        .map_err(crate::commands::CmdError::from)?;
    state
        .engine
        .status()
        .await
        .map_err(crate::commands::CmdError::from)
}
