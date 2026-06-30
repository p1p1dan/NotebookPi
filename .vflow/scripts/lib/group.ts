// vflow group — task group management (R6).
// Large tasks split into sub-tasks sharing a group-id.

import {
  existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync,
} from 'node:fs';
import { join, basename } from 'node:path';
import type { TaskJson } from './config.js';
import { readJson, isoNow, TASKS } from './config.js';

export interface GroupJson {
  id: string;
  title: string;
  created: string;
  status: 'planning' | 'executing' | 'completed';
  subtasks: SubTaskRef[];
  waves?: WaveDefinition[];
  shared_context?: Record<string, unknown>;
}

export interface SubTaskRef {
  id: string;
  slug: string;
  depends_on?: string[];
  wave?: number;
  status: string;
}

export interface WaveDefinition {
  id: number;
  name?: string;
  parallel: boolean;
  tasks: string[];
}

// -- CRUD --

export function createGroup(
  slug: string,
  title: string,
): GroupJson {
  const dir = join(TASKS, slug);
  if (existsSync(dir)) {
    throw new Error(`Group directory already exists: ${slug}`);
  }
  mkdirSync(dir, { recursive: true });

  const group: GroupJson = {
    id: slug,
    title,
    created: isoNow(),
    status: 'planning',
    subtasks: [],
  };
  writeFileSync(join(dir, 'group.json'), JSON.stringify(group, null, 2) + '\n', 'utf-8');
  writeFileSync(
    join(dir, 'group-ledger.md'),
    '# Group Ledger\n\n## Sub-task Summary\n\n| Sub-task | Status | Commit |\n| :--- | :--- | :--- |\n',
    'utf-8',
  );
  return group;
}

export function createSubTask(
  groupSlug: string,
  subSlug: string,
  title: string,
  opts?: { depends_on?: string[]; wave?: number },
): TaskJson {
  const groupDir = join(TASKS, groupSlug);
  const groupPath = join(groupDir, 'group.json');
  const group = readJson<GroupJson>(groupPath);
  if (!group) throw new Error(`Group not found: ${groupSlug}`);

  const subDir = join(groupDir, subSlug);
  mkdirSync(subDir, { recursive: true });

  const task: TaskJson = {
    id: `${groupSlug}/${subSlug}`,
    title,
    tier: 'T2',
    state: 'created',
    risk: 'low',
    created: isoNow(),
  };
  writeFileSync(join(subDir, 'task.json'), JSON.stringify(task, null, 2) + '\n', 'utf-8');

  group.subtasks.push({
    id: task.id,
    slug: subSlug,
    depends_on: opts?.depends_on,
    wave: opts?.wave,
    status: 'created',
  });
  writeFileSync(groupPath, JSON.stringify(group, null, 2) + '\n', 'utf-8');

  return task;
}

export function groupStatus(groupSlug: string): GroupJson | null {
  const groupPath = join(TASKS, groupSlug, 'group.json');
  return readJson<GroupJson>(groupPath);
}

export function groupDone(groupSlug: string, summary: string): void {
  const groupDir = join(TASKS, groupSlug);
  const groupPath = join(groupDir, 'group.json');
  const group = readJson<GroupJson>(groupPath);
  if (!group) throw new Error(`Group not found: ${groupSlug}`);

  group.status = 'completed';
  writeFileSync(groupPath, JSON.stringify(group, null, 2) + '\n', 'utf-8');

  // Append summary to group ledger
  const ledgerPath = join(groupDir, 'group-ledger.md');
  let ledger = '';
  try {
    ledger = readFileSync(ledgerPath, 'utf-8');
  } catch { /* */ }
  ledger += `\n## Completion Summary\n\n${summary}\n\nCompleted: ${isoNow()}\n`;
  writeFileSync(ledgerPath, ledger, 'utf-8');
}
