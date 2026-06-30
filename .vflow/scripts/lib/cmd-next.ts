// cmd-next.ts — Load the next pending step: resolve skill + inline required_reading → stdout.

import { isoNow } from './config.js';
import type { RalphStep } from './ralph-schema.js';
import {
  currentTaskDir, readTaskJson, findNextPendingStep,
  updateStep, setActiveStep, getActiveStepIndex,
} from './ralph-store.js';
import { resolveRequiredReading, assembleStepPrompt } from './ralph-skill-loader.js';

/**
 * Execute the `next` command.
 *
 * Exit codes:
 *   0 — step loaded, prompt written to stdout
 *   2 — no pending steps (all done)
 *   3 — active_step_index occupied (a step is already running)
 *   1 — error
 */
export function cmdNext(): number {
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

  // Check for occupied active step
  const activeIdx = task.active_step_index;
  if (activeIdx !== null && activeIdx !== undefined) {
    const activeStep = task.steps[activeIdx];
    if (activeStep && activeStep.status === 'running') {
      console.error(`[vflow] Step ${activeIdx} is already running (${activeStep.skill}). Complete it first.`);
      return 3;
    }
    // Stale active index — auto-clear
    task.active_step_index = null;
  }

  // Find next pending step
  const next = findNextPendingStep(task.steps);
  if (!next) {
    console.log('[vflow] All steps completed.');
    return 2;
  }

  // Gate steps: output gate message and wait
  if (next.node_type === 'gate') {
    console.log(`[vflow:gate] ${next.description}`);
    console.log(`<!-- vflow ralph: gate step [${next.index}/${task.steps.length}] node=${next.node_id} task=${task.id} -->`);
    console.log('<!-- This is a gate step. Wait for user confirmation, then run:');
    console.log(`     node .vflow/scripts/dist/task.js complete ${next.index} --status DONE -->`);

    // Mark as running
    updateStep(taskDir, next.index, (s) => {
      s.status = 'running';
      s.started_at = isoNow();
    });
    setActiveStep(taskDir, next.index);
    return 0;
  }

  // Command steps: resolve required_reading and output prompt
  const readings = resolveRequiredReading(next.required_reading, taskDir);

  // Check for missing required files
  const missing = readings.filter(r => !r.exists);
  if (missing.length > 0) {
    console.error(`[vflow] E007: Required reading files missing:`);
    for (const m of missing) {
      console.error(`  - ${m.ref} → ${m.path}`);
    }
    // Continue with placeholders rather than blocking
  }

  // Assemble and output the step prompt
  const prompt = assembleStepPrompt(
    next.index,
    task.steps.length,
    next.skill,
    next.description,
    readings,
    task.id || 'unknown',
  );
  console.log(prompt);

  // Update step state
  updateStep(taskDir, next.index, (s) => {
    s.status = 'running';
    s.started_at = isoNow();
    s.load = {
      loaded_at: isoNow(),
      required_files: readings.filter(r => r.exists).map(r => r.path),
      deferred_files: [],
    };
  });
  setActiveStep(taskDir, next.index);

  return 0;
}
