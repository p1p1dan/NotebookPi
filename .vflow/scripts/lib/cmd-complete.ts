// cmd-complete.ts — Mark a step as completed with validation.

import { isoNow } from './config.js';
import type { CompletionStatus } from './ralph-schema.js';
import { VALID_COMPLETION_STATUSES } from './ralph-schema.js';
import {
  currentTaskDir, readTaskJson, updateStep, clearActiveStep,
} from './ralph-store.js';
import { runCompletionChecks } from './ralph-checker.js';

export interface CompleteArgs {
  index: number;
  status: CompletionStatus;
  evidence?: string[];
  concerns?: string;
  reason?: string;
}

/**
 * Execute the `complete` command.
 *
 * Exit codes:
 *   0 — step completed successfully
 *   1 — error (validation failure, wrong index, etc.)
 */
export function cmdComplete(args: CompleteArgs): number {
  const taskDir = currentTaskDir();
  if (!taskDir) {
    console.error('[vflow] No active task.');
    return 1;
  }

  const task = readTaskJson(taskDir);
  if (!task.steps || task.steps.length === 0) {
    console.error('[vflow] No ralph steps defined for this task.');
    return 1;
  }

  // Validate status
  if (!VALID_COMPLETION_STATUSES.includes(args.status as CompletionStatus)) {
    console.error(`[vflow] Invalid status: ${args.status}. Must be one of: ${VALID_COMPLETION_STATUSES.join(', ')}`);
    return 1;
  }

  // E008: index must match active_step_index
  const activeIdx = task.active_step_index;
  if (activeIdx === null || activeIdx === undefined || activeIdx !== args.index) {
    console.error(`[vflow] E008: Step ${args.index} is not the active step (active=${activeIdx}).`);
    return 1;
  }

  // E009: step must be running
  const step = task.steps[args.index];
  if (!step) {
    console.error(`[vflow] Step ${args.index} not found.`);
    return 1;
  }
  if (step.status !== 'running') {
    console.error(`[vflow] E009: Step ${args.index} status is '${step.status}', expected 'running'.`);
    return 1;
  }

  // Run completion checks (only for DONE/DONE_WITH_CONCERNS)
  if (args.status === 'DONE' || args.status === 'DONE_WITH_CONCERNS') {
    const checks = step.completion_checks || [];
    if (checks.length > 0) {
      const failures = runCompletionChecks(checks, taskDir);
      if (failures.length > 0) {
        console.error('[vflow] Completion checks failed:');
        for (const f of failures) {
          console.error(`  - ${f}`);
        }
        console.error('[vflow] Fix the above issues and try again.');
        return 1;
      }
    }
  }

  // Apply status transition
  switch (args.status) {
    case 'DONE':
      updateStep(taskDir, args.index, (s) => {
        s.status = 'completed';
        s.completion_confirmed = true;
        s.completion_status = 'DONE';
        s.completion_evidence = args.evidence || null;
        s.completed_at = isoNow();
      });
      clearActiveStep(taskDir);
      console.log(`[vflow] Step ${args.index} (${step.skill}) completed: DONE`);
      break;

    case 'DONE_WITH_CONCERNS':
      updateStep(taskDir, args.index, (s) => {
        s.status = 'completed';
        s.completion_confirmed = true;
        s.completion_status = 'DONE_WITH_CONCERNS';
        s.completion_evidence = args.evidence || null;
        s.concerns = args.concerns || null;
        s.completed_at = isoNow();
      });
      clearActiveStep(taskDir);
      console.log(`[vflow] Step ${args.index} (${step.skill}) completed: DONE_WITH_CONCERNS`);
      if (args.concerns) console.log(`  Concerns: ${args.concerns}`);
      break;

    case 'NEEDS_RETRY':
      updateStep(taskDir, args.index, (s) => {
        s.status = 'pending';
        s.retried = true;
        s.completion_confirmed = false;
        s.completion_status = null;
      });
      clearActiveStep(taskDir);
      console.log(`[vflow] Step ${args.index} (${step.skill}) marked for retry.`);
      break;

    case 'BLOCKED':
      updateStep(taskDir, args.index, (s) => {
        s.status = 'failed';
        s.completion_confirmed = false;
        s.completion_status = 'BLOCKED';
        s.concerns = args.reason || null;
      });
      clearActiveStep(taskDir);
      // Pause the session
      console.log(`[vflow] Step ${args.index} (${step.skill}) BLOCKED.`);
      if (args.reason) console.log(`  Reason: ${args.reason}`);
      console.log('[vflow] Session paused. Resolve the blocker and retry.');
      break;
  }

  return 0;
}
