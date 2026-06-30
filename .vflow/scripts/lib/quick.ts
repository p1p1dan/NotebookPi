// vflow quick — T1 extreme simplification: append JSONL line, no directory creation.

import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { isoNow, TASKS } from './config.js';
import { gitHead } from './archive.js';

export interface QuickLogEntry {
  id: string;
  title: string;
  files_changed: string[];
  commit: string;
  timestamp: string;
}

const QUICK_LOG_PATH = join(TASKS, 'quick-log.jsonl');

export function appendQuickLog(
  title: string,
  filesChanged: string[] = [],
): QuickLogEntry {
  mkdirSync(dirname(QUICK_LOG_PATH), { recursive: true });
  const entry: QuickLogEntry = {
    id: `t1-${Date.now().toString(36)}`,
    title,
    files_changed: filesChanged,
    commit: gitHead(),
    timestamp: isoNow(),
  };
  appendFileSync(QUICK_LOG_PATH, JSON.stringify(entry) + '\n', 'utf-8');
  return entry;
}

export function getQuickLogPath(): string {
  return QUICK_LOG_PATH;
}
