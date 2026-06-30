// Thin Bearer-auth HTTP client for the NotebookPi REST API.
//
// All endpoints used:
//   GET    /api/folders
//   POST   /api/folders                    { parent_id?, name }
//   GET    /api/notes?folder_id=all
//   GET    /api/notes/:id
//   POST   /api/notes                      { folder_id?, title?, content?, format? }
//   PUT    /api/notes/:id                  patch
//   DELETE /api/notes/:id
//   POST   /api/import                     { folder, notes[] }   - used to autocreate folder paths
//   GET    /api/search?q=...
//   GET    /api/health

use crate::models::NoteFormat;
use anyhow::{anyhow, Context, Result};
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Clone)]
pub struct ApiClient {
    base: String,
    token: String,
    http: Client,
}

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("not configured")]
    NotConfigured,
    #[error("network: {0}")]
    Network(String),
    #[error("server {status}: {code}")]
    Server { status: u16, code: String },
    #[error("decode: {0}")]
    Decode(String),
}

impl From<reqwest::Error> for ApiError {
    fn from(e: reqwest::Error) -> Self {
        ApiError::Network(e.to_string())
    }
}

#[derive(Debug, Deserialize)]
struct ErrorBody {
    error: String,
}

impl ApiClient {
    pub fn new(base: &str, token: &str) -> Result<Self> {
        let base = base.trim().trim_end_matches('/').to_string();
        if base.is_empty() {
            return Err(anyhow!("empty base url"));
        }
        if token.trim().is_empty() {
            return Err(anyhow!("empty token"));
        }
        let http = Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(30))
            .user_agent(concat!("NotebookPi-Desktop/", env!("CARGO_PKG_VERSION")))
            .build()
            .context("build reqwest client")?;
        Ok(Self {
            base,
            token: token.to_string(),
            http,
        })
    }

    pub fn try_from_settings(server_url: &str, token: Option<&str>) -> Option<Self> {
        let token = token?;
        Self::new(server_url, token).ok()
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base, path)
    }

    async fn json<T: for<'de> Deserialize<'de>>(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<&serde_json::Value>,
    ) -> Result<T, ApiError> {
        let mut req = self
            .http
            .request(method, self.url(path))
            .bearer_auth(&self.token);
        if let Some(b) = body {
            req = req.json(b);
        }
        let res = req.send().await?;
        let status = res.status();
        if !status.is_success() {
            let code = match res.json::<ErrorBody>().await {
                Ok(b) => b.error,
                Err(_) => format!("http_{}", status.as_u16()),
            };
            return Err(ApiError::Server {
                status: status.as_u16(),
                code,
            });
        }
        res.json::<T>()
            .await
            .map_err(|e| ApiError::Decode(e.to_string()))
    }

    pub async fn ping(&self) -> Result<bool, ApiError> {
        let res = self
            .http
            .get(self.url("/api/health"))
            .timeout(Duration::from_secs(5))
            .send()
            .await?;
        Ok(res.status() != StatusCode::INTERNAL_SERVER_ERROR && res.status().as_u16() < 500)
    }

    /// Generic GET that decodes JSON. Used for less common endpoints (e.g. /api/search).
    pub async fn raw_get_json<T: for<'de> Deserialize<'de>>(
        &self,
        path: &str,
    ) -> Result<T, ApiError> {
        self.json(reqwest::Method::GET, path, None).await
    }

    pub async fn list_folders(&self) -> Result<Vec<RemoteFolder>, ApiError> {
        let v: FoldersResp = self
            .json(reqwest::Method::GET, "/api/folders", None)
            .await?;
        Ok(v.folders)
    }

    pub async fn list_all_notes(&self) -> Result<Vec<RemoteNoteLite>, ApiError> {
        let v: NotesResp = self
            .json(reqwest::Method::GET, "/api/notes?folder_id=all", None)
            .await?;
        Ok(v.notes)
    }

    pub async fn get_note(&self, id: i64) -> Result<RemoteNote, ApiError> {
        let v: NoteResp = self
            .json(reqwest::Method::GET, &format!("/api/notes/{id}"), None)
            .await?;
        Ok(v.note)
    }

    pub async fn create_note(
        &self,
        folder_id: Option<i64>,
        title: &str,
        content: &str,
        format: NoteFormat,
    ) -> Result<RemoteNote, ApiError> {
        let body = serde_json::json!({
            "folder_id": folder_id,
            "title": title,
            "content": content,
            "format": format.as_str(),
        });
        let v: NoteResp = self
            .json(reqwest::Method::POST, "/api/notes", Some(&body))
            .await?;
        Ok(v.note)
    }

    pub async fn update_note(
        &self,
        id: i64,
        patch: &serde_json::Value,
    ) -> Result<RemoteNote, ApiError> {
        let v: NoteResp = self
            .json(
                reqwest::Method::PUT,
                &format!("/api/notes/{id}"),
                Some(patch),
            )
            .await?;
        Ok(v.note)
    }

    pub async fn delete_note(&self, id: i64) -> Result<(), ApiError> {
        let _: serde_json::Value = self
            .json(reqwest::Method::DELETE, &format!("/api/notes/{id}"), None)
            .await?;
        Ok(())
    }

    pub async fn create_folder(
        &self,
        parent_id: Option<i64>,
        name: &str,
    ) -> Result<RemoteFolder, ApiError> {
        let body = serde_json::json!({ "parent_id": parent_id, "name": name });
        let v: FolderResp = self
            .json(reqwest::Method::POST, "/api/folders", Some(&body))
            .await?;
        Ok(v.folder)
    }

    pub async fn rename_folder(&self, id: i64, name: &str) -> Result<RemoteFolder, ApiError> {
        let body = serde_json::json!({ "name": name });
        let v: FolderResp = self
            .json(reqwest::Method::PATCH, &format!("/api/folders/{id}"), Some(&body))
            .await?;
        Ok(v.folder)
    }

    pub async fn delete_folder(&self, id: i64) -> Result<(), ApiError> {
        let _: serde_json::Value = self
            .json(reqwest::Method::DELETE, &format!("/api/folders/{id}"), None)
            .await?;
        Ok(())
    }

    /// Use POST /api/import with a single placeholder note to autocreate a
    /// folder path. Server response includes `folder_id`. We then delete the
    /// placeholder note immediately. This keeps server logic untouched.
    ///
    /// Slight edge: if the path already exists, no folder is created — we just
    /// resolve the id from the response. No race with concurrent local users
    /// since this app is single-user.
    pub async fn ensure_folder_path(&self, path: &str) -> Result<RemoteFolderRef, ApiError> {
        let body = serde_json::json!({
            "folder": path,
            "notes": [{
                "title": "__placeholder__",
                "content": "",
                "format": "txt"
            }]
        });
        let v: ImportResp = self
            .json(reqwest::Method::POST, "/api/import", Some(&body))
            .await?;
        if let Some(n) = v.notes.first() {
            // best-effort cleanup; ignore failures, the placeholder is harmless
            let _ = self.delete_note(n.id).await;
        }
        Ok(RemoteFolderRef {
            id: v.folder_id,
            path: v.folder_path,
        })
    }

    pub async fn list_versions(&self, note_id: i64) -> Result<Vec<RemoteNoteVersion>, ApiError> {
        let v: VersionsResp = self
            .json(reqwest::Method::GET, &format!("/api/notes/{note_id}/versions"), None)
            .await?;
        Ok(v.versions)
    }

    pub async fn get_version(&self, note_id: i64, vid: i64) -> Result<RemoteNoteVersionFull, ApiError> {
        let v: VersionResp = self
            .json(reqwest::Method::GET, &format!("/api/notes/{note_id}/versions/{vid}"), None)
            .await?;
        Ok(v.version)
    }

    pub async fn restore_version(&self, note_id: i64, vid: i64) -> Result<RemoteNote, ApiError> {
        let v: NoteResp = self
            .json(reqwest::Method::POST, &format!("/api/notes/{note_id}/versions/{vid}/restore"), None)
            .await?;
        Ok(v.note)
    }
}

// ---------- response shapes ----------

#[derive(Debug, Deserialize)]
struct FoldersResp {
    folders: Vec<RemoteFolder>,
}

#[derive(Debug, Deserialize)]
struct NotesResp {
    notes: Vec<RemoteNoteLite>,
}

#[derive(Debug, Deserialize)]
struct NoteResp {
    note: RemoteNote,
}

#[derive(Debug, Deserialize)]
struct FolderResp {
    folder: RemoteFolder,
}

#[derive(Debug, Deserialize)]
struct ImportResp {
    pub folder_id: Option<i64>,
    pub folder_path: String,
    pub notes: Vec<RemoteNoteLite>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteFolder {
    pub id: i64,
    pub parent_id: Option<i64>,
    pub name: String,
    pub created_at: i64,
    #[serde(default)]
    pub note_count: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteNoteLite {
    pub id: i64,
    pub folder_id: Option<i64>,
    pub title: String,
    pub format: String,
    #[serde(default)]
    pub excerpt: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteNote {
    pub id: i64,
    pub folder_id: Option<i64>,
    pub title: String,
    pub format: String,
    pub content: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone)]
pub struct RemoteFolderRef {
    pub id: Option<i64>,
    pub path: String,
}

#[derive(Debug, Deserialize)]
struct VersionsResp {
    versions: Vec<RemoteNoteVersion>,
}

#[derive(Debug, Deserialize)]
struct VersionResp {
    version: RemoteNoteVersionFull,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteNoteVersion {
    pub id: i64,
    pub saved_at: i64,
    pub size: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteNoteVersionFull {
    pub id: i64,
    pub note_id: i64,
    pub saved_at: i64,
    pub content: String,
}
