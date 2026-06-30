// vflow team — team mode helpers: uid resolution, pointer management, activity reporting.

import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import type { VflowConfig } from './config.js';
import { readJson, isoNow, ROOT, RUNTIME, POINTER, CONFIG_PATH } from './config.js';

export function isTeamMode(): boolean {
  const cfg = readJson<VflowConfig>(CONFIG_PATH, {} as VflowConfig);
  return !!(cfg?.team?.enabled);
}

export function gitConfigValue(key: string): string {
  try {
    const r = spawnSync('git', ['config', key], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return r.status === 0 ? (r.stdout ?? '').trim() : '';
  } catch {
    return '';
  }
}

export function selfUid(): string | null {
  const email = gitConfigValue('user.email');
  if (!email) return null;
  return email.split('@')[0].toLowerCase();
}

export function pointerPath(): string {
  if (isTeamMode()) {
    const uid = selfUid();
    if (uid) return join(RUNTIME, `current-task-${uid}`);
  }
  return POINTER;
}

export function reportActivity(
  action: string,
  taskSlug: string,
  state: string,
): void {
  try {
    if (!isTeamMode()) return;
    const uid = selfUid();
    if (!uid) return;
    const activityPath = join(ROOT, 'collab', 'activity.jsonl');
    mkdirSync(dirname(activityPath), { recursive: true });
    const entry = {
      ts: isoNow(),
      user: uid,
      host: hostname(),
      action,
      task: taskSlug,
      state,
    };
    appendFileSync(activityPath, JSON.stringify(entry) + '\n', 'utf-8');
  } catch {
    /* fire-and-forget */
  }
}
