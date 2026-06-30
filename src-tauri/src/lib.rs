// Tauri app composition: state, plugins, tray, shortcuts, command registry.
//
// `run()` is the single entry point used by main.rs. It wires every IPC
// command, the system tray, the global shortcut, the autostart plugin and the
// background sync loop.

mod commands;
mod config;
mod db;
mod http;
mod models;
mod secrets;
mod sync;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

pub struct AppState {
    pub pool: db::DbPool,
    pub app_data_dir: PathBuf,
    pub engine: Arc<sync::Engine>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .try_init();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Bring main window forward when a second instance is launched.
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state == ShortcutState::Pressed && is_quick_shortcut(shortcut) {
                        toggle_quick_note(app);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![
            commands::folders::cmd_list_folders,
            commands::folders::cmd_ensure_folder_path,
            commands::folders::cmd_create_folder,
            commands::folders::cmd_rename_folder,
            commands::folders::cmd_delete_folder,
            commands::notes::cmd_list_notes,
            commands::notes::cmd_get_note,
            commands::notes::cmd_create_note,
            commands::notes::cmd_update_note,
            commands::notes::cmd_delete_note,
            commands::notes::cmd_list_versions,
            commands::notes::cmd_get_version,
            commands::notes::cmd_restore_version,
            commands::search::cmd_search_notes,
            commands::settings::cmd_get_settings,
            commands::settings::cmd_set_settings,
            commands::settings::cmd_save_token,
            commands::settings::cmd_has_token,
            commands::settings::cmd_clear_token,
            commands::sync::cmd_sync_status,
            commands::sync::cmd_sync_now,
            commands::sync::cmd_retry_failed,
            commands::window::cmd_show_main_window,
            commands::window::cmd_show_quick_note,
            commands::window::cmd_hide_quick_note,
        ])
        .setup(|app| {
            // ---- paths & state ----
            let app_data_dir = app
                .path()
                .app_local_data_dir()
                .map_err(|e| e.to_string())?;
            std::fs::create_dir_all(&app_data_dir).ok();
            let db_path = app_data_dir.join("notebookpi.db");
            let pool = db::open(&db_path).map_err(|e| e.to_string())?;
            let engine = Arc::new(sync::Engine::new(pool.clone(), app_data_dir.clone()));

            app.manage(AppState {
                pool: pool.clone(),
                app_data_dir: app_data_dir.clone(),
                engine: engine.clone(),
            });

            // ---- global shortcut: Ctrl+Alt+N ----
            let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyN);
            app.global_shortcut()
                .register(shortcut)
                .map_err(|e| e.to_string())?;

            // ---- tray ----
            build_tray(&app.handle()).map_err(|e| e.to_string())?;

            // ---- close-to-tray on main window ----
            if let Some(main) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                main.on_window_event(move |evt| {
                    if let WindowEvent::CloseRequested { api, .. } = evt {
                        let close_to_tray = handle
                            .state::<AppState>()
                            .pool
                            .get()
                            .ok()
                            .and_then(|c| {
                                crate::db::get_setting(&c, "close_to_tray").ok().flatten()
                            })
                            .map(|v| v == "1" || v == "true")
                            .unwrap_or(true);
                        if close_to_tray {
                            api.prevent_close();
                            if let Some(w) = handle.get_webview_window("main") {
                                let _ = w.hide();
                            }
                        }
                    }
                });
            }
            // hide quick-note on close-requested instead of destroying it; this lets
            // the global shortcut re-show it instantly without a new render.
            if let Some(qw) = app.get_webview_window("quick-note") {
                let handle = app.handle().clone();
                qw.on_window_event(move |evt| {
                    if let WindowEvent::CloseRequested { api, .. } = evt {
                        api.prevent_close();
                        if let Some(w) = handle.get_webview_window("quick-note") {
                            let _ = w.hide();
                        }
                    }
                });
            }

            // ---- background sync loop ----
            spawn_sync_loop(engine, app.handle().clone());

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri app")
        .run(|_app, event| {
            if let RunEvent::ExitRequested { .. } = event {
                // No-op for now; place to flush state if needed.
            }
        });
}

fn is_quick_shortcut(s: &Shortcut) -> bool {
    s.matches(Modifiers::CONTROL | Modifiers::ALT, Code::KeyN)
}

fn toggle_quick_note(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("quick-note") {
        let visible = w.is_visible().unwrap_or(false);
        if visible {
            let _ = w.hide();
        } else {
            let _ = w.show();
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open_main = MenuItem::with_id(app, "open-main", "打开主窗口", true, None::<&str>)?;
    let open_quick = MenuItem::with_id(app, "open-quick", "新建快速记录", true, None::<&str>)?;
    let sync_now = MenuItem::with_id(app, "sync-now", "立即同步", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open_main, &open_quick, &sync_now, &quit])?;

    // IMPORTANT: do NOT also configure `app.trayIcon` in tauri.conf.json — Tauri
    // will create a SECOND tray (the conf one with the bundled icon but no
    // event handler, plus this one with the menu but no icon → user sees two
    // entries, one inert with logo, one blank but interactive).
    // We attach the bundled app icon here so a single tray carries both.
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("default_window_icon".into()))?;

    let _tray = TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip("NotebookPi")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open-main" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
            }
            "open-quick" => {
                if let Some(w) = app.get_webview_window("quick-note") {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
            }
            "sync-now" => {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    let st = handle.state::<AppState>();
                    let _ = st.engine.sync_once().await;
                });
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
            }
        })
        .build(app)?;
    Ok(())
}

fn spawn_sync_loop(engine: Arc<sync::Engine>, app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // First-run: small delay so DB and UI settle.
        tokio::time::sleep(Duration::from_millis(200)).await;
        loop {
            let _ = engine.sync_once().await;
            // Best-effort: tell every window that the local cache may have moved.
            let _ = app.emit("notebookpi://notes-changed", &());
            // Wake on either the next tick or an explicit kick.
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(30)) => {}
                _ = engine.kicker.notified() => {}
            }
        }
    });
}
