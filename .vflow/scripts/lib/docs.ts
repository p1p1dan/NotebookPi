// vflow docs — document operations: isFilled, parseSection, uncheckedItems, worklogFiles.
// Supports both v1 (requirement.md + design.md + verify.md) and v2 (task-spec.md + ledger.md).

import { existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { readText } from './config.js';

// ---------------------------------------------------------------------------
// Document model detection
// ---------------------------------------------------------------------------

/** Returns true if the task uses the v2 document model (task-spec.md). */
export function isV2Docs(taskDir: string): boolean {
  return existsSync(join(taskDir, 'task-spec.md'));
}

// ---------------------------------------------------------------------------
// Path resolution (v1 + v2)
// ---------------------------------------------------------------------------

/** Resolve the primary design document path. v2: task-spec.md, v1: design.md / plan.md. */
export function designPath(taskDir: string): string {
  const spec = join(taskDir, 'task-spec.md');
  if (existsSync(spec)) return spec;
  const d = join(taskDir, 'design.md');
  if (existsSync(d)) return d;
  return join(taskDir, 'plan.md');
}

/** Resolve the requirement source path. v2: task-spec.md, v1: requirement.md. */
export function requirementPath(taskDir: string): string {
  const spec = join(taskDir, 'task-spec.md');
  if (existsSync(spec)) return spec;
  return join(taskDir, 'requirement.md');
}

/** Resolve the verification/ledger path. v2: ledger.md, v1: verify.md. */
export function verifyPath(taskDir: string): string {
  const ledger = join(taskDir, 'ledger.md');
  if (existsSync(ledger)) return ledger;
  return join(taskDir, 'verify.md');
}

/** Resolve the worklog source path. v2: ledger.md §1, v1: worklog.md. */
export function worklogPath(taskDir: string): string {
  const ledger = join(taskDir, 'ledger.md');
  if (existsSync(ledger)) return ledger;
  return join(taskDir, 'worklog.md');
}

// ---------------------------------------------------------------------------
// Template detection (hash-based)
// ---------------------------------------------------------------------------

export function isFilled(path: string): boolean {
  if (!existsSync(path)) return false;
  const content = readText(path);
  if (!content.trim()) return false;
  const hashFile = path + '.hash';
  if (existsSync(hashFile)) {
    const originalHash = readText(hashFile).trim();
    const currentHash = createHash('sha256')
      .update(content, 'utf-8')
      .digest('hex')
      .slice(0, 16);
    return currentHash !== originalHash;
  }
  const nonEmpty = content.split('\n').filter((l) => {
    const s = l.trim();
    return (
      s &&
      !s.startsWith('#') &&
      !s.startsWith('<!--') &&
      !s.startsWith('|') &&
      !s.startsWith('---') &&
      !s.startsWith('>') &&
      !s.startsWith('- [ ]')
    );
  });
  const meaningful = nonEmpty.filter((l) => !/^-\s*\S+：\s*$/.test(l.trim()));
  return meaningful.length >= 3;
}

// ---------------------------------------------------------------------------
// Checklist parsing
// ---------------------------------------------------------------------------

/** Extract unchecked items. v2: from task-spec.md §6, v1: from design.md. */
export function uncheckedItems(taskDir: string): string[] {
  if (isV2Docs(taskDir)) {
    const body = parseSection(join(taskDir, 'task-spec.md'), 6);
    return body
      .split('\n')
      .filter((l) => l.trim().startsWith('- [ ]'))
      .map((l) => l.trim().slice(6).trim());
  }
  const text = readText(designPath(taskDir));
  return text
    .split('\n')
    .filter((l) => l.trim().startsWith('- [ ]'))
    .map((l) => l.trim().slice(6).trim());
}

// ---------------------------------------------------------------------------
// Worklog file extraction
// ---------------------------------------------------------------------------

/** Extract file paths from worklog table. v2: ledger.md §1, v1: worklog.md. */
export function worklogFiles(taskDir: string): string[] {
  let text: string;
  if (isV2Docs(taskDir)) {
    text = parseSection(join(taskDir, 'ledger.md'), 1);
  } else {
    text = readText(join(taskDir, 'worklog.md'));
  }
  const files: string[] = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s.startsWith('|') || s.startsWith('| :') || s.startsWith('|:')) continue;
    const cols = s
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((c) => c.trim());
    if (cols.length >= 2 && cols[1] && !['File', '文件', '----'].includes(cols[1])) {
      files.push(cols[1].replace(/^`|`$/g, ''));
    }
  }
  return files;
}

export function latestWorklogMtime(taskDir: string, projectRoot: string): number {
  let latest = 0;
  for (const rel of worklogFiles(taskDir)) {
    const p = join(projectRoot, rel);
    try {
      const st = statSync(p);
      if (st.isFile()) {
        latest = Math.max(latest, st.mtimeMs / 1000);
      }
    } catch {
      console.log(`  [vflow] warning: worklog file not found, mtime check skipped: ${rel}`);
    }
  }
  return latest;
}

// ---------------------------------------------------------------------------
// Section parsing
// ---------------------------------------------------------------------------

/** Parse a §N section from a markdown file. Returns the body text between §N and the next ## heading. */
export function parseSection(filePath: string, sectionNo: number): string {
  const text = readText(filePath);
  const pattern = new RegExp(
    `^##\\s*§${sectionNo}\\b.*?$(.*?)(?=^##\\s|$(?![\\s\\S]))`,
    'ms',
  );
  const m = pattern.exec(text);
  return m ? m[1].trim() : '';
}
