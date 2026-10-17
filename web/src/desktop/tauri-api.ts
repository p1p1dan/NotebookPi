// Tauri-side ApiAdapter: every call goes to a Rust IPC command.
//
// The shape is compatible with browserApi so all existing UI modules continue
// to work unchanged. Versions / folder CRUD endpoints that haven't been ported
// to the desktop runtime yet throw, allowing callers to degrade gracefully.

import { invoke } from '@tauri-apps/api/core';
import type { ApiAdapter } from '../api';
import type {
  Folder,
  Note,
  NoteLite,
  NoteFormat,
  SearchResult,
  SyncStatusReport,
  DesktopSettings,
  NoteVersion,
  NoteVersionFull,
  ShareInfo,
} from '../types';

// ---- Rust shape adapters ----
//
// Folder rows from rusqlite carry remote_id/parent_remote_id/path; the rest of
// the app expects parent_id (server numbering). We treat remote_id as the
// stable id when present and fall back to the local id otherwise.
function toFolder(r: any): Folder {
  const id = r.remote_id ?? r.id;
  return {
    id,
    parent_id: r.parent_remote_id ?? null,
    name: r.name,
    created_at: r.created_at,
    note_count: r.note_count ?? 0,
    remote_id: r.remote_id,
    path: r.path,
  };
}

function toNoteLite(r: any): NoteLite {
  return {
    id: r.id, // local id (rusqlite rowid). desktop UI uses this as the stable handle.
    folder_id: r.folder_remote_id ?? null,
    title: r.title,
    format: (r.format as NoteFormat) ?? 'txt',
    excerpt: r.excerpt ?? '',
    created_at: r.created_at,
    updated_at: r.updated_at,
    pinned: !!r.pinned,
    sync_status: r.sync_status,
    remote_id: r.remote_id,
  };
}

function toNote(r: any): Note {
  return {
    id: r.id,
    folder_id: r.folder_remote_id ?? null,
    title: r.title,
    content: r.content ?? '',
    format: (r.format as NoteFormat) ?? 'txt',
    created_at: r.created_at,
    updated_at: r.updated_at,
    pinned: !!r.pinned,
    sync_status: r.sync_status,
    remote_id: r.remote_id,
  };
}

function toSearchResult(r: any): SearchResult {
  return {
    id: r.id, // local id (or 0 if remote-only)
    folder_id: r.folder_remote_id ?? null,
    title: r.title,
    format: (r.format as NoteFormat) ?? 'txt',
    updated_at: r.updated_at,
    snippet: r.snippet,
  };
}

const notSupported = (op: string) => async () => {
  throw new Error(`${op} is not available in desktop runtime`);
};

export const tauriApi: ApiAdapter = {
  // ---- auth: desktop has no login flow; always authed via Bearer token. ----
  me:     async () => ({ authed: true }),
  login:  async () => ({ ok: true }),
  logout: async () => ({ ok: true }),

  // ---- folders ----
  listFolders: async () => {
    const folders = await invoke<any[]>('cmd_list_folders');
    return { folders: folders.map(toFolder) };
  },
  createFolder: async (parent_id, name) => {
    const folder = await invoke<any>('cmd_create_folder', { parentId: parent_id, name });
    return { folder: toFolder(folder) };
  },
  renameFolder: async (id, name) => {
    const folder = await invoke<any>('cmd_rename_folder', { id, name });
    return { folder: toFolder(folder) };
  },
  moveFolder: notSupported('moveFolder') as any,
  deleteFolder: async (id) => {
    await invoke<void>('cmd_delete_folder', { id });
    return { ok: true };
  },

  // ---- notes ----
  listNotes: async (folderId) => {
    const notes = await invoke<any[]>('cmd_list_notes', { folderId: folderId ?? null });
    return { notes: notes.map(toNoteLite) };
  },
  getNote: async (localId) => {
    const note = await invoke<any>('cmd_get_note', { localId });
    return { note: toNote(note) };
  },
  createNote: async (folder_id, title = '', content = '', format = 'txt' as NoteFormat) => {
    const note = await invoke<any>('cmd_create_note', {
      input: {
        folder_remote_id: folder_id,
        folder_path: null,
        title,
        content,
        format,
      },
    });
    return { note: toNote(note) };
  },
  updateNote: async (localId, patch) => {
    // 老王注:folder_id 必须只在显式提供时才放进 payload。
    // 上一版用 { Some: x } 这种 enum 写法 → Rust 端 Option<Option<i64>> 反序列化失败 → 移动操作全报错。
    // 现在 Rust 端用 deserialize_some 把"字段出现"识别为外层 Some,所以这里:
    //   - patch.folder_id 未指定 → 不放字段 → Rust 端 None(不改)
    //   - patch.folder_id === null → folder_remote_id: null → Some(None)(移到根)
    //   - patch.folder_id 是数字 → folder_remote_id: N → Some(Some(N))(移到目标)
    const payload: Record<string, unknown> = {
      title: patch.title ?? null,
      content: patch.content ?? null,
      format: patch.format ?? null,
    };
    if (patch.folder_id !== undefined) {
      payload.folder_remote_id = patch.folder_id;
    }
    if (patch.pinned !== undefined) {
      payload.pinned = patch.pinned;
    }
    const note = await invoke<any>('cmd_update_note', { localId, patch: payload });
    return { note: toNote(note) };
  },
  deleteNote: async (localId) => {
    await invoke<void>('cmd_delete_note', { localId });
    return { ok: true };
  },

  // ---- search ----
  search: async (q) => {
    const hits = await invoke<any[]>('cmd_search_notes', { q });
    return { query: q, results: hits.map(toSearchResult) };
  },

  // ---- versions: 桌面端走 Rust 代理到远端,本地不缓存版本数据 ----
  listVersions: async (noteId) => {
    const versions = await invoke<any[]>('cmd_list_versions', { noteId });
    return { versions };
  },
  getVersion: async (noteId, vid) => {
    const version = await invoke<any>('cmd_get_version', { noteId, vid });
    return { version };
  },
  restoreVersion: async (noteId, vid) => {
    const note = await invoke<any>('cmd_restore_version', { noteId, vid });
    return { note: toNote(note) };
  },

  // ---- shares: 走 Rust 代理到远端,链接用配置的服务器地址拼接 ----
  getShare: async (noteId) => {
    const share = await invoke<ShareInfo | null>('cmd_get_share', { noteId });
    return { share };
  },
  createShare: async (noteId) => {
    const share = await invoke<ShareInfo>('cmd_create_share', { noteId });
    return { share };
  },
  revokeShare: async (noteId) => {
    await invoke<void>('cmd_revoke_share', { noteId });
    return { ok: true };
  },
};

// ---- desktop-only extras (used by settings/quick-note/sync UI) ----

export async function createNoteByPath(
  folderPath: string,
  title: string,
  content: string,
  format: NoteFormat = 'txt',
): Promise<Note> {
  const note = await invoke<any>('cmd_create_note', {
    input: {
      folder_remote_id: null,
      folder_path: folderPath,
      title,
      content,
      format,
    },
  });
  return toNote(note);
}

export async function getSettings(): Promise<DesktopSettings> {
  return invoke<DesktopSettings>('cmd_get_settings');
}

export async function setSettings(s: DesktopSettings): Promise<DesktopSettings> {
  return invoke<DesktopSettings>('cmd_set_settings', { settings: s });
}

export async function saveToken(token: string): Promise<void> {
  await invoke<void>('cmd_save_token', { token });
}

export async function clearToken(): Promise<void> {
  await invoke<void>('cmd_clear_token');
}

export async function hasToken(): Promise<boolean> {
  return invoke<boolean>('cmd_has_token');
}

export async function syncStatus(): Promise<SyncStatusReport> {
  return invoke<SyncStatusReport>('cmd_sync_status');
}

export async function syncNow(): Promise<SyncStatusReport> {
  return invoke<SyncStatusReport>('cmd_sync_now');
}

export async function retryFailed(): Promise<SyncStatusReport> {
  return invoke<SyncStatusReport>('cmd_retry_failed');
}

export async function showQuickNote(): Promise<void> {
  await invoke<void>('cmd_show_quick_note');
}

export async function hideQuickNote(): Promise<void> {
  await invoke<void>('cmd_hide_quick_note');
}

export async function ensureFolderPath(path: string): Promise<Folder> {
  const f = await invoke<any>('cmd_ensure_folder_path', { path });
  return toFolder(f);
}

// Re-export _NoteVersion / _NoteVersionFull so type-only imports in callers work
// without breaking strict mode if a future iteration adds desktop history.
export type { NoteVersion, NoteVersionFull };
