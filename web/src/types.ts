export type NoteFormat = 'txt' | 'md';

export interface Folder {
  id: number;
  parent_id: number | null;
  name: string;
  created_at: number;
  note_count?: number;
}

export interface NoteLite {
  id: number;
  folder_id: number | null;
  title: string;
  format: NoteFormat;
  excerpt?: string;
  created_at: number;
  updated_at: number;
}

export interface Note extends NoteLite {
  content: string;
}

export type FolderId = number | null | 'all';

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
