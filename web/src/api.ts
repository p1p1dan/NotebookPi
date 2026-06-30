// Tiny fetch wrapper. JSON in, JSON out. 401 redirects to login screen.
//
// In the browser deploy, this hits the Fastify backend directly.
// In the Tauri desktop runtime, runtime.ts replaces `api` with a Tauri adapter
// before any UI module imports it (see web/src/runtime.ts).

import type {
  Folder,
  Note,
  NoteLite,
  NoteFormat,
  SearchResult,
  NoteVersion,
  NoteVersionFull,
} from './types';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

async function request<T = any>(method: Method, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data: any = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    try { data = await res.json(); } catch { /* ignore */ }
  }
  if (!res.ok) {
    const code = (data && data.error) || `http_${res.status}`;
    if (res.status === 401 && path !== '/api/login' && path !== '/api/me') {
      // session expired or never authed → drop event so the shell rerenders to login.
      window.dispatchEvent(new CustomEvent('auth:lost'));
    }
    throw new ApiError(res.status, code);
  }
  return data as T;
}

/// Surface the contract every other module depends on. Both the browser and
/// the desktop adapter implement this shape.
export interface ApiAdapter {
  // auth
  me: () => Promise<{ authed: boolean }>;
  login: (password: string) => Promise<{ ok: true }>;
  logout: () => Promise<{ ok: true }>;
  // folders
  listFolders: () => Promise<{ folders: Folder[] }>;
  createFolder: (parent_id: number | null, name: string) => Promise<{ folder: Folder }>;
  renameFolder: (id: number, name: string) => Promise<{ folder: Folder }>;
  moveFolder: (id: number, parent_id: number | null) => Promise<{ folder: Folder }>;
  deleteFolder: (id: number) => Promise<{ ok: true }>;
  // notes
  listNotes: (folderId: number | null | 'all' | undefined) => Promise<{ notes: NoteLite[] }>;
  getNote: (id: number) => Promise<{ note: Note }>;
  createNote: (
    folder_id: number | null,
    title?: string,
    content?: string,
    format?: NoteFormat,
  ) => Promise<{ note: Note }>;
  updateNote: (
    id: number,
    patch: Partial<Pick<Note, 'title' | 'content' | 'folder_id' | 'format'>>,
  ) => Promise<{ note: Note }>;
  deleteNote: (id: number) => Promise<{ ok: true }>;
  // search
  search: (q: string) => Promise<{ query: string; results: SearchResult[] }>;
  // versions (browser only — desktop adapter throws so callers can degrade)
  listVersions: (noteId: number) => Promise<{ versions: NoteVersion[] }>;
  getVersion: (noteId: number, vid: number) => Promise<{ version: NoteVersionFull }>;
  restoreVersion: (noteId: number, vid: number) => Promise<{ note: Note }>;
}

export const browserApi: ApiAdapter = {
  // --- auth ---
  me:     () => request<{ authed: boolean }>('GET', '/api/me'),
  login:  (password: string) => request<{ ok: true }>('POST', '/api/login', { password }),
  logout: () => request<{ ok: true }>('POST', '/api/logout'),

  // --- folders ---
  listFolders:   () => request<{ folders: Folder[] }>('GET', '/api/folders'),
  createFolder:  (parent_id, name) =>
    request<{ folder: Folder }>('POST', '/api/folders', { parent_id, name }),
  renameFolder:  (id, name) =>
    request<{ folder: Folder }>('PATCH', `/api/folders/${id}`, { name }),
  moveFolder:    (id, parent_id) =>
    request<{ folder: Folder }>('PATCH', `/api/folders/${id}`, { parent_id }),
  deleteFolder:  (id) => request<{ ok: true }>('DELETE', `/api/folders/${id}`),

  // --- notes ---
  listNotes: (folderId) => {
    const q = folderId === 'all' ? '?folder_id=all'
      : folderId == null ? ''
      : `?folder_id=${folderId}`;
    return request<{ notes: NoteLite[] }>('GET', `/api/notes${q}`);
  },
  getNote:    (id) => request<{ note: Note }>('GET', `/api/notes/${id}`),
  createNote: (folder_id, title = '', content = '', format = 'txt' as NoteFormat) =>
    request<{ note: Note }>('POST', '/api/notes', { folder_id, title, content, format }),
  updateNote: (id, patch) =>
    request<{ note: Note }>('PUT', `/api/notes/${id}`, patch),
  deleteNote: (id) => request<{ ok: true }>('DELETE', `/api/notes/${id}`),

  // --- search ---
  search: (q) =>
    request<{ query: string; results: SearchResult[] }>('GET', `/api/search?q=${encodeURIComponent(q)}`),

  // --- versions ---
  listVersions: (noteId) =>
    request<{ versions: NoteVersion[] }>('GET', `/api/notes/${noteId}/versions`),
  getVersion: (noteId, vid) =>
    request<{ version: NoteVersionFull }>('GET', `/api/notes/${noteId}/versions/${vid}`),
  restoreVersion: (noteId, vid) =>
    request<{ note: Note }>('POST', `/api/notes/${noteId}/versions/${vid}/restore`),
};

// Default export is mutable: runtime.ts swaps it before main.ts boot completes.
export let api: ApiAdapter = browserApi;

export function setApiAdapter(next: ApiAdapter) {
  api = next;
}
