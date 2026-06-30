// Shared data types crossing the IPC boundary.
//
// Field names use snake_case to mirror the existing HTTP API responses, so the
// browser frontend and the desktop frontend can share TypeScript types.

use serde::{Deserialize, Deserializer, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NoteFormat {
    Txt,
    Md,
}

impl NoteFormat {
    pub fn as_str(self) -> &'static str {
        match self {
            NoteFormat::Txt => "txt",
            NoteFormat::Md => "md",
        }
    }

    pub fn from_str_or_default(s: &str) -> Self {
        match s {
            "md" => NoteFormat::Md,
            _ => NoteFormat::Txt,
        }
    }
}

/// Local sync state. Mirrors the constants used in the JS layer.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SyncStatus {
    Synced,
    PendingCreate,
    PendingUpdate,
    PendingDelete,
    SyncFailed,
    Conflict,
}

impl SyncStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            SyncStatus::Synced => "synced",
            SyncStatus::PendingCreate => "pending_create",
            SyncStatus::PendingUpdate => "pending_update",
            SyncStatus::PendingDelete => "pending_delete",
            SyncStatus::SyncFailed => "sync_failed",
            SyncStatus::Conflict => "conflict",
        }
    }

    pub fn from_str_or_synced(s: &str) -> Self {
        match s {
            "pending_create" => SyncStatus::PendingCreate,
            "pending_update" => SyncStatus::PendingUpdate,
            "pending_delete" => SyncStatus::PendingDelete,
            "sync_failed" => SyncStatus::SyncFailed,
            "conflict" => SyncStatus::Conflict,
            _ => SyncStatus::Synced,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Folder {
    pub id: i64,                       // local id
    pub remote_id: Option<i64>,
    pub parent_remote_id: Option<i64>, // server-side parent_id (null = root)
    pub name: String,
    pub path: String,                  // joined names with '/'
    pub created_at: i64,
    pub updated_at: i64,
    /// Optional precomputed note count, filled by list queries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note_count: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteLite {
    pub id: i64,                          // local id
    pub remote_id: Option<i64>,
    pub folder_remote_id: Option<i64>,
    pub folder_path: Option<String>,
    pub title: String,
    pub format: NoteFormat,
    pub excerpt: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_synced_at: Option<i64>,
    pub sync_status: SyncStatus,
    pub deleted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Note {
    pub id: i64,
    pub remote_id: Option<i64>,
    pub folder_remote_id: Option<i64>,
    pub folder_path: Option<String>,
    pub title: String,
    pub content: String,
    pub format: NoteFormat,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_synced_at: Option<i64>,
    pub sync_status: SyncStatus,
    pub deleted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchHit {
    pub id: i64,
    pub remote_id: Option<i64>,
    pub folder_remote_id: Option<i64>,
    pub title: String,
    pub format: NoteFormat,
    pub updated_at: i64,
    pub snippet: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncStatusReport {
    pub configured: bool,
    pub online: bool,
    pub last_sync_at: Option<i64>,
    pub pending: i64,
    pub failed: i64,
    pub last_error: Option<String>,
    pub running: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub server_url: String,
    pub has_token: bool,
    pub quick_folder_path: String,
    pub close_to_tray: bool,
    pub autostart: bool,
    pub quick_note_clear_on_save: bool,
    pub quick_note_close_on_save: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            server_url: String::new(),
            has_token: false,
            quick_folder_path: "随笔记录/快速记录".to_string(),
            close_to_tray: true,
            autostart: false,
            quick_note_clear_on_save: true,
            quick_note_close_on_save: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateNoteInput {
    /// Optional remote folder id; takes precedence over `folder_path` if provided.
    pub folder_remote_id: Option<i64>,
    /// Slash-joined path used by `/api/import` to create folders on the fly.
    pub folder_path: Option<String>,
    pub title: Option<String>,
    pub content: Option<String>,
    pub format: Option<NoteFormat>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UpdateNoteInput {
    pub title: Option<String>,
    pub content: Option<String>,
    pub format: Option<NoteFormat>,
    /// Double-Option:字段不在 patch 里 = None(不改);字段为 null = Some(None)(移到根);
    /// 字段为数字 = Some(Some(id))(移到目标)。serde 默认对 Option<Option<T>>:
    ///   缺字段 → None,null → None,数字 → Some(Some)。这无法区分"不改"和"移到根"。
    /// 用 deserialize_some 强制:字段存在(无论值)就包一层 Some。
    #[serde(default, deserialize_with = "deserialize_some")]
    pub folder_remote_id: Option<Option<i64>>, // Some(None) = move to root
}

/// serde double-Option pattern:任意出现的字段(含 null)都包一层 Some。
fn deserialize_some<'de, T, D>(deserializer: D) -> Result<Option<T>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    T::deserialize(deserializer).map(Some)
}
