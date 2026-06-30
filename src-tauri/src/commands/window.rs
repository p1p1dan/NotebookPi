use crate::commands::CmdResult;
use tauri::{AppHandle, Manager};

#[tauri::command]
pub fn cmd_show_main_window(app: AppHandle) -> CmdResult<()> {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    Ok(())
}

#[tauri::command]
pub fn cmd_show_quick_note(app: AppHandle) -> CmdResult<()> {
    if let Some(w) = app.get_webview_window("quick-note") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    Ok(())
}

#[tauri::command]
pub fn cmd_hide_quick_note(app: AppHandle) -> CmdResult<()> {
    if let Some(w) = app.get_webview_window("quick-note") {
        let _ = w.hide();
    }
    Ok(())
}
