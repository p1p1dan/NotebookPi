// ralph-schema.ts — Step execution model types (adapted from maestro-flow ralph).

// -- Step completion status --

export const VALID_COMPLETION_STATUSES = ['DONE', 'DONE_WITH_CONCERNS', 'NEEDS_RETRY', 'BLOCKED'] as const;
export type CompletionStatus = typeof VALID_COMPLETION_STATUSES[number];

export const STEP_STATUSES = ['pending', 'running', 'completed', 'skipped', 'failed'] as const;
export type StepStatus = typeof STEP_STATUSES[number];

// -- Step load record (written by `next` command) --

export interface StepLoad {
  loaded_at: string;
  required_files: string[];
  deferred_files: string[];
}

// -- Step definition --

export interface RalphStep {
  index: number;
  /** Graph node ID this step maps to */
  node_id: string;
  /** Node type: command (execute), gate (pause for user), terminal */
  node_type: 'command' | 'gate' | 'terminal';
  /** Skill name to execute (for command nodes) */
  skill: string;
  /** Human-readable description */
  description: string;
  /** Files to inline when loading this step */
  required_reading: string[];
  /** Document checks to run on completion */
  completion_checks: string[];

  // -- Runtime state (managed by next/complete commands) --
  status: StepStatus;
  completion_confirmed: boolean;
  completion_status: CompletionStatus | null;
  completion_evidence: string | string[] | null;
  concerns: string | null;
  retried: boolean;
  load: StepLoad | null;
  started_at: string | null;
  completed_at: string | null;
}

// -- Extended task.json fields for ralph --

export interface RalphTaskFields {
  /** Ordered steps for this task */
  steps: RalphStep[];
  /** Index of the currently executing step (null = no step active) */
  active_step_index: number | null;
  /** Ralph protocol version */
  ralph_protocol_version: '1';
}

// -- Factory --

export function createStep(
  index: number,
  nodeId: string,
  nodeType: 'command' | 'gate' | 'terminal',
  skill: string,
  description: string,
  requiredReading: string[] = [],
  completionChecks: string[] = [],
): RalphStep {
  return {
    index,
    node_id: nodeId,
    node_type: nodeType,
    skill,
    description,
    required_reading: requiredReading,
    completion_checks: completionChecks,
    status: 'pending',
    completion_confirmed: false,
    completion_status: null,
    completion_evidence: null,
    concerns: null,
    retried: false,
    load: null,
    started_at: null,
    completed_at: null,
  };
}
