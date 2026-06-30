// ralph-store.ts — Read/write steps in task.json, manage active_step_index.

import { readFileSync, writeFileSync, existsSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { RalphStep, RalphTaskFields } from './ralph-schema.js';
import type { TaskJson } from './config.js';
import { TASKS, RUNTIME } from './config.js';
import { pointerPath } from './team.js';

// -- Task directory resolution --

export function currentTaskDir(): string | null {
  const ptr = pointerPath();
  if (!existsSync(ptr)) return null;
  const name = readFileSync(ptr, 'utf-8').trim();
  const d = join(TASKS, name);
  try {
    if (statSync(d).isDirectory()) return d;
  } catch { /* */ }
  return null;
}

// -- Read/Write task.json --

export function readTaskJson(taskDir: string): TaskJson & Partial<RalphTaskFields> {
  const path = join(taskDir, 'task.json');
  return JSON.parse(readFileSync(path, 'utf-8'));
}

export function writeTaskJson(taskDir: string, data: TaskJson & Partial<RalphTaskFields>): void {
  const path = join(taskDir, 'task.json');
  // Atomic write: write to tmp then rename
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  renameSync(tmp, path);
}

// -- Steps accessors --

export function getSteps(taskDir: string): RalphStep[] {
  const task = readTaskJson(taskDir);
  return task.steps ?? [];
}

export function getActiveStepIndex(taskDir: string): number | null {
  const task = readTaskJson(taskDir);
  return task.active_step_index ?? null;
}

export function hasRalphSession(taskDir: string): boolean {
  const task = readTaskJson(taskDir);
  return Array.isArray(task.steps) && task.steps.length > 0;
}

// -- Find next pending step --

export function findNextPendingStep(steps: RalphStep[]): RalphStep | null {
  return steps.find(s => s.status === 'pending') ?? null;
}

// -- Update a single step and write back --

export function updateStep(
  taskDir: string,
  index: number,
  updater: (step: RalphStep) => void,
): void {
  const task = readTaskJson(taskDir);
  if (!task.steps || index < 0 || index >= task.steps.length) {
    throw new Error(`Step index ${index} out of range`);
  }
  updater(task.steps[index]);
  writeTaskJson(taskDir, task);
}

// -- Set/clear active_step_index --

export function setActiveStep(taskDir: string, index: number): void {
  const task = readTaskJson(taskDir);
  task.active_step_index = index;
  writeTaskJson(taskDir, task);
}

export function clearActiveStep(taskDir: string): void {
  const task = readTaskJson(taskDir);
  task.active_step_index = null;
  writeTaskJson(taskDir, task);
}

// -- Write steps array to task.json --

export function writeSteps(taskDir: string, steps: RalphStep[]): void {
  const task = readTaskJson(taskDir);
  task.steps = steps;
  task.active_step_index = null;
  task.ralph_protocol_version = '1';
  writeTaskJson(taskDir, task);
}

// -- Summary for inject.ts --

export function stepsSummary(taskDir: string): string | null {
  const task = readTaskJson(taskDir);
  if (!task.steps || task.steps.length === 0) return null;

  const total = task.steps.length;
  const completed = task.steps.filter(s => s.status === 'completed' || s.status === 'skipped').length;
  const active = task.active_step_index;
  const activeStep = active !== null && active !== undefined ? task.steps[active] : null;

  let summary = `Ralph session: ${completed}/${total} steps completed.`;
  if (activeStep) {
    summary += ` Current: step [${active}] ${activeStep.skill} (${activeStep.status}).`;
  } else {
    const next = task.steps.find(s => s.status === 'pending');
    if (next) {
      summary += ` Next: step [${next.index}] ${next.skill}.`;
    } else {
      summary += ' All steps done.';
    }
  }
  return summary;
}
