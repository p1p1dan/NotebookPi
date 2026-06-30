// App entry: install the right API adapter, check auth, render login or app.

import './styles/global.css';
import { api } from './api';
import { renderLogin } from './auth/login';
import { renderApp } from './app';
import { installRuntime } from './runtime';

async function boot() {
  const root = document.getElementById('app')!;
  // initial theme from localStorage (state.ts sets it too, but document attribute needs to be set ASAP)
  const t = (localStorage.getItem('theme') as 'light' | 'dark') || 'light';
  document.documentElement.dataset.theme = t;

  const { tauri } = await installRuntime();

  if (tauri) {
    // Desktop: skip password screen entirely. Auth is handled by Rust via Bearer token.
    document.body.dataset.runtime = 'tauri';
    await renderApp(root);

    // Lazy-load desktop chrome (settings entry + sync status badge) so it
    // doesn't bloat the browser bundle.
    const desktop = await import('./desktop/chrome');
    desktop.mountDesktopChrome();
    return;
  }

  let authed = false;
  try { authed = (await api.me()).authed; }
  catch { authed = false; }

  if (!authed) {
    await renderLogin(root);
  }
  await renderApp(root);

  // Re-login flow if session is lost mid-session.
  window.addEventListener('auth:lost', () => {
    location.reload();
  });
}

boot().catch(e => {
  console.error(e);
  document.body.innerHTML = `<div style="padding:40px;font-family:system-ui">启动失败：${String(e)}</div>`;
});
