// Small utilities — no deps.

export function debounce<T extends (...args: any[]) => void>(fn: T, ms: number): T & { flush: () => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: any[] | null = null;
  const wrapped = ((...args: any[]) => {
    lastArgs = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, ms);
  }) as any;
  wrapped.flush = () => { if (timer && lastArgs) { clearTimeout(timer); timer = null; fn(...lastArgs); } };
  wrapped.cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  return wrapped;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function timeAgo(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  const m = 60_000, h = 3_600_000, d = 86_400_000;
  if (diff < m)        return '刚刚';
  if (diff < h)        return `${Math.floor(diff / m)} 分钟前`;
  if (diff < d) {
    const date = new Date(ts);
    const today = new Date();
    if (date.toDateString() === today.toDateString())
      return `今天 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    return `${Math.floor(diff / h)} 小时前`;
  }
  if (diff < 2 * d) {
    const date = new Date(ts);
    return `昨天 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  if (diff < 7 * d)    return `${Math.floor(diff / d)} 天前`;
  const date = new Date(ts);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return sameYear
    ? `${pad(date.getMonth() + 1)}.${pad(date.getDate())}`
    : `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`;
}
const pad = (n: number) => String(n).padStart(2, '0');

export function makeExcerpt(content: string, max = 120): string {
  // strip markdown chrome cheaply; not perfect, fine for a sidebar excerpt.
  const stripped = content
    .replace(/^#+\s+/gm, '')
    .replace(/[*_`>#\-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (stripped.length <= max) return stripped;
  return stripped.slice(0, max) + '…';
}

export function wordCount(s: string): number {
  // Mix of CJK + western: CJK chars count 1 each, runs of word chars count 1.
  const cjk = (s.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const western = (s.match(/\b[a-zA-Z0-9]+\b/g) || []).length;
  return cjk + western;
}
