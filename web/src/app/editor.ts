// Right column: title input + toolbar + CodeMirror source + (optional) markdown preview.

import { state, emit, on, setMobilePane } from './state';
import { api, ApiError } from '../api';
import { icons } from '../icons';
import { debounce, wordCount } from '../util';
import { toast } from './toast';
import { openHistory } from './history';
import type { NoteFormat } from '../types';

import { EditorView, keymap, drawSelection, dropCursor, Decoration, type DecorationSet } from '@codemirror/view';
import { Compartment, EditorState, StateEffect, StateField, RangeSetBuilder } from '@codemirror/state';
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
let viewSegEl: HTMLElement | null = null;
let loadingNoteId: number | null = null;

export function mountEditor(root: HTMLElement) {
  renderShell(root);
  // Full shell re-render only when switching to a different note (or to no-note).
  on('currentNote', () => {
    renderShell(root);
    // 切到新笔记后,若仍处于搜索态,把高亮+跳转应用上去
    if (state.searchQuery) applySearchHighlight(state.searchQuery);
  });
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

  // 全局 Ctrl/Cmd+S 立即保存。监听只挂一次(mountEditor 在 boot 期间调用一次)。
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      // 编辑器 / 输入框里也允许触发,但不让浏览器走默认"保存网页"
      e.preventDefault();
      if (state.dirty) void saveNow();
    }
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
    bodyEl = titleEl = previewEl = toolbarEl = crumbEl = metaEl = viewSegEl = null;
    return;
  }
  root.innerHTML = `
    <div class="editor-toolbar" id="toolbar" data-format="${n.format}">
      <div class="flex-1 flex items-center gap-2" style="overflow:hidden;min-width:0">
        <span class="crumb" id="crumb"></span>
        <span class="sep" id="meta"></span>
      </div>
      <div class="seg view-seg" id="view-seg">
        <button data-view="source"  class="${state.view==='source'  ? 'is-active' : ''}">源码</button>
        <button data-view="split"   class="${state.view==='split'   ? 'is-active' : ''}">分屏</button>
        <button data-view="preview" class="${state.view==='preview' ? 'is-active' : ''}">预览</button>
      </div>
      <button class="btn-icon" id="btn-move"    title="移动到文件夹">${icons.folder}</button>
      <button class="btn-icon" id="btn-save"    title="保存 (Ctrl+S)">${icons.save ?? icons.download}</button>
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

  // ----- Format toggle 已删除:格式建立时确定,后续不让改 -----

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
  root.querySelector('#btn-move')!.addEventListener('click', (e) => {
    openMovePopover(e.currentTarget as HTMLElement);
  });
  root.querySelector('#btn-save')!.addEventListener('click', () => {
    void saveNow();
  });
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
        searchHighlightField,
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

// ---------- Preview ----------

const schedulePreview = debounce(() => {
  const n = state.currentNote;
  if (!n || n.format !== 'md') return;
  renderPreview(n.content);
}, 300);

function renderPreview(src: string) {
  if (!previewEl) return;
  previewEl.innerHTML = md.render(src || '*开始写点什么...*');
  if (state.searchQuery) markPreviewHits(previewEl, state.searchQuery);
}

// ---------- Dirty + auto-save ----------

const AUTO_SAVE_INTERVAL_MS = 5 * 60 * 1000; // 老王注:5 分钟周期足够,频繁同步是 SB 行为
let autoSaveTimer: ReturnType<typeof setInterval> | null = null;

function ensureAutoSaveTimer() {
  if (autoSaveTimer != null) return;
  autoSaveTimer = setInterval(() => {
    if (state.dirty) void saveNow();
  }, AUTO_SAVE_INTERVAL_MS);
}

function markDirty() {
  if (!state.dirty) {
    state.dirty = true;
    emit('editorMeta');
    emit('notes');   // show unsaved dot once
  }
  ensureAutoSaveTimer();
}

/// 保留 debouncedSave 这个名字给外部 flush 用,但实现已经不再是 debounce。
/// 兼容现有调用:flush() = 立即保存。
const debouncedSave = {
  flush: () => { if (state.dirty) void saveNow(); },
};

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

// ---------- 移动到文件夹 ----------

function openMovePopover(anchor: HTMLElement) {
  const n = state.currentNote;
  if (!n) return;

  const existing = document.getElementById('mv-pop');
  if (existing) { existing.remove(); return; }

  const pop = document.createElement('div');
  pop.id = 'mv-pop';
  pop.className = 'move-popover';

  // 构建按 path 排序的文件夹路径,缩进显示层级
  type Item = { id: number | null; label: string; depth: number };
  const items: Item[] = [{ id: null, label: '未归类', depth: 0 }];
  const byParent = new Map<number | null, typeof state.folders>();
  state.folders.forEach(f => {
    const arr = byParent.get(f.parent_id ?? null) || [];
    arr.push(f);
    byParent.set(f.parent_id ?? null, arr);
  });
  const sortByName = (a: any, b: any) => a.name.localeCompare(b.name);
  function walk(parentId: number | null, depth: number) {
    const list = (byParent.get(parentId) || []).slice().sort(sortByName);
    for (const f of list) {
      items.push({ id: f.id, label: f.name, depth });
      walk(f.id, depth + 1);
    }
  }
  walk(null, 1);

  const safe = (s: string) => s.replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]!));
  pop.innerHTML = `
    <div class="mv-title">移动到</div>
    ${items.map(it => {
      const cur = (n.folder_id ?? null) === it.id;
      const indent = it.depth * 14;
      return `<button class="mv-item ${cur ? 'is-current' : ''}" data-target="${it.id ?? 'null'}" style="padding-left:${10 + indent}px">${safe(it.label)}${cur ? ' ✓' : ''}</button>`;
    }).join('')}
  `;
  document.body.appendChild(pop);

  // 定位
  const r = anchor.getBoundingClientRect();
  const popRect = pop.getBoundingClientRect();
  let left = r.right - popRect.width;
  if (left < 8) left = 8;
  let top = r.bottom + 6;
  if (top + popRect.height > window.innerHeight - 8) top = Math.max(8, r.top - popRect.height - 6);
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;

  const close = () => {
    pop.remove();
    document.removeEventListener('click', onDocClick, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const onDocClick = (e: MouseEvent) => {
    if (!pop.contains(e.target as Node) && e.target !== anchor && !anchor.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };

  pop.addEventListener('click', async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-target]');
    if (!b) return;
    if (b.classList.contains('is-current')) { close(); return; }
    const raw = b.dataset.target!;
    const target: number | null = raw === 'null' ? null : Number(raw);
    close();
    void moveCurrentTo(target);
  });
  setTimeout(() => {
    document.addEventListener('click', onDocClick, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);
}

async function moveCurrentTo(folder_id: number | null) {
  const n = state.currentNote;
  if (!n) return;
  const oldFolder = n.folder_id ?? null;
  if (oldFolder === folder_id) return;
  try {
    const { note } = await api.updateNote(n.id, { folder_id });
    // 更新当前编辑态(不重建 CodeMirror)
    state.currentNote!.folder_id = note.folder_id;
    state.currentNote!.updated_at = note.updated_at;
    // 更新列表项
    const idx = state.notes.findIndex(x => x.id === n.id);
    if (idx >= 0) {
      // 笔记移走了:从当前列表移除(除非当前是"全部笔记")
      if (state.selectedFolderId === 'all') {
        state.notes[idx] = { ...state.notes[idx], folder_id: note.folder_id, updated_at: note.updated_at };
      } else if (state.selectedFolderId === folder_id) {
        // 仍在当前视图(理论上不会发生,因为 oldFolder !== folder_id)
        state.notes[idx] = { ...state.notes[idx], folder_id: note.folder_id, updated_at: note.updated_at };
      } else {
        state.notes.splice(idx, 1);
      }
    }
    // 更新两边 note_count
    if (oldFolder != null) {
      const of = state.folders.find(x => x.id === oldFolder);
      if (of && (of.note_count ?? 0) > 0) of.note_count!--;
    }
    if (folder_id != null) {
      const nf = state.folders.find(x => x.id === folder_id);
      if (nf) nf.note_count = (nf.note_count ?? 0) + 1;
    }
    emit('folders');
    emit('notes');
    emit('editorMeta');  // crumb 里有文件夹名,需要刷新
    renderCrumb();
    toast('已移动');
  } catch {
    toast('移动失败', 'error');
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

// ---------- Search highlight (CodeMirror Decoration + preview DOM mark) ----------
// 老王注:不引入 @codemirror/search 那一坨包(YAGNI),用 StateField + Decoration.mark 自己撸
// 一个最小高亮。case-insensitive substring 命中,首匹配 scrollIntoView + 选中,
// preview 端走 textNode walker 包 <mark>。MAX_HITS 是防御性上限。

const MIN_QUERY_LEN = 2;
const MAX_HITS = 200;
const PREVIEW_MARK_CLASS = 'preview-hit';

const setSearchEffect = StateEffect.define<string>();
const searchHitDeco = Decoration.mark({ class: 'cm-search-hit' });

const searchHighlightField = StateField.define<DecorationSet>({
  create() { return Decoration.none; },
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setSearchEffect)) continue;
      const q = e.value;
      if (!q || q.length < MIN_QUERY_LEN) { next = Decoration.none; continue; }
      const doc = tr.state.doc.toString();
      const lower = doc.toLowerCase();
      const needle = q.toLowerCase();
      const builder = new RangeSetBuilder<Decoration>();
      let pos = 0, hits = 0;
      while (hits < MAX_HITS) {
        const i = lower.indexOf(needle, pos);
        if (i < 0) break;
        builder.add(i, i + needle.length, searchHitDeco);
        hits++;
        pos = i + needle.length;
      }
      next = builder.finish();
    }
    return next;
  },
  provide: f => EditorView.decorations.from(f),
});

/// 应用搜索高亮:dispatch effect 重算 decoration,然后跳转/选中第一处匹配。
/// query 为空或过短会清掉高亮,跳转 no-op。
export function applySearchHighlight(query: string) {
  if (cmView) cmView.dispatch({ effects: setSearchEffect.of(query || '') });
  if (previewEl) {
    clearPreviewMarks(previewEl);
    if (query && query.length >= MIN_QUERY_LEN) markPreviewHits(previewEl, query);
  }
  if (!cmView || !query || query.length < MIN_QUERY_LEN) return;
  const doc = cmView.state.doc.toString();
  const i = doc.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return;
  cmView.dispatch({
    selection: { anchor: i, head: i + query.length },
    effects: EditorView.scrollIntoView(i, { y: 'center' }),
  });
}

/// 清掉所有搜索高亮(编辑器 + preview),恢复普通编辑态。
export function clearSearchHighlights() {
  if (cmView) cmView.dispatch({ effects: setSearchEffect.of('') });
  if (previewEl) clearPreviewMarks(previewEl);
}

function markPreviewHits(root: HTMLElement, query: string) {
  if (!query || query.length < MIN_QUERY_LEN) return;
  const needle = query.toLowerCase();
  // 先收集所有候选 textNode,避免边遍历边改 DOM 把 walker 搞乱
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const p = node.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      const tag = p.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE') return NodeFilter.FILTER_REJECT;
      if (p.classList.contains(PREVIEW_MARK_CLASS)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) nodes.push(n as Text);

  let hits = 0;
  for (const text of nodes) {
    if (hits >= MAX_HITS) break;
    const val = text.nodeValue ?? '';
    const lower = val.toLowerCase();
    let idx = lower.indexOf(needle);
    if (idx < 0) continue;
    const frag = document.createDocumentFragment();
    let last = 0;
    while (idx >= 0 && hits < MAX_HITS) {
      if (idx > last) frag.appendChild(document.createTextNode(val.slice(last, idx)));
      const mark = document.createElement('mark');
      mark.className = PREVIEW_MARK_CLASS;
      mark.textContent = val.slice(idx, idx + needle.length);
      frag.appendChild(mark);
      hits++;
      last = idx + needle.length;
      idx = lower.indexOf(needle, last);
    }
    if (last < val.length) frag.appendChild(document.createTextNode(val.slice(last)));
    text.parentNode?.replaceChild(frag, text);
  }
}

function clearPreviewMarks(root: HTMLElement) {
  const marks = root.querySelectorAll<HTMLElement>(`mark.${PREVIEW_MARK_CLASS}`);
  marks.forEach(m => {
    const parent = m.parentNode;
    if (!parent) return;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
  });
  // 合并相邻 textNode,免得后续 walker 拆得到处都是
  root.normalize();
}
