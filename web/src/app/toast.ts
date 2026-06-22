// Tiny toast. Use for transient feedback (saved, error).

let stack: HTMLDivElement | null = null;
function getStack(): HTMLDivElement {
  if (stack) return stack;
  stack = document.createElement('div');
  stack.className = 'toast-stack';
  document.body.appendChild(stack);
  return stack;
}

export function toast(message: string, kind: 'info' | 'error' = 'info', ms = 2400) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'error' ? ' is-error' : '');
  el.textContent = message;
  getStack().appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity 200ms ease';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 220);
  }, ms);
}
