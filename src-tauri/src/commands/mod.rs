// IPC commands exposed to the frontend (`invoke('cmd_*')`).
//
// Errors are surfaced as plain strings — Tauri requires `Result<T, E: Serialize>`
// on commands. We wrap anyhow into a tiny CmdError so the JS side gets readable
// messages without leaking Rust panics.

pub mod folders;
pub mod notes;
pub mod search;
pub mod settings;
pub mod sync;
pub mod window;

#[derive(Debug, serde::Serialize)]
pub struct CmdError {
    pub message: String,
}

impl<E: std::fmt::Display> From<E> for CmdError {
    fn from(e: E) -> Self {
        Self {
            message: e.to_string(),
        }
    }
}

pub type CmdResult<T> = std::result::Result<T, CmdError>;
