// App shell: topbar + 3-column layout. Owns initial data load and search wiring.

import { state, emit, on, setTheme, setMobilePane } from './state';
import { api } from '../api';
import { icons } from '../icons';
import { debounce } from '../util';
import { mountFolderTree } from './folder-tree';
import { mountNoteList } from './note-list';
import { mountEditor } from './editor';
import { mountImportUI } from './import-ui';
import { toast } from './toast';

export async function renderApp(root: HTMLElement) {
  document.documentElement.dataset.theme = state.theme;

  root.innerHTML = `
    <div class="scene-app" style="height:100%;display:flex;flex-direction:column">
      <header class="topbar">
        <button class="btn-icon topbar-back is-hidden" id="topbar-back" title="返回">${icons.arrowLeft}</button>
        <div class="topbar-brand flex items-center gap-2" style="width:220px">
          <div style="width:22px;height:22px;border-radius:5px;background:var(--accent);color:#fff;display:grid;place-items:center;font-family:'Lora',serif;font-weight:600;font-size:13px">N</div>
          <span class="font-semibold" style="color:var(--fg)">Notebook</span>
        </div>
        <div class="flex-1" style="max-width:520px;min-width:0">
          <div class="relative">
            <span style="position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--muted-fg);display:inline-flex">${icons.search}</span>
            <input id="search-input" class="input" placeholder="搜索笔记..." style="padding-left:30px;padding-right:30px" />
            <button id="search-clear" class="btn-icon" style="position:absolute;right:2px;top:50%;transform:translateY(-50%);width:26px;height:26px;display:none" title="清空">
              <svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
            </button>
          </div>
        </div>
        <div class="flex items-center gap-1">
          <button class="btn-icon" id="theme-toggle" title="切换主题"></button>
          <button class="btn-icon" id="logout-btn" title="登出">${icons.logout}</button>
        </div>
      </header>
      <div class="main-row" data-mobile-pane="${state.mobilePane}">
        <aside class="col-folders"   id="col-folders"></aside>
        <section class="col-notes"   id="col-notes"></section>
        <main class="col-editor"     id="col-editor"></main>
      </div>
    </div>
  `;

  const themeBtn  = root.querySelector<HTMLButtonElement>('#theme-toggle')!;
  const logoutBtn = root.querySelector<HTMLButtonElement>('#logout-btn')!;
  const renderThemeIcon = () => {
    themeBtn.innerHTML = state.theme === 'dark' ? icons.sun : icons.moon;
  };
  renderThemeIcon();
  on('theme', renderThemeIcon);
  themeBtn.addEventListener('click', () => {
    setTheme(state.theme === 'dark' ? 'light' : 'dark');
  });
  logoutBtn.addEventListener('click', async () => {
    if (!confirm('确定登出？')) return;
    try { await api.logout(); } catch { /* ignore */ }
    location.reload();
  });

  // Mobile back arrow: editor → notes → folders
  const backBtn = root.querySelector<HTMLButtonElement>('#topbar-back')!;
  backBtn.addEventListener('click', () => {
    if (state.mobilePane === 'editor') setMobilePane('notes');
    else if (state.mobilePane === 'notes') setMobilePane('folders');
  });
  // Sync initial back visibility
  setMobilePane(state.mobilePane);

  // -------- Search wiring (with IME guard) --------
  const searchInput = root.querySelector<HTMLInputElement>('#search-input')!;
  const searchClear = root.querySelector<HTMLButtonElement>('#search-clear')!;
  let composing = false;
  searchInput.addEventListener('compositionstart', () => { composing = true; });
  searchInput.addEventListener('compositionend',   () => { composing = false; handleInput(); });

  const runSearch = debounce(async (q: string) => {
    if (state.searchQuery !== q) return;
    if (!q) {
      state.searchResults = [];
      state.searchLoading = false;
      emit('notes');
      return;
    }
    state.searchLoading = true;
    emit('notes');
    try {
      const { results } = await api.search(q);
      if (state.searchQuery !== q) return; // stale response
      state.searchResults = results;
    } catch {
      state.searchResults = [];
      toast('搜索失败', 'error');
    } finally {
      state.searchLoading = false;
      emit('notes');
    }
  }, 250);

  function handleInput() {
    if (composing) return;
    const q = searchInput.value.trim();
    state.searchQuery = q;
    searchClear.style.display = q ? 'inline-flex' : 'none';
    runSearch(q);
  }
  searchInput.addEventListener('input', handleInput);
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { searchInput.value = ''; handleInput(); searchInput.blur(); }
  });
  searchClear.addEventListener('click', () => {
    searchInput.value = ''; handleInput(); searchInput.focus();
  });

  // Ctrl/Cmd+K to focus search
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    }
  });

  // Mount columns
  mountFolderTree(root.querySelector<HTMLElement>('#col-folders')!);
  mountNoteList(root.querySelector<HTMLElement>('#col-notes')!);
  mountEditor(root.querySelector<HTMLElement>('#col-editor')!);
  mountImportUI();

  // Initial data load
  try {
    const { folders } = await api.listFolders();
    state.folders = folders;
    emit('folders');
    const { notes } = await api.listNotes(state.selectedFolderId);
    state.notes = notes;
    emit('notes');
  } catch (e) {
    console.error(e);
    toast('加载失败，请刷新重试', 'error', 4000);
  }
}
