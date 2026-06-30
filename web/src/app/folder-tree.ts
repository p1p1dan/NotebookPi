// Left column: folder tree with collapsible sections and per-folder hover actions.
//
// 老王注：以前的折叠完全没有,根节点全展开看着憋屈。现在两个 section
// 标题可点击折叠;每个有子节点的文件夹也带展开/收起箭头,状态存 localStorage。

import { state, emit, on } from './state';
import { setMobilePane } from './state';
import { api, ApiError } from '../api';
import { icons } from '../icons';
import { escapeHtml } from '../util';
import { toast } from './toast';
import type { Folder, FolderId } from '../types';

// ---------- Persistent collapse state ----------
const SECTION_KEY = 'tree.section.collapsed';
const FOLDER_KEY = 'tree.folder.collapsed';

interface CollapseState {
  sections: Record<string, boolean>;   // 'locations' | 'folders' -> collapsed?
  folders: Record<number, boolean>;    // folder.id -> collapsed?
}

function loadCollapse(): CollapseState {
  try {
    const sections = JSON.parse(localStorage.getItem(SECTION_KEY) || '{}');
    const folders = JSON.parse(localStorage.getItem(FOLDER_KEY) || '{}');
    return { sections, folders };
  } catch { return { sections: {}, folders: {} }; }
}

const collapse = loadCollapse();

function saveCollapse() {
  localStorage.setItem(SECTION_KEY, JSON.stringify(collapse.sections));
  localStorage.setItem(FOLDER_KEY, JSON.stringify(collapse.folders));
}

function toggleSection(key: string) {
  collapse.sections[key] = !collapse.sections[key];
  saveCollapse();
}

function toggleFolder(id: number) {
  collapse.folders[id] = !collapse.folders[id];
  saveCollapse();
}

// ---------- Mount ----------

export function mountFolderTree(root: HTMLElement) {
  const render = () => root.innerHTML = build();
  render();
  on('folders', render);
  on('notes',   render);  // 保持 active 高亮在笔记变化后正确

  root.addEventListener('click', async (e) => {
    const t = e.target as HTMLElement;

    // 折叠 section
    const section = t.closest<HTMLElement>('[data-toggle-section]');
    if (section && !t.closest('[data-action]')) {
      toggleSection(section.dataset.toggleSection!);
      render();
      return;
    }

    // 折叠某个文件夹
    const fchev = t.closest<HTMLElement>('[data-toggle-folder]');
    if (fchev) {
      e.stopPropagation();
      toggleFolder(Number(fchev.dataset.toggleFolder));
      render();
      return;
    }

    const action = t.closest<HTMLElement>('[data-action]');
    if (action) {
      e.stopPropagation();
      const op = action.dataset.action!;
      const id = action.dataset.id ? Number(action.dataset.id) : null;
      if (op === 'new-root')   return await newFolder(null);
      if (op === 'new-child')  return await newFolder(id);
      if (op === 'rename')     return await renameFolder(id!);
      if (op === 'delete')     return await deleteFolder(id!);
    }
    const node = t.closest<HTMLElement>('[data-select]');
    if (node) {
      const sel = node.dataset.select!;
      selectFolder(sel === 'all' ? 'all' : sel === 'root' ? null : Number(sel));
    }
  });
}

// ---------- Render ----------

function build(): string {
  const tree = buildTree(state.folders);
  const locCollapsed = !!collapse.sections.locations;
  const foldCollapsed = !!collapse.sections.folders;
  return `
    <div class="tree-section-title is-toggle" data-toggle-section="locations">
      ${chev(locCollapsed)}<span>位置</span>
    </div>
    ${locCollapsed ? '' : `
      <div class="tree-item ${state.selectedFolderId === 'all' ? 'is-active' : ''}" data-select="all" data-folder-id="all">
        ${icons.inbox}<span>全部笔记</span>
      </div>
      <div class="tree-item ${state.selectedFolderId === null ? 'is-active' : ''}" data-select="root" data-folder-id="null">
        ${icons.folder}<span>未归类</span>
      </div>
    `}

    <div class="tree-section-title is-toggle" data-toggle-section="folders">
      ${chev(foldCollapsed)}<span>文件夹</span>
      <button class="btn-icon" data-action="new-root" title="新建根文件夹">${icons.plusSm}</button>
    </div>
    ${foldCollapsed ? '' : (tree.length === 0
      ? `<div class="tree-empty">还没有文件夹<br/><button class="btn btn-sm" style="margin-top:8px" data-action="new-root">新建文件夹</button></div>`
      : tree.map(n => renderNode(n, 0)).join(''))}
  `;
}

function chev(collapsed: boolean): string {
  // 14px 行内箭头,纯 SVG 不引图标库
  return `<span class="tree-chev ${collapsed ? 'is-collapsed' : ''}" style="display:inline-flex;width:14px;height:14px;margin-right:2px;color:var(--muted-fg);transition:transform .15s"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></span>`;
}

interface Node { folder: Folder; children: Node[]; }
function buildTree(folders: Folder[]): Node[] {
  const map = new Map<number, Node>();
  folders.forEach(f => map.set(f.id, { folder: f, children: [] }));
  const roots: Node[] = [];
  folders.forEach(f => {
    const node = map.get(f.id)!;
    if (f.parent_id != null && map.has(f.parent_id)) {
      map.get(f.parent_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  });
  return roots;
}

function renderNode(node: Node, depth: number): string {
  const f = node.folder;
  const active = state.selectedFolderId === f.id;
  const pad = 8 + depth * 14;
  const hasChildren = node.children.length > 0;
  const isCollapsed = !!collapse.folders[f.id];
  // 有子节点才显示箭头,没子节点用占位保持对齐
  const chevHtml = hasChildren
    ? `<span class="tree-chev ${isCollapsed ? 'is-collapsed' : ''}" data-toggle-folder="${f.id}" style="display:inline-flex;width:14px;height:14px;cursor:pointer;color:var(--muted-fg);transform:${isCollapsed ? 'rotate(-90deg)' : 'none'};transition:transform .15s"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></span>`
    : `<span style="display:inline-block;width:14px"></span>`;
  return `
    <div class="tree-item ${active ? 'is-active' : ''}" data-select="${f.id}" data-folder-id="${f.id}" style="padding-left:${pad}px">
      ${chevHtml}
      ${icons.folder}
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(f.name)}</span>
      <span class="count">${f.note_count ?? 0}</span>
      <span class="actions">
        <button class="btn-icon" data-action="new-child" data-id="${f.id}" title="新建子文件夹">${icons.plusSm}</button>
        <button class="btn-icon" data-action="rename"    data-id="${f.id}" title="重命名">${icons.pencil}</button>
        <button class="btn-icon danger" data-action="delete" data-id="${f.id}" title="删除">${icons.trash}</button>
      </span>
    </div>
    ${hasChildren && !isCollapsed ? node.children.map(c => renderNode(c, depth + 1)).join('') : ''}
  `;
}

// ---------- Actions ----------

async function selectFolder(id: FolderId) {
  if (state.selectedFolderId === id) {
    setMobilePane('notes');
    return;
  }
  state.selectedFolderId = id;
  state.selectedNoteId = null;
  state.currentNote = null;
  emit('currentNote');
  // 立即触发左栏 re-render 标记 active,不等 listNotes 回来
  emit('folders');
  try {
    const { notes } = await api.listNotes(id);
    // 防 race:用户可能在请求飞行期间又点了别的文件夹
    if (state.selectedFolderId !== id) return;
    state.notes = notes;
    emit('notes');
    setMobilePane('notes');
  } catch {
    toast('加载笔记失败', 'error');
  }
}

async function newFolder(parent_id: number | null) {
  const name = prompt('文件夹名称');
  if (!name || !name.trim()) return;
  try {
    const { folder } = await api.createFolder(parent_id, name.trim());
    state.folders.push(folder);
    // 父节点强制展开,新建的子文件夹立马可见
    if (parent_id != null) {
      collapse.folders[parent_id] = false;
      saveCollapse();
    }
    emit('folders');
    selectFolder(folder.id);
  } catch (e) {
    if (e instanceof ApiError && e.code === 'name_conflict') return toast('同级已有同名文件夹', 'error');
    if (e instanceof ApiError && e.code === 'createFolder is not available in desktop runtime') return toast('桌面端暂不支持新建文件夹,请用浏览器', 'error');
    // 兜底:错误信息里有 not available 也按桌面端不支持处理
    const msg = (e as any)?.message || '';
    if (msg.includes('not available in desktop')) return toast('桌面端暂不支持新建文件夹', 'error');
    toast('新建失败', 'error');
  }
}

async function renameFolder(id: number) {
  const f = state.folders.find(x => x.id === id);
  if (!f) return;
  const name = prompt('重命名', f.name);
  if (!name || !name.trim() || name === f.name) return;
  try {
    const { folder } = await api.renameFolder(id, name.trim());
    Object.assign(f, folder);
    emit('folders');
  } catch (e) {
    if (e instanceof ApiError && e.code === 'name_conflict') return toast('同级已有同名文件夹', 'error');
    toast('重命名失败', 'error');
  }
}

async function deleteFolder(id: number) {
  const f = state.folders.find(x => x.id === id);
  if (!f) return;
  if (!confirm(`删除文件夹 "${f.name}"？\n子文件夹会被一起删除，文件夹里的笔记会移动到"未归类"。`)) return;
  try {
    await api.deleteFolder(id);
    state.folders = state.folders.filter(x => x.id !== id && !isDescendant(x.id, id, state.folders));
    emit('folders');
    if (state.selectedFolderId === id) selectFolder('all');
  } catch {
    toast('删除失败', 'error');
  }
}

function isDescendant(target: number, ancestor: number, folders: Folder[]): boolean {
  let cur = folders.find(f => f.id === target)?.parent_id;
  while (cur != null) {
    if (cur === ancestor) return true;
    cur = folders.find(f => f.id === cur)?.parent_id ?? null;
  }
  return false;
}
