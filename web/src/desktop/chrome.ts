// Desktop chrome: a thin status bar pinned to the top-right of the app shell,
// plus a slide-in settings drawer. Keeps the existing UI 100% intact and
// degrades silently when the corresponding DOM hooks are missing.

import {
  syncStatus,
  syncNow,
  retryFailed,
  getSettings,
  setSettings,
  saveToken,
  clearToken,
  showQuickNote,
} from './tauri-api';
import { listen } from '@tauri-apps/api/event';
import type { SyncStatusReport, DesktopSettings } from '../types';
import { renderSyncBadgesIntoNoteList, setBadgeCache } from './sync-badge';
import { api } from '../api';
import { state, emit } from '../app/state';

const POLL_MS = 3000;

let lastReport: SyncStatusReport | null = null;
let pillEl: HTMLDivElement | null = null;

export function mountDesktopChrome() {
  injectStyles();
  mountStatusPill();
  // Refresh badges on each list re-render: the existing app emits 'notes' on
  // every update, but it lives behind module state. The simplest hook is a
  // periodic re-decoration; cheap because it only walks visible <li> nodes.
  setInterval(() => {
    if (lastReport) renderSyncBadgesIntoNoteList(lastReport);
  }, 800);
  void poll();
  setInterval(() => void poll(), POLL_MS);

  // Listen for changes that originate outside the main window
  // (quick-note creates, sync loop pulls, queue drains). Force the existing
  // app shell to re-fetch its lists via the same channels it uses internally.
  void listen<unknown>('notebookpi://notes-changed', () => {
    void refreshAppLists();
  });
}

async function refreshAppLists() {
  // 艹，这里以前从 DOM 读 data-folder-id（folder-tree 根本没设这属性），
  // 永远 fallback 到 'all'，把用户刚选的文件夹覆盖回全部笔记。改成直接读 state。
  try {
    const { folders } = await api.listFolders();
    const { notes } = await api.listNotes(state.selectedFolderId);
    setBadgeCache(notes);
    // 直接改 state 再 emit，比 dispatch CustomEvent 干净，避免覆盖编辑中状态。
    state.folders = folders as typeof state.folders;
    state.notes = notes as typeof state.notes;
    // 更新对应 folder 的 note_count（pull 回来的可能已变化）
    emit('folders');
    emit('notes');
  } catch (e) {
    console.warn('refreshAppLists failed', e);
  }
}

async function poll() {
  try {
    lastReport = await syncStatus();
    renderPill(lastReport);
    // Refresh badge cache from the persistent SQLite view, then redraw.
    try {
      const { notes } = await api.listNotes('all');
      setBadgeCache(notes);
    } catch (e) {
      // listNotes may legitimately fail before the runtime adapter is ready.
      console.warn('badge cache refresh skipped', e);
    }
    renderSyncBadgesIntoNoteList(lastReport);
  } catch (e) {
    console.warn('sync status failed', e);
  }
}

function mountStatusPill() {
  pillEl = document.createElement('div');
  pillEl.className = 'desktop-pill';
  pillEl.innerHTML = `
    <button class="dp-btn" id="dp-status" title="同步状态"></button>
    <button class="dp-btn" id="dp-quick"  title="新建快速记录 (Ctrl+Alt+N)">⚡ 快记</button>
    <button class="dp-btn" id="dp-settings" title="设置">⚙</button>
  `;
  document.body.appendChild(pillEl);

  pillEl.querySelector('#dp-status')!.addEventListener('click', async () => {
    try {
      lastReport = await syncNow();
      renderPill(lastReport);
    } catch (e) { console.warn(e); }
  });
  pillEl.querySelector('#dp-quick')!.addEventListener('click', () => {
    void showQuickNote();
  });
  pillEl.querySelector('#dp-settings')!.addEventListener('click', () => {
    void openSettings();
  });
}

function renderPill(r: SyncStatusReport) {
  if (!pillEl) return;
  const btn = pillEl.querySelector<HTMLButtonElement>('#dp-status')!;
  const cls =
    !r.configured ? 'is-unconfigured'
    : !r.online ? 'is-offline'
    : r.failed > 0 ? 'is-failed'
    : r.pending > 0 ? 'is-pending'
    : 'is-synced';
  btn.className = `dp-btn ${cls}`;
  const last = r.last_sync_at
    ? new Date(r.last_sync_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '从未';
  const dot =
    cls === 'is-synced' ? '●'
    : cls === 'is-pending' ? '◐'
    : cls === 'is-failed' ? '!'
    : cls === 'is-offline' ? '○'
    : '?';
  let label = '已同步';
  if (cls === 'is-unconfigured') label = '未配置';
  else if (cls === 'is-offline') label = '离线';
  else if (cls === 'is-failed') label = `失败 ${r.failed}`;
  else if (cls === 'is-pending') label = `待同步 ${r.pending}`;
  btn.textContent = `${dot} ${label} · ${last}`;
}

// ---------------- settings drawer ----------------

let drawerEl: HTMLDivElement | null = null;

async function openSettings() {
  if (drawerEl) {
    drawerEl.classList.add('open');
    return;
  }
  drawerEl = document.createElement('div');
  drawerEl.className = 'desktop-drawer open';
  drawerEl.innerHTML = `
    <div class="dd-mask"></div>
    <div class="dd-panel">
      <header class="dd-head">
        <h3>桌面设置</h3>
        <button class="dd-close" title="关闭">✕</button>
      </header>
      <form class="dd-form">
        <label>服务器地址
          <input type="url" name="server_url" placeholder="http://your-server:8454" autocomplete="off" />
        </label>
        <label>API Token <span class="dd-token-state"></span>
          <input type="password" name="token" placeholder="留空保持现有 / 输入以更新" autocomplete="off" />
        </label>
        <label>默认快记文件夹
          <input type="text" name="quick_folder_path" placeholder="随笔记录/快速记录" />
        </label>
        <label class="dd-row"><input type="checkbox" name="close_to_tray"/> 关闭主窗口时隐藏到托盘</label>
        <label class="dd-row"><input type="checkbox" name="autostart"/> 开机自启</label>
        <label class="dd-row"><input type="checkbox" name="quick_note_clear_on_save"/> 快记保存后清空</label>
        <label class="dd-row"><input type="checkbox" name="quick_note_close_on_save"/> 快记保存后关闭窗口</label>
        <div class="dd-actions">
          <button type="button" class="dd-clear-token">清除 Token</button>
          <button type="button" class="dd-retry">重试失败 ${'\u21bb'}</button>
          <button type="submit" class="dd-save">保存</button>
        </div>
        <p class="dd-hint">服务器需启用 API_TOKEN（在 .env 设 <code>API_TOKEN</code> ≥ 16 字符）。</p>
      </form>
    </div>
  `;
  document.body.appendChild(drawerEl);

  drawerEl.querySelector('.dd-mask')!.addEventListener('click', closeDrawer);
  drawerEl.querySelector('.dd-close')!.addEventListener('click', closeDrawer);
  drawerEl.querySelector('.dd-clear-token')!.addEventListener('click', async () => {
    await clearToken();
    void hydrateSettings();
  });
  drawerEl.querySelector('.dd-retry')!.addEventListener('click', async () => {
    try {
      lastReport = await retryFailed();
      renderPill(lastReport);
    } catch (e) { console.warn(e); }
  });
  drawerEl.querySelector('form')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target as HTMLFormElement);
    const next: DesktopSettings = {
      server_url: String(fd.get('server_url') ?? '').trim(),
      has_token: false,
      quick_folder_path: String(fd.get('quick_folder_path') ?? '').trim() || '随笔记录/快速记录',
      close_to_tray: fd.get('close_to_tray') === 'on',
      autostart: fd.get('autostart') === 'on',
      quick_note_clear_on_save: fd.get('quick_note_clear_on_save') === 'on',
      quick_note_close_on_save: fd.get('quick_note_close_on_save') === 'on',
    };
    await setSettings(next);
    const tokenInput = String(fd.get('token') ?? '').trim();
    if (tokenInput) await saveToken(tokenInput);
    closeDrawer();
    try {
      lastReport = await syncNow();
      renderPill(lastReport);
    } catch (e) { console.warn(e); }
  });

  void hydrateSettings();
}

async function hydrateSettings() {
  if (!drawerEl) return;
  const s = await getSettings();
  const f = drawerEl.querySelector<HTMLFormElement>('form')!;
  (f.elements.namedItem('server_url') as HTMLInputElement).value = s.server_url;
  (f.elements.namedItem('quick_folder_path') as HTMLInputElement).value = s.quick_folder_path;
  (f.elements.namedItem('close_to_tray') as HTMLInputElement).checked = s.close_to_tray;
  (f.elements.namedItem('autostart') as HTMLInputElement).checked = s.autostart;
  (f.elements.namedItem('quick_note_clear_on_save') as HTMLInputElement).checked = s.quick_note_clear_on_save;
  (f.elements.namedItem('quick_note_close_on_save') as HTMLInputElement).checked = s.quick_note_close_on_save;
  drawerEl.querySelector<HTMLSpanElement>('.dd-token-state')!.textContent =
    s.has_token ? '· 已配置' : '· 未配置';
}

function closeDrawer() {
  if (!drawerEl) return;
  drawerEl.classList.remove('open');
  setTimeout(() => {
    drawerEl?.remove();
    drawerEl = null;
  }, 180);
}

// ---------------- styles ----------------

function injectStyles() {
  const css = `
    .desktop-pill {
      position: fixed; top: 8px; right: 12px; z-index: 9999;
      display: flex; gap: 6px; align-items: center; pointer-events: auto;
    }
    .desktop-pill .dp-btn {
      font: 500 12px/1 system-ui, sans-serif;
      padding: 6px 10px; border-radius: 999px; border: 1px solid var(--border, #ddd);
      background: var(--bg, #fff); color: var(--fg, #222); cursor: pointer;
      box-shadow: 0 1px 2px rgba(0,0,0,.04);
    }
    .desktop-pill .dp-btn.is-synced  { color: #1f8b4c; border-color: #b6e0c5; }
    .desktop-pill .dp-btn.is-pending { color: #b56b00; border-color: #f0d28a; }
    .desktop-pill .dp-btn.is-failed  { color: #c0392b; border-color: #f3b2ac; background: #fff7f6; }
    .desktop-pill .dp-btn.is-offline { color: #555; border-color: #ddd; }
    .desktop-pill .dp-btn.is-unconfigured { color: #555; border-style: dashed; }
    .note-sync-badge {
      display: inline-block; padding: 1px 6px; margin-left: 6px;
      font-size: 10px; line-height: 14px; border-radius: 999px;
      vertical-align: middle;
    }
    .note-sync-badge.pending_create { background:#fff4d6; color:#a06200; }
    .note-sync-badge.pending_update { background:#fff4d6; color:#a06200; }
    .note-sync-badge.pending_delete { background:#fde2e2; color:#a02020; }
    .note-sync-badge.sync_failed    { background:#fde2e2; color:#a02020; }
    .note-sync-badge.conflict       { background:#fbe4ff; color:#7d2db8; }
    .desktop-drawer {
      position: fixed; inset: 0; z-index: 10000; pointer-events: none;
    }
    .desktop-drawer .dd-mask {
      position: absolute; inset: 0; background: rgba(0,0,0,.18);
      opacity: 0; transition: opacity .18s; pointer-events: auto;
    }
    .desktop-drawer.open .dd-mask { opacity: 1; }
    .desktop-drawer .dd-panel {
      position: absolute; top: 0; right: 0; bottom: 0; width: 360px;
      background: var(--panel, #fff); color: var(--fg, #222);
      border-left: 1px solid var(--border, #ddd); transform: translateX(100%);
      transition: transform .18s ease-out; pointer-events: auto;
      display: flex; flex-direction: column;
    }
    .desktop-drawer.open .dd-panel { transform: translateX(0); }
    .desktop-drawer .dd-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 12px 16px; border-bottom: 1px solid var(--border, #eee);
    }
    .desktop-drawer .dd-head h3 { margin: 0; font-size: 14px; }
    .desktop-drawer .dd-close {
      background: transparent; border: 0; cursor: pointer; font-size: 16px;
    }
    .desktop-drawer .dd-form { display: flex; flex-direction: column; gap: 10px; padding: 16px; overflow: auto; }
    .desktop-drawer .dd-form label { font-size: 12px; color: var(--muted-fg, #555); display: flex; flex-direction: column; gap: 4px; }
    .desktop-drawer .dd-form .dd-row { flex-direction: row; align-items: center; gap: 8px; color: var(--fg, #222); }
    .desktop-drawer .dd-form input[type=url],
    .desktop-drawer .dd-form input[type=text],
    .desktop-drawer .dd-form input[type=password] {
      padding: 6px 8px; border: 1px solid var(--border, #ddd); border-radius: 6px; font: inherit;
    }
    .desktop-drawer .dd-actions { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
    .desktop-drawer .dd-actions button { padding: 6px 12px; border-radius: 6px; border: 1px solid var(--border, #ddd); background: var(--bg, #fff); cursor: pointer; }
    .desktop-drawer .dd-actions .dd-save { background: var(--accent, #d97706); color: #fff; border-color: transparent; }
    .desktop-drawer .dd-hint { font-size: 11px; color: var(--muted-fg, #888); margin: 4px 0 0; }
    .desktop-drawer .dd-token-state { color: var(--muted-fg, #888); font-weight: normal; }
  `;
  const tag = document.createElement('style');
  tag.textContent = css;
  document.head.appendChild(tag);
}
