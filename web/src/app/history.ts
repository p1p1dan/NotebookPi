// Version history drawer. Opens on the right, lists past saved versions,
// lets the user preview and restore.

import { api, ApiError } from '../api';
import { state, emit } from './state';
import { icons } from '../icons';
import { escapeHtml, timeAgo } from '../util';
import { toast } from './toast';
import type { NoteVersion } from '../types';

let drawerEl: HTMLElement | null = null;
let noteId: number | null = null;
let versions: NoteVersion[] = [];
let selectedVid: number | null = null;
let previewContent = '';
let loading = false;
let restoring = false;

function ensureDrawer() {
  if (drawerEl) return;
  drawerEl = document.createElement('div');
  drawerEl.className = 'history-drawer';
  drawerEl.innerHTML = '';
  document.body.appendChild(drawerEl);

  drawerEl.addEventListener('click', async (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-action="close"]')) return close();
    if (t.closest('[data-action="restore"]')) return await restore();
    const item = t.closest<HTMLElement>('[data-vid]');
    if (item) {
      const vid = Number(item.dataset.vid);
      await selectVersion(vid);
    }
  });

  // ESC to close
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawerEl?.classList.contains('is-open')) close();
  });
}

export async function openHistory(forNoteId: number) {
  ensureDrawer();
  noteId = forNoteId;
  versions = [];
  selectedVid = null;
  previewContent = '';
  loading = true;
  render();
  drawerEl!.classList.add('is-open');
  try {
    const { versions: vs } = await api.listVersions(forNoteId);
    if (noteId !== forNoteId) return;  // user navigated away
    versions = vs;
    if (vs.length > 0) {
      await selectVersion(vs[0].id);
    } else {
      loading = false;
      render();
    }
  } catch (e) {
    loading = false;
    render();
    if (!(e instanceof ApiError && e.status === 401)) {
      toast('加载版本历史失败', 'error');
    }
  }
}

async function selectVersion(vid: number) {
  if (!noteId) return;
  selectedVid = vid;
  loading = true;
  render();
  try {
    const { version } = await api.getVersion(noteId, vid);
    if (selectedVid !== vid) return;
    previewContent = version.content;
  } catch {
    previewContent = '';
    toast('加载版本失败', 'error');
  } finally {
    loading = false;
    render();
  }
}

async function restore() {
  if (!noteId || selectedVid == null || restoring) return;
  if (!confirm('用这个版本覆盖当前内容？\n（当前内容会保留在版本历史中，可以再恢复回来）')) return;
  restoring = true;
  render();
  try {
    const { note } = await api.restoreVersion(noteId, selectedVid);
    // Update current note in app state and re-render editor.
    if (state.currentNote?.id === note.id) {
      state.currentNote = note;
      state.dirty = false;
      state.savedAt = note.updated_at;
      emit('currentNote');
    }
    // Bump in list
    const idx = state.notes.findIndex(x => x.id === note.id);
    if (idx >= 0) {
      state.notes[idx] = {
        ...state.notes[idx],
        title: note.title, format: note.format,
        updated_at: note.updated_at, excerpt: note.content.slice(0, 240),
      };
      const [bumped] = state.notes.splice(idx, 1);
      state.notes.unshift(bumped);
      emit('notes');
    }
    toast('已恢复');
    close();
  } catch {
    toast('恢复失败', 'error');
  } finally {
    restoring = false;
    render();
  }
}

function close() {
  drawerEl?.classList.remove('is-open');
  noteId = null;
  versions = [];
  selectedVid = null;
  previewContent = '';
}

function render() {
  if (!drawerEl) return;
  drawerEl.innerHTML = `
    <div class="history-header">
      <span style="font-weight:600">版本历史</span>
      <button class="btn-icon" data-action="close" title="关闭">
        <svg class="icon" viewBox="0 0 24 24"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
      </button>
    </div>
    <div class="history-body">
      <ul class="history-list">
        ${versions.length === 0 && !loading
          ? `<li class="history-empty">这条笔记还没有历史版本<br/><span style="font-size:11px">每次保存且内容有变化时会自动留存一版（最多 50 版）</span></li>`
          : versions.map(renderItem).join('')}
      </ul>
      <div class="history-preview">
        ${selectedVid == null
          ? `<div class="empty-state" style="padding:30px 16px">${loading ? '加载中…' : '选一个版本预览'}</div>`
          : `<pre class="history-preview-content">${escapeHtml(previewContent)}</pre>
             <div class="history-actions">
               <button class="btn" data-action="close">取消</button>
               <button class="btn btn-primary" data-action="restore" ${restoring ? 'disabled' : ''}>
                 ${restoring ? '恢复中…' : '恢复此版本'}
               </button>
             </div>`}
      </div>
    </div>
  `;
}

function renderItem(v: NoteVersion): string {
  const active = v.id === selectedVid;
  return `
    <li class="history-item ${active ? 'is-active' : ''}" data-vid="${v.id}">
      <div class="history-item-time">${formatVersionTime(v.saved_at)}</div>
      <div class="history-item-size">${formatSize(v.size)}</div>
    </li>
  `;
}

function formatVersionTime(ts: number): string {
  // More precise than timeAgo — versions are often close together.
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const sameYesterday = d.toDateString() === yesterday.toDateString();
  const hm = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
  if (sameDay)       return `今天 ${hm}`;
  if (sameYesterday) return `昨天 ${hm}`;
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2,'0')}.${String(d.getDate()).padStart(2,'0')} ${hm}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024)   return `${bytes} 字节`;
  if (bytes < 102400) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${Math.round(bytes / 1024)} KB`;
}

// Allow callers to also retrieve relative-time helper for parity with note-list.
export { timeAgo };
