use crate::commands::CmdResult;
use crate::models::{NoteFormat, SearchHit};
use crate::AppState;
use rusqlite::params;
use tauri::State;

/// Search:
/// - online: try server `/api/search?q=...`, return its hits (mapped to local ids when available)
/// - offline (or server fails): fall back to local LIKE on title+content
#[tauri::command]
pub async fn cmd_search_notes(
    state: State<'_, AppState>,
    q: String,
) -> CmdResult<Vec<SearchHit>> {
    let q = q.trim().to_string();
    if q.is_empty() {
        return Ok(Vec::new());
    }

    if let Some(client) = state.engine.build_client_async() {
        if let Ok(v) = client.raw_get_json::<ApiSearchResp>(&format!(
            "/api/search?q={}",
            urlencode(&q)
        )).await {
            let pool = state.pool.clone();
            let conn = pool.get().map_err(crate::commands::CmdError::from)?;
            let hits = v
                .results
                .into_iter()
                .map(|h| {
                    let local_id: Option<i64> = conn
                        .query_row(
                            "SELECT id FROM notes WHERE remote_id=?1",
                            params![h.id],
                            |r| r.get(0),
                        )
                        .ok();
                    SearchHit {
                        id: local_id.unwrap_or(0),
                        remote_id: Some(h.id),
                        folder_remote_id: h.folder_id,
                        title: h.title,
                        format: NoteFormat::from_str_or_default(&h.format),
                        updated_at: h.updated_at,
                        snippet: h.snippet,
                    }
                })
                .collect();
            return Ok(hits);
        }
    }

    // Local fallback.
    let needle = format!("%{}%", q.replace('%', "\\%").replace('_', "\\_"));
    let conn = state.pool.get().map_err(crate::commands::CmdError::from)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, remote_id, folder_remote_id, title, format, updated_at, content
                FROM notes
                WHERE deleted=0 AND (title LIKE ?1 ESCAPE '\\' OR content LIKE ?1 ESCAPE '\\')
             ORDER BY updated_at DESC
             LIMIT 100",
        )
        .map_err(crate::commands::CmdError::from)?;
    let rows = stmt
        .query_map(params![needle], |r| {
            let content: String = r.get(6)?;
            let snippet = make_snippet(&content, &q);
            Ok(SearchHit {
                id: r.get(0)?,
                remote_id: r.get(1)?,
                folder_remote_id: r.get(2)?,
                title: r.get(3)?,
                format: NoteFormat::from_str_or_default(&r.get::<_, String>(4)?),
                updated_at: r.get(5)?,
                snippet,
            })
        })
        .map_err(crate::commands::CmdError::from)?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[derive(serde::Deserialize)]
struct ApiSearchResp {
    results: Vec<ApiHit>,
}
#[derive(serde::Deserialize)]
struct ApiHit {
    id: i64,
    folder_id: Option<i64>,
    title: String,
    format: String,
    updated_at: i64,
    snippet: String,
}

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

fn make_snippet(content: &str, q: &str) -> String {
    let lc = content.to_lowercase();
    let lq = q.to_lowercase();
    let pos = lc.find(&lq).unwrap_or(0);
    let start = pos.saturating_sub(40);
    let end = (pos + q.len() + 80).min(content.len());
    let mut s = String::new();
    if start > 0 {
        s.push_str("...");
    }
    s.push_str(content.get(start..end).unwrap_or(""));
    if end < content.len() {
        s.push_str("...");
    }
    s
}
