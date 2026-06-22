// Right column: title input + toolbar + CodeMirror source + (optional) markdown preview.

import { state, emit, on, setMobilePane } from './state';
import { api, ApiError } from '../api';
import { icons } from '../icons';
import { debounce, wordCount } from '../util';
import { toast } from './toast';
import { openHistory } from './history';
import type { NoteFormat } from '../types';

import { EditorView, keymap, drawSelection, dropCursor } from '@codemirror/view';
import { Compartment, EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';

import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js/lib/common';

// ---------- Markdown renderer (singleton) ----------
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  highlight(str, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre><code class="hljs language-${lang}">${hljs.highlight(str, { language: lang, ignoreIllegals: true }).value}</code></pre>`;
      } catch { /* fall through */ }
    }
    return `<pre><code class="hljs">${md.utils.escapeHtml(str)}</code></pre>`;
  },
});
const defaultLinkRender = md.renderer.rules.link_open ??
  ((tokens, idx, opts, _env, self) => self.renderToken(tokens, idx, opts));
md.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
  const t = tokens[idx]!;
  t.attrSet('target', '_blank');
  t.attrSet('rel', 'noopener noreferrer');
  return defaultLinkRender(tokens, idx, opts, env, self);
};

// ---------- Editor module ----------
const langCompartment = new Compartment();

let cmView: EditorView | null = null;
let bodyEl: HTMLElement | null = null;
let titleEl: HTMLInputElement | null = null;
let previewEl: HTMLElement | null = null;
let toolbarEl: HTMLElement | null = null;
let crumbEl: HTMLElement | null = null;
let metaEl: HTMLElement | null = null;
let formatSegEl: HTMLElement | null = null;
let viewSegEl: HTMLElement | null = null;
let loadingNoteId: number | null = null;

export function mountEditor(root: HTMLElement) {
  renderShell(root);
  // Full shell re-render only when switching to a different note (or to no-note).
  on('currentNote', () => renderShell(root));
  // Lightweight updates: just refresh toolbar text + crumb. No DOM teardown.
  on('editorMeta',  () => { renderToolbarMeta(); renderCrumb(); });

  window.addEventListener('note:select', (e: Event) => {
    const { id, focus } = (e as CustomEvent).detail as { id: number; focus?: boolean };
    void openNote(id, !!focus);
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
    debouncedSave.flush();
  });
}

// ---------- Shell render ----------

function renderShell(root: HTMLElement) {
  const n = state.currentNote;
  if (!n) {
    root.innerHTML = `
      <div class="empty-state" style="margin:auto;max-width:340px">
        <div style="font-size:42px;line-height:1;margin-bottom:14px;font-family:'Lora',serif;color:var(--muted-fg)">✎</div>
        <div style="font-weight:600;color:var(--fg);margin-bottom:6px;font-size:15px">没有打开的笔记</div>
        <div>从左侧列表选一篇，或在右上角点"新建"开始写。</div>
      </div>
    `;
    cmView = null;
    bodyEl = titleEl = previewEl = toolbarEl = crumbEl = metaEl = formatSegEl = viewSegEl = null;
    return;
  }
  root.innerHTML = `
    <div class="editor-toolbar" id="toolbar" data-format="${n.format}">
      <div class="flex-1 flex items-center gap-2" style="overflow:hidden;min-width:0">
        <span class="crumb" id="crumb"></span>
        <span class="sep" id="meta"></span>
      </div>
      <div class="seg" id="format-seg" title="切换格式">
        <button data-fmt="txt" class="${n.format==='txt' ? 'is-active' : ''}">TXT</button>
        <button data-fmt="md"  class="${n.format==='md'  ? 'is-active' : ''}">Markdown</button>
      </div>
      <div class="seg view-seg" id="view-seg">
        <button data-view="source"  class="${state.view==='source'  ? 'is-active' : ''}">源码</button>
        <button data-view="split"   class="${state.view==='split'   ? 'is-active' : ''}">分屏</button>
        <button data-view="preview" class="${state.view==='preview' ? 'is-active' : ''}">预览</button>
      </div>
      <button class="btn-icon" id="btn-export"  title="导出">${icons.download}</button>
      <button class="btn-icon" id="btn-share"   title="生成分享链接（Step 4）">${icons.share}</button>
      <button class="btn-icon" id="btn-history" title="版本历史">${icons.history}</button>
      <button class="btn-icon danger" id="btn-delete" title="删除笔记">${icons.trashLg}</button>
    </div>
    <input id="title-input" class="editor-title-input" placeholder="标题..." value="" />
    <div class="editor-body" id="editor-body" data-view="${effectiveView(n.format)}" data-format="${n.format}">
      <div class="editor-source" id="cm-host"></div>
      <div class="editor-preview"><article class="prose" id="preview"></article></div>
    </div>
  `;

  toolbarEl   = root.querySelector<HTMLElement>('#toolbar')!;
  titleEl     = root.querySelector<HTMLInputElement>('#title-input')!;
  previewEl   = root.querySelector<HTMLElement>('#preview')!;
  bodyEl      = root.querySelector<HTMLElement>('#editor-body')!;
  crumbEl     = root.querySelector<HTMLElement>('#crumb')!;
  metaEl      = root.querySelector<HTMLElement>('#meta')!;
  formatSegEl = root.querySelector<HTMLElement>('#format-seg')!;
  viewSegEl   = root.querySelector<HTMLElement>('#view-seg')!;

  // ----- Title binding with IME guard -----
  titleEl.value = n.title;
  let titleComposing = false;
  titleEl.addEventListener('compositionstart', () => { titleComposing = true; });
  titleEl.addEventListener('compositionend', () => {
    titleComposing = false;
    if (!state.currentNote) return;
    state.currentNote.title = titleEl!.value;
    markDirty();
  });
  titleEl.addEventListener('input', (e) => {
    // Skip while IME composition is active — final value will sync on compositionend.
    if (titleComposing || (e as InputEvent).isComposing) return;
    if (!state.currentNote) return;
    state.currentNote.title = titleEl!.value;
    markDirty();
  });

  // ----- Format toggle -----
  formatSegEl.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button[data-fmt]') as HTMLButtonElement | null;
    if (!b) return;
    void setFormat(b.dataset.fmt as NoteFormat);
  });

  // ----- View switcher -----
  viewSegEl.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button[data-view]') as HTMLButtonElement | null;
    if (!b) return;
    state.view = b.dataset.view as typeof state.view;
    bodyEl!.dataset.view = state.view;
    viewSegEl!.querySelectorAll<HTMLButtonElement>('button').forEach(x => x.classList.toggle('is-active', x === b));
    if (state.view !== 'source' && state.currentNote?.format === 'md') schedulePreview();
    cmView?.requestMeasure();
  });

  // ----- Actions -----
  root.querySelector('#btn-export')!.addEventListener('click', exportNote);
  root.querySelector('#btn-share')!.addEventListener('click', () => toast('分享链接将在 Step 4 上线', 'info'));
  root.querySelector('#btn-history')!.addEventListener('click', () => {
    if (!state.currentNote) return;
    // flush any pending save first so the latest version is in history
    debouncedSave.flush();
    void openHistory(state.currentNote.id);
  });
  root.querySelector('#btn-delete')!.addEventListener('click', deleteCurrent);

  // ----- CodeMirror -----
  cmView?.destroy();
  cmView = new EditorView({
    parent: root.querySelector<HTMLElement>('#cm-host')!,
    state: EditorState.create({
      doc: n.content,
      extensions: [
        history(),
        drawSelection(),
        dropCursor(),
        EditorView.lineWrapping,
        EditorState.tabSize.of(2),
        langCompartment.of(n.format === 'md' ? [markdown()] : []),
        keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
        EditorView.updateListener.of((u) => {
          if (!u.docChanged || !state.currentNote) return;
          state.currentNote.content = u.state.doc.toString();
          markDirty();
          if (state.currentNote.format === 'md' && state.view !== 'source') schedulePreview();
        }),
      ],
    }),
  });

  renderCrumb();
  renderToolbarMeta();
  if (n.format === 'md') renderPreview(n.content);
}

function effectiveView(fmt: NoteFormat): typeof state.view {
  return fmt === 'txt' ? 'source' : state.view;
}

// ---------- Toolbar updates (no DOM teardown) ----------

function renderCrumb() {
  if (!crumbEl) return;
  const n = state.currentNote;
  if (!n) { crumbEl.innerHTML = ''; return; }
  const folderName =
    n.folder_id == null
      ? '未归类'
      : state.folders.find(f => f.id === n.folder_id)?.name ?? '未知';
  const safe = (s: string) => s.replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]!));
  crumbEl.innerHTML = `${safe(folderName)} <span class="sep">/</span> <span style="color:var(--fg-soft);font-weight:400">${safe(n.title || '无标题')}</span>`;
}

function renderToolbarMeta() {
  if (!metaEl) return;
  const parts: string[] = [];
  if (state.dirty)        parts.push('未保存');
  else if (state.saving)  parts.push('保存中…');
  else if (state.savedAt) parts.push(`保存于 ${formatTime(state.savedAt)}`);
  if (state.currentNote)  parts.push(`${wordCount(state.currentNote.content)} 字`);
  metaEl.textContent = parts.length ? '· ' + parts.join(' · ') : '';
}
function formatTime(ts: number) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

// ---------- Format change (live, no shell rebuild) ----------

async function setFormat(fmt: NoteFormat) {
  const n = state.currentNote;
  if (!n || n.format === fmt || !cmView) return;
  n.format = fmt;
  // Swap language extension via compartment — no editor recreate, no focus loss.
  cmView.dispatch({
    effects: langCompartment.reconfigure(fmt === 'md' ? [markdown()] : []),
  });
  // View-mode adjustments
  if (fmt === 'txt') {
    state.view = 'source';
  } else if (state.view === 'source') {
    state.view = 'split';  // default to split when entering MD
  }
  // Apply chrome changes without rerendering shell
  if (toolbarEl) toolbarEl.dataset.format = fmt;
  if (bodyEl) {
    bodyEl.dataset.format = fmt;
    bodyEl.dataset.view   = state.view;
  }
  formatSegEl?.querySelectorAll<HTMLButtonElement>('button').forEach(b => {
    b.classList.toggle('is-active', b.dataset.fmt === fmt);
  });
  viewSegEl?.querySelectorAll<HTMLButtonElement>('button').forEach(b => {
    b.classList.toggle('is-active', b.dataset.view === state.view);
  });
  if (fmt === 'md') renderPreview(n.content);
  // Persist format change immediately (no debounce — it's a single user action)
  markDirty();
  debouncedSave.flush();
  // Update list to reflect on next save round
  emit('notes');
}

// ---------- Preview ----------

const schedulePreview = debounce(() => {
  const n = state.currentNote;
  if (!n || n.format !== 'md') return;
  renderPreview(n.content);
}, 300);

function renderPreview(src: string) {
  if (!previewEl) return;
  previewEl.innerHTML = md.render(src || '*开始写点什么...*');
}

// ---------- Dirty + auto-save ----------

function markDirty() {
  if (!state.dirty) {
    state.dirty = true;
    emit('editorMeta');
    emit('notes');   // show unsaved dot once
  }
  debouncedSave();
}

const debouncedSave = debounce(() => { void saveNow(); }, 2000);

async function saveNow() {
  const n = state.currentNote;
  if (!n || !state.dirty) return;
  state.saving = true; state.dirty = false; emit('editorMeta');
  try {
    const { note } = await api.updateNote(n.id, {
      title: n.title,
      content: n.content,
      format: n.format,
    });
    // Keep editing in place: mutate the existing currentNote object so we don't
    // emit('currentNote') (which would tear down CodeMirror and steal focus).
    state.currentNote!.title      = note.title;
    state.currentNote!.format     = note.format;
    state.currentNote!.updated_at = note.updated_at;
    // Refresh list entry + bump to top
    const idx = state.notes.findIndex(x => x.id === n.id);
    if (idx >= 0) {
      state.notes[idx] = {
        ...state.notes[idx],
        title: note.title,
        format: note.format,
        updated_at: note.updated_at,
        excerpt: note.content.slice(0, 240),
      };
      const [bumped] = state.notes.splice(idx, 1);
      state.notes.unshift(bumped);
    }
    state.savedAt = Date.now();
    emit('notes');
    emit('editorMeta');
  } catch (e) {
    state.dirty = true;
    if (!(e instanceof ApiError && e.status === 401)) {
      toast('自动保存失败', 'error');
    }
  } finally {
    state.saving = false;
    emit('editorMeta');
  }
}

// ---------- Open / Delete / Export ----------

async function openNote(id: number, focus: boolean) {
  if (state.currentNote?.id === id) {
    setMobilePane('editor');
    if (focus) titleEl?.focus();
    return;
  }
  debouncedSave.flush();
  loadingNoteId = id;
  state.selectedNoteId = id;
  try {
    const { note } = await api.getNote(id);
    if (loadingNoteId !== id) return;
    state.currentNote = note;
    state.dirty = false;
    state.savedAt = note.updated_at;
    emit('currentNote');
    emit('notes');
    setMobilePane('editor');
    if (focus) titleEl?.focus();
  } catch {
    toast('打开笔记失败', 'error');
  }
}

async function deleteCurrent() {
  const n = state.currentNote;
  if (!n) return;
  if (!confirm(`删除笔记 "${n.title || '无标题'}"？此操作不可撤销。`)) return;
  try {
    await api.deleteNote(n.id);
    state.notes = state.notes.filter(x => x.id !== n.id);
    if (n.folder_id != null) {
      const f = state.folders.find(x => x.id === n.folder_id);
      if (f && (f.note_count ?? 0) > 0) { f.note_count!--; emit('folders'); }
    }
    state.currentNote = null;
    state.selectedNoteId = null;
    state.dirty = false;
    emit('notes');
    emit('currentNote');
    toast('已删除');
  } catch {
    toast('删除失败', 'error');
  }
}

function exportNote() {
  const n = state.currentNote;
  if (!n) return;
  const ext = n.format === 'md' ? '.md' : '.txt';
  const filename = (n.title.trim() || `note-${n.id}`)
    .replace(/[\\/:*?"<>|]/g, '_')
    .slice(0, 80) + ext;
  const mime = n.format === 'md' ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8';
  const blob = new Blob([n.content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
  toast('已导出');
}
