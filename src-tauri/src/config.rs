// Settings store: KV table backed by SQLite + a typed view.
//
// Token is intentionally not stored here — see secrets.rs.

use crate::db::{delete_setting, get_setting, put_setting, DbPool};
use crate::models::Settings;
use anyhow::Result;

const K_SERVER_URL: &str = "server_url";
const K_QUICK_FOLDER: &str = "quick_folder_path";
const K_CLOSE_TO_TRAY: &str = "close_to_tray";
const K_AUTOSTART: &str = "autostart";
const K_QUICK_CLEAR_ON_SAVE: &str = "quick_note_clear_on_save";
const K_QUICK_CLOSE_ON_SAVE: &str = "quick_note_close_on_save";
const K_LAST_SYNC_AT: &str = "last_sync_at";

fn read_bool(pool: &DbPool, key: &str, default: bool) -> Result<bool> {
    let conn = pool.get()?;
    let v = get_setting(&conn, key)?;
    Ok(v.map(|s| s == "1" || s == "true").unwrap_or(default))
}

fn write_bool(pool: &DbPool, key: &str, value: bool) -> Result<()> {
    let conn = pool.get()?;
    put_setting(&conn, key, if value { "1" } else { "0" })
}

fn read_str(pool: &DbPool, key: &str, default: &str) -> Result<String> {
    let conn = pool.get()?;
    Ok(get_setting(&conn, key)?.unwrap_or_else(|| default.to_string()))
}

fn write_str(pool: &DbPool, key: &str, value: &str) -> Result<()> {
    let conn = pool.get()?;
    if value.is_empty() {
        delete_setting(&conn, key)
    } else {
        put_setting(&conn, key, value)
    }
}

pub fn load(pool: &DbPool, has_token: bool) -> Result<Settings> {
    let defaults = Settings::default();
    Ok(Settings {
        server_url: read_str(pool, K_SERVER_URL, "")?,
        has_token,
        quick_folder_path: read_str(pool, K_QUICK_FOLDER, &defaults.quick_folder_path)?,
        close_to_tray: read_bool(pool, K_CLOSE_TO_TRAY, defaults.close_to_tray)?,
        autostart: read_bool(pool, K_AUTOSTART, defaults.autostart)?,
        quick_note_clear_on_save: read_bool(
            pool,
            K_QUICK_CLEAR_ON_SAVE,
            defaults.quick_note_clear_on_save,
        )?,
        quick_note_close_on_save: read_bool(
            pool,
            K_QUICK_CLOSE_ON_SAVE,
            defaults.quick_note_close_on_save,
        )?,
    })
}

pub fn save(pool: &DbPool, s: &Settings) -> Result<()> {
    write_str(pool, K_SERVER_URL, s.server_url.trim())?;
    write_str(pool, K_QUICK_FOLDER, s.quick_folder_path.trim())?;
    write_bool(pool, K_CLOSE_TO_TRAY, s.close_to_tray)?;
    write_bool(pool, K_AUTOSTART, s.autostart)?;
    write_bool(pool, K_QUICK_CLEAR_ON_SAVE, s.quick_note_clear_on_save)?;
    write_bool(pool, K_QUICK_CLOSE_ON_SAVE, s.quick_note_close_on_save)?;
    Ok(())
}

pub fn read_last_sync_at(pool: &DbPool) -> Result<Option<i64>> {
    let conn = pool.get()?;
    Ok(get_setting(&conn, K_LAST_SYNC_AT)?.and_then(|s| s.parse().ok()))
}

pub fn write_last_sync_at(pool: &DbPool, ts: i64) -> Result<()> {
    let conn = pool.get()?;
    put_setting(&conn, K_LAST_SYNC_AT, &ts.to_string())
}
