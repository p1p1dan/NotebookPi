// ralph-skill-loader.ts — Load skill files, resolve @path references, inline required_reading.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { ROOT, PROJECT_ROOT, TASKS } from './config.js';

// -- Path expansion --

/**
 * Expand a path reference used in required_reading.
 *
 * Supported prefixes:
 *   @task/xxx       → current task directory / xxx
 *   @.vflow/xxx     → .vflow/ root / xxx
 *   @~/xxx          → user home / xxx
 *   @spec/xxx       → .vflow/spec/ xxx
 *   absolute path   → as-is
 *   relative path   → relative to contextDir
 */
export function expandPath(
  ref: string,
  taskDir: string | null,
  contextDir: string = PROJECT_ROOT,
): string {
  // Strip leading @ if present
  let p = ref.startsWith('@') ? ref.slice(1) : ref;

  if (p.startsWith('task/')) {
    if (!taskDir) throw new Error(`Cannot resolve @task/ path without active task: ${ref}`);
    return join(taskDir, p.slice(5));
  }
  if (p.startsWith('.vflow/')) {
    return join(ROOT, p.slice(7));
  }
  if (p.startsWith('~/')) {
    return join(homedir(), p.slice(2));
  }
  if (p.startsWith('spec/')) {
    return join(ROOT, 'spec', p.slice(5));
  }
  if (isAbsolute(p)) {
    return p;
  }
  return resolve(contextDir, p);
}

/**
 * Read a file and return its content, or a placeholder if missing.
 */
function readFileOrPlaceholder(path: string): { content: string; exists: boolean } {
  if (!existsSync(path)) {
    return { content: `<!-- FILE NOT FOUND: ${path} -->`, exists: false };
  }
  try {
    return { content: readFileSync(path, 'utf-8'), exists: true };
  } catch (e) {
    return { content: `<!-- READ ERROR: ${path}: ${e} -->`, exists: false };
  }
}

// -- Required reading resolution --

export interface ResolvedReading {
  path: string;
  ref: string;
  content: string;
  exists: boolean;
}

/**
 * Resolve and load all required_reading paths for a step.
 */
export function resolveRequiredReading(
  refs: string[],
  taskDir: string | null,
): ResolvedReading[] {
  return refs.map(ref => {
    const path = expandPath(ref, taskDir);
    const { content, exists } = readFileOrPlaceholder(path);
    return { path, ref, content, exists };
  });
}

// -- Skill file loading --

export interface SkillManifest {
  name: string;
  description: string;
  body: string;
}

/**
 * Load a skill SKILL.md file and parse its frontmatter.
 */
export function loadSkill(skillName: string): SkillManifest | null {
  // Search in .claude/skills/ and .vflow/skills/
  const searchPaths = [
    join(PROJECT_ROOT, '.claude', 'skills', skillName, 'SKILL.md'),
    join(ROOT, 'skills', skillName, 'SKILL.md'),
  ];

  for (const path of searchPaths) {
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf-8');
      return parseSkillFile(raw, skillName);
    }
  }
  return null;
}

function parseSkillFile(raw: string, fallbackName: string): SkillManifest {
  let name = fallbackName;
  let description = '';
  let body = raw;

  // Parse YAML frontmatter if present
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (fmMatch) {
    const fm = fmMatch[1];
    body = fmMatch[2];
    const nameMatch = fm.match(/^name:\s*(.+)$/m);
    if (nameMatch) name = nameMatch[1].trim();
    const descMatch = fm.match(/^description:\s*(.+)$/m);
    if (descMatch) description = descMatch[1].trim();
  }

  return { name, description, body };
}

// -- Assemble step prompt --

/**
 * Assemble the full prompt output for `task.js next`.
 * Includes: required reading (inlined) + skill body + completion protocol.
 */
export function assembleStepPrompt(
  stepIndex: number,
  totalSteps: number,
  skillName: string,
  description: string,
  readings: ResolvedReading[],
  taskId: string,
): string {
  const parts: string[] = [];

  // Required reading block
  if (readings.length > 0) {
    parts.push('<required_reading>');
    for (const r of readings) {
      parts.push(`<!-- inlined ${r.ref} -->`);
      parts.push(r.content);
      parts.push(`<!-- /inlined -->`);
      parts.push('');
    }
    parts.push('</required_reading>');
    parts.push('');
  }

  // Step metadata
  parts.push(`<!-- vflow ralph: step [${stepIndex}/${totalSteps}] skill=${skillName} task=${taskId} -->`);
  parts.push(`<!-- Step description: ${description} -->`);
  parts.push('');

  // Completion protocol
  parts.push('<!-- On finish, run exactly one of:');
  parts.push(`     node .vflow/scripts/dist/task.js complete ${stepIndex} --status DONE`);
  parts.push(`     node .vflow/scripts/dist/task.js complete ${stepIndex} --status DONE_WITH_CONCERNS --concerns "..."`);
  parts.push(`     node .vflow/scripts/dist/task.js complete ${stepIndex} --status NEEDS_RETRY`);
  parts.push(`     node .vflow/scripts/dist/task.js complete ${stepIndex} --status BLOCKED --reason "..." -->`);
  parts.push('');

  return parts.join('\n');
}
