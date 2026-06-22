// Middle column: notes in selected folder, OR search results when state.searchQuery is set.

import { state, emit, on } from './state';
import { api } from '../api';
import { icons } from '../icons';
import { escapeHtml, makeExcerpt, timeAgo } from '../util';
import { toast } from './toast';
import { pickAndImportFiles } from './import-ui';
import type { FolderId, NoteLite, SearchResult } from '../types';

export function mountNoteList(root: HTMLElement) {
  const render = () => root.innerHTML = build();
  render();
  on('folders', render);          // folder selection / name affects header
  on('notes',   render);          // also driven for search results (same channel)
  on('currentNote', render);      // selected highlight + unsaved dot

  root.addEventListener('click', async (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-action="new-note"]')) return await newNote();
    if (t.closest('[data-action="import"]'))   return pickAndImportFiles();
    const card = t.closest<HTMLElement>('[data-note-id]');
    if (card) {
      const id = Number(card.dataset.noteId);
      window.dispatchEvent(new CustomEvent('note:select', { detail: { id } }));
    }
  });
}

function folderName(id: FolderId, folders: typeof state.folders): string {
  if (id === 'all') return '全部笔记';
  if (id === null)  return '未归类';
  return folders.find(f => f.id === id)?.name ?? '未知';
}

function build(): string {
  return state.searchQuery ? buildSearch() : buildFolder();
}

// ----- Folder view -----

function buildFolder(): string {
  const name = folderName(state.selectedFolderId, state.folders);
  const count = state.notes.length;
  return `
    <div class="note-list-header">
      <div class="text">
        <div class="title">${escapeHtml(name)}</div>
        <div class="sub">${count} 篇 · 按更新时间</div>
      </div>
      <div class="flex items-center gap-1">
        <button class="btn-icon" data-action="import" title="导入 .txt/.md 文件">${icons.upload}</button>
        <button class="btn btn-primary btn-sm" data-action="new-note">
          ${icons.plusSm}<span>新建</span>
        </button>
      </div>
    </div>
    ${count === 0 ? renderFolderEmpty() : state.notes.map(renderFolderCard).join('')}
  `;
}

function renderFolderEmpty(): string {
  return `
    <div class="empty-state">
      <div style="margin-bottom:10px">这里还没有笔记</div>
      <button class="btn btn-primary btn-sm" data-action="new-note">
        ${icons.plusSm}<span>创建第一篇</span>
      </button>
    </div>
  `;
}

function renderFolderCard(n: NoteLite): string {
  const active = state.selectedNoteId === n.id;
  const unsaved = active && state.dirty;
  const title = n.title.trim() || '无标题';
  const excerpt = makeExcerpt(n.excerpt || '', 120) || '空笔记';
  return `
    <div class="note-card ${active ? 'is-active' : ''}" data-note-id="${n.id}">
      <div class="note-title">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(title)}</span>
        ${unsaved ? '<span class="dot-unsaved" title="未保存"></span>' : ''}
      </div>
      <div class="note-excerpt">${escapeHtml(excerpt)}</div>
      <div class="note-meta">${timeAgo(n.updated_at)}</div>
    </div>
  `;
}

// ----- Search view -----

function buildSearch(): string {
  const q = state.searchQuery;
  const count = state.searchResults.length;
  return `
    <div class="note-list-header">
      <div class="text">
        <div class="title">搜索：${escapeHtml(q)}</div>
        <div class="sub">${state.searchLoading ? '搜索中…' : `命中 ${count} 篇`}</div>
      </div>
    </div>
    ${state.searchLoading && count === 0
      ? `<div class="empty-state">搜索中…</div>`
      : count === 0
        ? `<div class="empty-state">没有命中。试试更短或更具体的关键词。</div>`
        : state.searchResults.map(renderSearchCard).join('')}
  `;
}

function renderSearchCard(r: SearchResult): string {
  const active = state.selectedNoteId === r.id;
  const title = r.title.trim() || '无标题';
  // Snippet may contain <mark>...</mark> from FTS5; sanitize everything else.
  const safeSnippet = sanitizeSnippet(r.snippet || '');
  return `
    <div class="note-card ${active ? 'is-active' : ''}" data-note-id="${r.id}">
      <div class="note-title">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(title)}</span>
      </div>
      <div class="note-excerpt">${safeSnippet}</div>
      <div class="note-meta">${timeAgo(r.updated_at)} · ${folderLabel(r.folder_id)}</div>
    </div>
  `;
}

function folderLabel(id: number | null): string {
  if (id == null) return '未归类';
  return escapeHtml(state.folders.find(f => f.id === id)?.name ?? '未知');
}

// Escape user content, then re-allow <mark>...</mark>. Keeps highlights safe.
function sanitizeSnippet(s: string): string {
  return escapeHtml(s)
    .replace(/&lt;mark&gt;/g, '<mark>')
    .replace(/&lt;\/mark&gt;/g, '</mark>');
}

// ----- Actions -----

async function newNote() {
  const target = state.selectedFolderId === 'all' ? null : state.selectedFolderId;
  try {
    const { note } = await api.createNote(target, '', '', 'txt');
    state.notes = [
      { id: note.id, folder_id: note.folder_id, title: note.title, format: note.format, excerpt: '', created_at: note.created_at, updated_at: note.updated_at },
      ...state.notes,
    ];
    emit('notes');
    if (note.folder_id != null) {
      const f = state.folders.find(x => x.id === note.folder_id);
      if (f) { f.note_count = (f.note_count ?? 0) + 1; emit('folders'); }
    }
    window.dispatchEvent(new CustomEvent('note:select', { detail: { id: note.id, focus: true } }));
  } catch {
    toast('新建失败', 'error');
  }
}
