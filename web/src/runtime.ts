// Runtime detection: are we inside a Tauri webview, or a browser tab?
//
// Called from main.ts before the app boots, so it can swap the API adapter
// in place. UI modules import { api } from './api' and the live ESM binding
// reflects the swap.

import { browserApi, setApiAdapter, type ApiAdapter } from './api';

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function installRuntime(): Promise<{ adapter: ApiAdapter; tauri: boolean }> {
  if (isTauri()) {
    const mod = await import('./desktop/tauri-api');
    setApiAdapter(mod.tauriApi);
    return { adapter: mod.tauriApi, tauri: true };
  }
  setApiAdapter(browserApi);
  return { adapter: browserApi, tauri: false };
}
