// Public read-only page for /s/:token. No auth, no app shell.

import './styles/global.css';
import { md } from './markdown';
import { escapeHtml } from './util';

const saved = localStorage.getItem('theme');
document.documentElement.dataset.theme =
  saved === 'dark' || saved === 'light' ? saved
  : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';

const root = document.getElementById('share-root')!;
const status = (msg: string) => { root.innerHTML = `<div class="share-status">${escapeHtml(msg)}</div>`; };

async function boot() {
  const token = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] ?? '');
  if (!token) return status('链接无效');
  const res = await fetch(`/api/public/shares/${encodeURIComponent(token)}`);
  if (res.status === 404) return status('链接不存在或已被撤销');
  if (!res.ok) return status('加载失败，请稍后重试');
  const { note } = await res.json() as {
    note: { title: string; format: 'txt' | 'md'; content: string; updated_at: number };
  };
  const title = note.title.trim() || '无标题';
  document.title = title;
  const body = note.format === 'md'
    ? `<article class="prose">${md.render(note.content)}</article>`
    : `<pre class="share-txt">${escapeHtml(note.content)}</pre>`;
  root.innerHTML = `
    <h1 class="share-title">${escapeHtml(title)}</h1>
    <div class="share-meta">更新于 ${new Date(note.updated_at).toLocaleString('zh-CN')}</div>
    ${body}
  `;
}

boot().catch(() => status('加载失败，请稍后重试'));
