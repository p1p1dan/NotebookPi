// Decorate the existing note list cards with sync-status badges.
//
// note-list.ts renders each card as
//   <div class="note-card" data-note-id="<localId>">
//     <div class="note-title">…</div>
//     <div class="note-excerpt">…</div>
//   </div>
// We attach a small <span class="note-sync-badge"> inside .note-title. If the
// structure changes in the future this no-ops gracefully.

import type { SyncStatusReport, NoteLite } from '../types';

let cache = new Map<number, NoteLite['sync_status']>();

export function setBadgeCache(notes: NoteLite[]) {
  cache = new Map(notes.map(n => [n.id, n.sync_status]));
}

export function renderSyncBadgesIntoNoteList(_r: SyncStatusReport) {
  const list = document.querySelector('.col-notes');
  if (!list) return;
  const cards = list.querySelectorAll<HTMLElement>('[data-note-id]');
  cards.forEach(card => {
    const id = Number(card.dataset.noteId);
    if (!id) return;
    const status = cache.get(id);
    let badge = card.querySelector<HTMLSpanElement>('.note-sync-badge');
    if (!status || status === 'synced') {
      badge?.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement('span');
      badge.className = `note-sync-badge ${status}`;
      const titleEl = card.querySelector<HTMLElement>('.note-title') ?? card;
      titleEl.appendChild(badge);
    }
    badge.className = `note-sync-badge ${status}`;
    badge.textContent = labelFor(status);
  });
}

function labelFor(s: string): string {
  switch (s) {
    case 'pending_create': return '待新建';
    case 'pending_update': return '待保存';
    case 'pending_delete': return '待删除';
    case 'sync_failed':    return '失败';
    case 'conflict':       return '冲突';
    default:               return '';
  }
}
