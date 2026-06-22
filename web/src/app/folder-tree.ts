// Left column: folder tree with root + per-folder hover actions.

import { state, emit, on } from './state';
import { setMobilePane } from './state';
import { api, ApiError } from '../api';
import { icons } from '../icons';
import { escapeHtml } from '../util';
import { toast } from './toast';
import type { Folder, FolderId } from '../types';

export function mountFolderTree(root: HTMLElement) {
  const render = () => root.innerHTML = build();
  render();
  on('folders', render);
  on('notes',   render);  // re-render to keep "selected" highlight after note operations

  // Single delegated click handler.
  root.addEventListener('click', async (e) => {
    const t = e.target as HTMLElement;
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
  return `
    <div class="tree-section-title">
      <span>位置</span>
    </div>
    <div class="tree-item ${state.selectedFolderId === 'all' ? 'is-active' : ''}" data-select="all">
      ${icons.inbox}<span>全部笔记</span>
    </div>
    <div class="tree-item ${state.selectedFolderId === null ? 'is-active' : ''}" data-select="root">
      ${icons.folder}<span>未归类</span>
    </div>

    <div class="tree-section-title">
      <span>文件夹</span>
      <button class="btn-icon" data-action="new-root" title="新建根文件夹">${icons.plusSm}</button>
    </div>
    ${tree.length === 0
      ? `<div class="tree-empty">还没有文件夹<br/><button class="btn btn-sm" style="margin-top:8px" data-action="new-root">新建文件夹</button></div>`
      : tree.map(n => renderNode(n, 0)).join('')}
  `;
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
  return `
    <div class="tree-item ${active ? 'is-active' : ''}" data-select="${f.id}" style="padding-left:${pad}px">
      ${icons.folder}
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(f.name)}</span>
      <span class="count">${f.note_count ?? 0}</span>
      <span class="actions">
        <button class="btn-icon" data-action="new-child" data-id="${f.id}" title="新建子文件夹">${icons.plusSm}</button>
        <button class="btn-icon" data-action="rename"    data-id="${f.id}" title="重命名">${icons.pencil}</button>
        <button class="btn-icon danger" data-action="delete" data-id="${f.id}" title="删除">${icons.trash}</button>
      </span>
    </div>
    ${node.children.map(c => renderNode(c, depth + 1)).join('')}
  `;
}

// ---------- Actions ----------

async function selectFolder(id: FolderId) {
  if (state.selectedFolderId === id) {
    setMobilePane('notes');  // re-tap to drill in on mobile
    return;
  }
  state.selectedFolderId = id;
  state.selectedNoteId = null;
  state.currentNote = null;
  emit('currentNote');
  try {
    const { notes } = await api.listNotes(id);
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
    emit('folders');
    selectFolder(folder.id);
  } catch (e) {
    if (e instanceof ApiError && e.code === 'name_conflict') return toast('同级已有同名文件夹', 'error');
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
