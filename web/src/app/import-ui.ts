// Drag-and-drop + file picker import. Reads files client-side and POSTs each
// via the existing create-note API. No server-side change needed.

import { state, emit } from './state';
import { api } from '../api';
import { toast } from './toast';
import type { NoteFormat, Note } from '../types';

const MAX_FILE_BYTES = 1024 * 1024;   // matches server per-note content cap
const MAX_FILES_PER_DROP = 50;
const ACCEPT_EXT = /\.(txt|md|markdown)$/i;

let overlayEl: HTMLDivElement | null = null;
let dragDepth = 0;

export function mountImportUI() {
  overlayEl = document.createElement('div');
  overlayEl.className = 'drop-overlay';
  overlayEl.innerHTML = `
    <div class="drop-overlay-card">
      <div style="font-size:32px;line-height:1;margin-bottom:8px">📥</div>
      <div style="font-weight:600;font-size:15px;color:var(--fg)">松开导入文件</div>
      <div style="font-size:12.5px;color:var(--muted-fg);margin-top:6px">支持 .txt / .md / .markdown · 单文件 ≤ 1 MB · 最多 ${MAX_FILES_PER_DROP} 个</div>
    </div>`;
  document.body.appendChild(overlayEl);

  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e.dataTransfer)) return;
    dragDepth++;
    overlayEl!.classList.add('is-active');
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) overlayEl!.classList.remove('is-active');
  });
  window.addEventListener('dragover', (e) => {
    if (hasFiles(e.dataTransfer)) e.preventDefault();
  });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    dragDepth = 0;
    overlayEl!.classList.remove('is-active');
    if (e.dataTransfer?.files) await handleFiles(e.dataTransfer.files);
  });
}

function hasFiles(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types).includes('Files');
}

// Open the OS file picker.
export function pickAndImportFiles() {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = '.txt,.md,.markdown,text/plain,text/markdown';
  input.addEventListener('change', async () => {
    if (input.files && input.files.length > 0) await handleFiles(input.files);
  });
  input.click();
}

async function handleFiles(fileList: FileList) {
  const all = Array.from(fileList);
  const truncated = all.length > MAX_FILES_PER_DROP;
  const files = all.slice(0, MAX_FILES_PER_DROP);
  if (truncated) toast(`一次最多 ${MAX_FILES_PER_DROP} 个文件，已截断`, 'info');

  // Target folder: current selection. 'all' → 未归类 (null).
  const target = state.selectedFolderId === 'all' ? null : state.selectedFolderId;

  let success = 0, oversized = 0, badtype = 0, failed = 0;
  const created: Note[] = [];

  for (const file of files) {
    if (!ACCEPT_EXT.test(file.name) && file.type && !/^text\//.test(file.type)) {
      badtype++; continue;
    }
    if (file.size > MAX_FILE_BYTES) { oversized++; continue; }
    try {
      const content = await file.text();
      const lower = file.name.toLowerCase();
      const format: NoteFormat = (lower.endsWith('.md') || lower.endsWith('.markdown')) ? 'md' : 'txt';
      const title = file.name.replace(/\.(txt|md|markdown)$/i, '').slice(0, 500) || 'untitled';
      const { note } = await api.createNote(target, title, content, format);
      created.push(note);
      success++;
    } catch {
      failed++;
    }
  }

  if (created.length > 0) {
    state.notes = [
      ...created.map(n => ({
        id: n.id, folder_id: n.folder_id, title: n.title, format: n.format,
        excerpt: (n.content || '').slice(0, 240),
        created_at: n.created_at, updated_at: n.updated_at,
      })),
      ...state.notes,
    ];
    emit('notes');
    if (target != null) {
      const f = state.folders.find(x => x.id === target);
      if (f) { f.note_count = (f.note_count ?? 0) + created.length; emit('folders'); }
    }
  }

  const errors = oversized + badtype + failed;
  if (errors === 0) {
    toast(`已导入 ${success} 个文件`);
  } else {
    const parts = [`成功 ${success}`];
    if (oversized) parts.push(`过大 ${oversized}`);
    if (badtype)   parts.push(`格式不符 ${badtype}`);
    if (failed)    parts.push(`失败 ${failed}`);
    toast(`导入完成：${parts.join(' · ')}`, success > 0 ? 'info' : 'error', 4000);
  }
}
