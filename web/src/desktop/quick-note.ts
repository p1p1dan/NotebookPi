// Quick-note popup window.
//
// Loaded by Tauri via web/quick-note.html. We avoid importing the heavy app
// shell here — the goal is a near-instant popup focused on capture.
//
// Behavior:
//   Title is optional. If empty on save, we use the first non-empty line of
//   the body, or fall back to a timestamp.
//   Ctrl+Enter saves. Esc hides the window (so the next Ctrl+Alt+N is fast).
//   On save we hand the note to Rust as { folder_path, title, content }; the
//   sync engine takes it from there.

import '../styles/global.css';
import {
  createNoteByPath,
  getSettings,
  hideQuickNote,
} from './tauri-api';

const DEFAULT_FOLDER = '随笔记录/快速记录';

interface QuickPrefs {
  folder: string;
  clearOnSave: boolean;
  closeOnSave: boolean;
}

let prefs: QuickPrefs = {
  folder: DEFAULT_FOLDER,
  clearOnSave: true,
  closeOnSave: false,
};

const root = document.getElementById('quick-root')!;
root.innerHTML = `
  <div class="qn-shell">
    <header class="qn-head">
      <input id="qn-title" placeholder="标题（可空，自动从首行/时间生成）" autocomplete="off" />
      <span class="qn-folder" id="qn-folder"></span>
    </header>
    <textarea id="qn-body" placeholder="开始写点什么…"></textarea>
    <footer class="qn-foot">
      <span class="qn-hint">Ctrl+Enter 保存 · Esc 隐藏</span>
      <span class="qn-status" id="qn-status"></span>
      <button id="qn-save">保存</button>
    </footer>
  </div>
`;

injectStyles();

const titleEl = document.getElementById('qn-title') as HTMLInputElement;
const bodyEl  = document.getElementById('qn-body') as HTMLTextAreaElement;
const folderLabel = document.getElementById('qn-folder') as HTMLSpanElement;
const statusEl = document.getElementById('qn-status') as HTMLSpanElement;
const saveBtn = document.getElementById('qn-save') as HTMLButtonElement;

void hydrate();

window.addEventListener('focus', () => bodyEl.focus());

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    void save();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    void hideQuickNote();
  }
});

saveBtn.addEventListener('click', () => void save());

async function hydrate() {
  try {
    const s = await getSettings();
    prefs = {
      folder: (s.quick_folder_path || DEFAULT_FOLDER).trim(),
      clearOnSave: s.quick_note_clear_on_save,
      closeOnSave: s.quick_note_close_on_save,
    };
    folderLabel.textContent = `→ ${prefs.folder}`;
  } catch (e) {
    console.warn('hydrate quick-note prefs failed', e);
    folderLabel.textContent = `→ ${prefs.folder}`;
  }
  bodyEl.focus();
}

async function save() {
  const body = bodyEl.value.trim();
  if (!body) {
    setStatus('内容为空');
    bodyEl.focus();
    return;
  }
  const title = computeTitle(titleEl.value, body);
  saveBtn.disabled = true;
  setStatus('保存中…');
  try {
    await createNoteByPath(prefs.folder, title, bodyEl.value, 'txt');
    setStatus('已入队');
    if (prefs.clearOnSave) {
      titleEl.value = '';
      bodyEl.value = '';
      bodyEl.focus();
    }
    if (prefs.closeOnSave) {
      void hideQuickNote();
    }
  } catch (e) {
    console.error(e);
    setStatus('保存失败');
  } finally {
    saveBtn.disabled = false;
    setTimeout(() => setStatus(''), 1500);
  }
}

function computeTitle(raw: string, body: string): string {
  const t = raw.trim();
  if (t) return t;
  const firstLine = body.split('\n').map(l => l.trim()).find(Boolean);
  if (firstLine) return firstLine.slice(0, 60);
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function setStatus(s: string) {
  statusEl.textContent = s;
}

function injectStyles() {
  const css = `
    html, body, #quick-root { height: 100%; margin: 0; }
    body { background: var(--bg, #fdfbf7); color: var(--fg, #222);
           font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
    .qn-shell { display: flex; flex-direction: column; height: 100%; padding: 8px 12px; gap: 6px; }
    .qn-head { display: flex; align-items: center; gap: 8px; }
    .qn-head input { flex: 1; border: 1px solid var(--border, #ddd); border-radius: 6px;
                     padding: 6px 8px; font: inherit; background: transparent; color: inherit; }
    .qn-folder { font-size: 11px; color: var(--muted-fg, #888); white-space: nowrap; }
    #qn-body { flex: 1; resize: none; border: 1px solid var(--border, #ddd); border-radius: 6px;
               padding: 8px 10px; font: inherit; background: transparent; color: inherit; outline: none; }
    .qn-foot { display: flex; align-items: center; gap: 8px; }
    .qn-hint { font-size: 11px; color: var(--muted-fg, #888); }
    .qn-status { font-size: 11px; color: var(--muted-fg, #888); margin-left: auto; }
    #qn-save { padding: 6px 12px; border-radius: 6px; border: 1px solid transparent;
               background: var(--accent, #d97706); color: #fff; cursor: pointer; }
    #qn-save:disabled { opacity: 0.6; cursor: progress; }
  `;
  const tag = document.createElement('style');
  tag.textContent = css;
  document.head.appendChild(tag);
}
