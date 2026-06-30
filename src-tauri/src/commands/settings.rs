use crate::commands::CmdResult;
use crate::models::Settings;
use crate::AppState;
use tauri::State;

#[tauri::command]
pub fn cmd_get_settings(state: State<'_, AppState>) -> CmdResult<Settings> {
    let has_token = crate::secrets::has_token(&state.app_data_dir);
    let s = crate::config::load(&state.pool, has_token).map_err(crate::commands::CmdError::from)?;
    Ok(s)
}

#[tauri::command]
pub fn cmd_set_settings(state: State<'_, AppState>, settings: Settings) -> CmdResult<Settings> {
    crate::config::save(&state.pool, &settings).map_err(crate::commands::CmdError::from)?;
    let has_token = crate::secrets::has_token(&state.app_data_dir);
    Ok(crate::config::load(&state.pool, has_token).map_err(crate::commands::CmdError::from)?)
}

#[tauri::command]
pub fn cmd_save_token(state: State<'_, AppState>, token: String) -> CmdResult<()> {
    let token = token.trim().to_string();
    if token.is_empty() {
        crate::secrets::clear_token(&state.app_data_dir).map_err(crate::commands::CmdError::from)?;
        return Ok(());
    }
    crate::secrets::save_token(&state.app_data_dir, &token)
        .map_err(crate::commands::CmdError::from)?;
    Ok(())
}

#[tauri::command]
pub fn cmd_has_token(state: State<'_, AppState>) -> CmdResult<bool> {
    Ok(crate::secrets::has_token(&state.app_data_dir))
}

#[tauri::command]
pub fn cmd_clear_token(state: State<'_, AppState>) -> CmdResult<()> {
    crate::secrets::clear_token(&state.app_data_dir).map_err(crate::commands::CmdError::from)?;
    Ok(())
}
