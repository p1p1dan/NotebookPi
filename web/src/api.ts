// Tiny fetch wrapper. JSON in, JSON out. 401 redirects to login screen.

import type { Folder, Note, NoteLite, NoteFormat, SearchResult, NoteVersion, NoteVersionFull } from './types';

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

export const api = {
  // --- auth ---
  me:     () => request<{ authed: boolean }>('GET', '/api/me'),
  login:  (password: string) => request<{ ok: true }>('POST', '/api/login', { password }),
  logout: () => request<{ ok: true }>('POST', '/api/logout'),

  // --- folders ---
  listFolders:   () => request<{ folders: Folder[] }>('GET', '/api/folders'),
  createFolder:  (parent_id: number | null, name: string) =>
    request<{ folder: Folder }>('POST', '/api/folders', { parent_id, name }),
  renameFolder:  (id: number, name: string) =>
    request<{ folder: Folder }>('PATCH', `/api/folders/${id}`, { name }),
  moveFolder:    (id: number, parent_id: number | null) =>
    request<{ folder: Folder }>('PATCH', `/api/folders/${id}`, { parent_id }),
  deleteFolder:  (id: number) => request<{ ok: true }>('DELETE', `/api/folders/${id}`),

  // --- notes ---
  listNotes: (folderId: number | null | 'all' | undefined) => {
    const q = folderId === 'all' ? '?folder_id=all'
      : folderId == null ? ''
      : `?folder_id=${folderId}`;
    return request<{ notes: NoteLite[] }>('GET', `/api/notes${q}`);
  },
  getNote:    (id: number) => request<{ note: Note }>('GET', `/api/notes/${id}`),
  createNote: (folder_id: number | null, title = '', content = '', format: NoteFormat = 'txt') =>
    request<{ note: Note }>('POST', '/api/notes', { folder_id, title, content, format }),
  updateNote: (id: number, patch: Partial<Pick<Note, 'title' | 'content' | 'folder_id' | 'format'>>) =>
    request<{ note: Note }>('PUT', `/api/notes/${id}`, patch),
  deleteNote: (id: number) => request<{ ok: true }>('DELETE', `/api/notes/${id}`),

  // --- search ---
  search: (q: string) =>
    request<{ query: string; results: SearchResult[] }>('GET', `/api/search?q=${encodeURIComponent(q)}`),

  // --- versions ---
  listVersions: (noteId: number) =>
    request<{ versions: NoteVersion[] }>('GET', `/api/notes/${noteId}/versions`),
  getVersion: (noteId: number, vid: number) =>
    request<{ version: NoteVersionFull }>('GET', `/api/notes/${noteId}/versions/${vid}`),
  restoreVersion: (noteId: number, vid: number) =>
    request<{ note: Note }>('POST', `/api/notes/${noteId}/versions/${vid}/restore`),
};
