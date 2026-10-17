export type NoteFormat = 'txt' | 'md';

/// Sync state for a note. Only the desktop runtime ever populates non-'synced'
/// values — in the browser everything is always treated as synced.
export type SyncStatus =
  | 'synced'
  | 'pending_create'
  | 'pending_update'
  | 'pending_delete'
  | 'sync_failed'
  | 'conflict';

export interface Folder {
  id: number;
  parent_id: number | null;
  name: string;
  created_at: number;
  note_count?: number;
  /** desktop-only: filled when the folder hasn't been synced yet */
  remote_id?: number | null;
  /** desktop-only: '/'-joined path */
  path?: string;
}

export interface NoteLite {
  id: number;
  folder_id: number | null;
  title: string;
  format: NoteFormat;
  excerpt?: string;
  created_at: number;
  updated_at: number;
  pinned?: boolean;
  /** desktop-only */
  sync_status?: SyncStatus;
  /** desktop-only: present once create has been accepted by server */
  remote_id?: number | null;
}

export interface Note extends NoteLite {
  content: string;
}

export type FolderId = number | null | 'all';

export interface ShareInfo {
  token: string;
  url: string;
  created_at: number;
}

export interface SearchResult {
  id: number;
  folder_id: number | null;
  title: string;
  format: NoteFormat;
  updated_at: number;
  snippet: string;   // may contain <mark>...</mark> from FTS5
}

export interface NoteVersion {
  id: number;
  saved_at: number;
  size: number;
}

export interface NoteVersionFull extends NoteVersion {
  note_id: number;
  content: string;
}

/** Desktop sync status snapshot (mirrors src-tauri/src/models.rs::SyncStatusReport). */
export interface SyncStatusReport {
  configured: boolean;
  online: boolean;
  last_sync_at: number | null;
  pending: number;
  failed: number;
  last_error: string | null;
  running: boolean;
}

/** Desktop settings payload (mirrors src-tauri/src/models.rs::Settings). */
export interface DesktopSettings {
  server_url: string;
  has_token: boolean;
  quick_folder_path: string;
  close_to_tray: boolean;
  autostart: boolean;
  quick_note_clear_on_save: boolean;
  quick_note_close_on_save: boolean;
}
