// vflow archive — archival logic, followup extraction, directory operations.

import {
  existsSync, mkdirSync, writeFileSync, unlinkSync,
  renameSync, rmSync, readdirSync, copyFileSync, statSync, appendFileSync,
} from 'node:fs';
import { join, basename, dirname, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { TaskJson, FollowupTask } from './config.js';
import {
  readJson, readText, isoNow, isoToday, yearMonth,
  ROOT, TASKS, POINTER, RUNTIME, JOURNAL_DIR,
} from './config.js';
import { designPath } from './docs.js';
import { pointerPath, isTeamMode, selfUid, reportActivity } from './team.js';

// -- directory operations --

function copyDirRecursive(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const dstPath = join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, dstPath);
    } else {
      copyFileSync(srcPath, dstPath);
    }
  }
}

export function moveDir(src: string, dst: string): void {
  try {
    renameSync(src, dst);
  } catch {
    copyDirRecursive(src, dst);
    rmSync(src, { recursive: true, force: true });
  }
}

// -- git helpers --

export function gitHead(): string {
  try {
    const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return r.status === 0 ? (r.stdout ?? '').trim() : '';
  } catch {
    return '';
  }
}

// -- journal --

export function appendJournal(task: TaskJson, summary: string): void {
  mkdirSync(JOURNAL_DIR, { recursive: true });
  const jp = join(JOURNAL_DIR, 'journal-1.md');
  let line = `- [${isoToday()}] [${task.title}] [${task.tier ?? 'T2'}] ${summary}`;
  const commit = gitHead();
  if (commit) line += ` (commit:${commit})`;
  const isNew = !existsSync(jp);
  let content = '';
  if (isNew) content = '# Developer Journal\n\n';
  content += line + '\n';
  try {
    const existing = isNew ? '' : readText(jp);
    writeFileSync(jp, (isNew ? '' : existing) + content, 'utf-8');
  } catch { /* */ }

  const cfg = readJson<Record<string, unknown>>(join(ROOT, 'config.json'), {});
  const nb = ((cfg as Record<string, unknown>)?.journal as Record<string, unknown>)?.notebook_path as string ?? '';
  if (nb) {
    try {
      if (statSync(nb).isDirectory()) {
        try {
          const nbFile = join(nb, 'vflow-log.md');
          const existing = existsSync(nbFile) ? readText(nbFile) : '';
          writeFileSync(nbFile, existing + line + '\n', 'utf-8');
        } catch (e) {
          console.log(`[vflow] warning: notebook journal write failed: ${(e as Error).message}`);
        }
      }
    } catch { /* nb not a directory */ }
  }
}

// -- followup extraction from design.md roadmap tables --

const ROADMAP_HEADING = /^##\s+.*(?:路线图|[Rr]oadmap|实施|分阶段)/;
const PRIORITY_RE = /P\d+/;

export function extractFollowupTasks(designText: string): FollowupTask[] {
  const lines = designText.split('\n');
  const items: FollowupTask[] = [];
  let inRoadmap = false;
  let inTable = false;
  let currentPriority: string | null = null;

  for (const line of lines) {
    const stripped = line.trim();
    if (/^##\s/.test(stripped)) {
      if (ROADMAP_HEADING.test(stripped)) {
        inRoadmap = true;
        inTable = false;
        continue;
      } else if (inRoadmap) {
        break;
      }
    }
    if (!inRoadmap) continue;

    if (/^###\s/.test(stripped)) {
      const pm = stripped.match(PRIORITY_RE);
      currentPriority = pm ? pm[0] : currentPriority;
      inTable = false;
      continue;
    }
    if (stripped.startsWith('| :') || stripped.startsWith('|:') || stripped.startsWith('| ---')) {
      inTable = true;
      continue;
    }
    if (inTable && stripped.startsWith('|')) {
      const cols = stripped
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((c) => c.trim());
      if (cols.length < 2) continue;
      const id = cols[0].replace(/\*\*/g, '');
      const title = cols[1].replace(/\*\*/g, '');
      if (!id || !title || id === '#' || id === '序号') continue;
      const rowPriority = (() => {
        for (const c of cols) {
          const m = c.match(PRIORITY_RE);
          if (m) return m[0];
        }
        return currentPriority;
      })();
      items.push({
        id,
        title,
        priority: rowPriority ?? 'P0',
        done: false,
        impl_task: null,
      });
    } else if (inTable && !stripped.startsWith('|') && stripped !== '') {
      inTable = false;
    }
  }
  return items;
}

// -- archive move --

export function archiveMove(
  taskDir: string,
  task: TaskJson,
  summary: string,
): void {
  task.completed = isoNow();
  writeFileSync(join(taskDir, 'task.json'), JSON.stringify(task, null, 2) + '\n', 'utf-8');
  const monthDir = join(TASKS, 'archive', yearMonth());
  mkdirSync(monthDir, { recursive: true });
  const dst = join(monthDir, basename(taskDir));
  moveDir(taskDir, dst);
  appendJournal(task, summary);
  if (existsSync(POINTER)) unlinkSync(POINTER);
  const uidPtr = pointerPath();
  if (uidPtr !== POINTER && existsSync(uidPtr)) unlinkSync(uidPtr);
  reportActivity('done', basename(taskDir), 'archived');
  console.log(`[vflow] Task archived to ${relative(ROOT, dst)}`);
}
