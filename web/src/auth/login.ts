// Login screen. Renders into #app and resolves once login succeeds.

import { api, ApiError } from '../api';

export function renderLogin(root: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    root.innerHTML = `
      <div class="login-wrap">
        <form class="login-card" id="login-form" novalidate>
          <div class="login-brand">
            <div class="login-mark">N</div>
            <div>
              <div class="login-title">Notebook</div>
              <div class="login-sub" style="margin-bottom:0">个人在线笔记本</div>
            </div>
          </div>
          <label class="block mb-1" style="font-size:12.5px;color:var(--fg-soft)">密码</label>
          <input id="pw" type="password" class="login-input" placeholder="输入访问密码" autocomplete="current-password" autofocus />
          <button id="submit" type="submit" class="login-submit">进入</button>
          <div id="err" class="login-error"></div>
          <p class="login-hint">单用户模式 · 密码在服务器 .env 配置</p>
        </form>
      </div>
    `;

    const form = root.querySelector<HTMLFormElement>('#login-form')!;
    const pw   = root.querySelector<HTMLInputElement>('#pw')!;
    const btn  = root.querySelector<HTMLButtonElement>('#submit')!;
    const err  = root.querySelector<HTMLDivElement>('#err')!;

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.textContent = '';
      pw.classList.remove('is-error');
      if (!pw.value) { pw.focus(); return; }
      btn.disabled = true;
      btn.textContent = '验证中…';
      try {
        await api.login(pw.value);
        resolve();
      } catch (e2) {
        const msg = e2 instanceof ApiError && e2.code === 'invalid_password'
          ? '密码错误'
          : '登录失败，请重试';
        err.textContent = msg;
        pw.classList.add('is-error');
        pw.select();
      } finally {
        btn.disabled = false;
        btn.textContent = '进入';
      }
    });
  });
}
