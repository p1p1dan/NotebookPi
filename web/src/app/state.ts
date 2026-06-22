// Centralized state + tiny pub/sub. No framework; just a Set of subscribers.

import type { Folder, NoteLite, Note, FolderId, SearchResult } from '../types';

export type ViewMode = 'source' | 'split' | 'preview';

export interface AppState {
  folders: Folder[];
  notes: NoteLite[];
  selectedFolderId: FolderId;  // null = root, 'all' = everything
  selectedNoteId: number | null;
  currentNote: Note | null;
  view: ViewMode;
  dirty: boolean;        // editor has unsaved changes
  saving: boolean;       // a save request is in flight
  savedAt: number | null;
  theme: 'light' | 'dark';
  // search
  searchQuery: string;
  searchResults: SearchResult[];
  searchLoading: boolean;
  // mobile navigation (no-op at desktop widths)
  mobilePane: 'folders' | 'notes' | 'editor';
}

export const state: AppState = {
  folders: [],
  notes: [],
  selectedFolderId: 'all',
  selectedNoteId: null,
  currentNote: null,
  view: 'split',
  dirty: false,
  saving: false,
  savedAt: null,
  theme: (localStorage.getItem('theme') as 'light' | 'dark') || 'light',
  searchQuery: '',
  searchResults: [],
  searchLoading: false,
  mobilePane: 'notes',
};

type Channel = 'folders' | 'notes' | 'currentNote' | 'editorMeta' | 'theme';
const subs = new Map<Channel, Set<() => void>>();

export function on(channel: Channel, fn: () => void) {
  if (!subs.has(channel)) subs.set(channel, new Set());
  subs.get(channel)!.add(fn);
  return () => subs.get(channel)!.delete(fn);
}

export function emit(channel: Channel) {
  subs.get(channel)?.forEach(fn => { try { fn(); } catch (e) { console.error(e); } });
}

export function setTheme(t: 'light' | 'dark') {
  state.theme = t;
  document.documentElement.dataset.theme = t;
  localStorage.setItem('theme', t);
  emit('theme');
}

export function setMobilePane(p: AppState['mobilePane']) {
  state.mobilePane = p;
  const row = document.querySelector<HTMLElement>('.main-row');
  if (row) row.dataset.mobilePane = p;
  const back = document.getElementById('topbar-back');
  if (back) back.classList.toggle('is-hidden', p === 'folders');
}
