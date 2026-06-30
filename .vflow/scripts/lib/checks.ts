// checks.ts — Stage transition gates, execution-item state machine, DAG validation.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Stage, Proposal, ExecutionArtifact, ExecutionItem, ItemStatus,
  AnalysisArtifact, DesignArtifact, PlanArtifact, VerifyArtifact,
  VflowEvent,
} from './schema.js';
import { STAGES } from './schema.js';
import { readArtifact, readEvents, readyItems, activeItem, detectCycle } from './store.js';

// --- Stage transition checks ---

export type GateCheckFn = (dir: string, proposal: Proposal) => string[];

function checkIntakeToAnalysis(dir: string, _p: Proposal): string[] {
  const a = readArtifact<AnalysisArtifact>(dir, 'analysis');
  const errors: string[] = [];
  if (!a) { errors.push('analysis.json missing'); return errors; }
  if (!a.problem || !a.problem.trim()) errors.push('analysis.json: problem is empty');
  if (!a.scope || !a.scope.trim()) errors.push('analysis.json: scope is empty');
  return errors;
}

function checkAnalysisToDesign(dir: string, _p: Proposal): string[] {
  const d = readArtifact<DesignArtifact>(dir, 'design');
  const errors: string[] = [];
  if (!d) { errors.push('design.json missing'); return errors; }
  if (!d.decisions || d.decisions.length === 0) errors.push('design.json: no decisions');
  return errors;
}

function checkDesignToPlan(dir: string, p: Proposal): string[] {
  const pl = readArtifact<PlanArtifact>(dir, 'plan');
  const errors: string[] = [];
  if (!pl) { errors.push('plan.json missing'); return errors; }
  if (!pl.execution_outline || !pl.execution_outline.trim()) errors.push('plan.json: execution_outline is empty');
  if (!pl.verify_plan || !pl.verify_plan.checks || pl.verify_plan.checks.length === 0) {
    errors.push('plan.json: verify_plan.checks must have at least 1 check');
  }
  if (p.tier === 'T3') {
    const events = readEvents(dir);
    let lastBackIdx = -1;
    let lastConfirmIdx = -1;
    for (let i = events.length - 1; i >= 0; i--) {
      if (lastBackIdx < 0 && events[i].type === 'stage_changed' && events[i].to === 'design' && events[i].detail === 'back') {
        lastBackIdx = i;
      }
      if (lastConfirmIdx < 0 && events[i].type === 'design_confirmed') {
        lastConfirmIdx = i;
      }
      if (lastBackIdx >= 0 && lastConfirmIdx >= 0) break;
    }
    if (lastConfirmIdx < 0) {
      errors.push('T3 requires explicit design confirmation before advancing to plan. Run `confirm-design` first.');
    } else if (lastBackIdx >= 0 && lastConfirmIdx < lastBackIdx) {
      errors.push('Design was modified after last confirmation (back to design detected). Run `confirm-design` again.');
    } else {
      const confirmEvent = events[lastConfirmIdx];
      const hashMatch = confirmEvent.detail?.match(/design_hash=([0-9a-f]{64})/);
      if (hashMatch) {
        const designPath = join(dir, 'design.json');
        if (existsSync(designPath)) {
          const currentHash = createHash('sha256').update(readFileSync(designPath, 'utf-8')).digest('hex');
          if (currentHash !== hashMatch[1]) {
            errors.push('design.json content changed after last confirmation. Run `confirm-design` again.');
          }
        }
      }
    }
  }
  return errors;
}

function checkPlanToExecution(dir: string, _p: Proposal): string[] {
  const exec = readArtifact<ExecutionArtifact>(dir, 'execution');
  const errors: string[] = [];
  if (!exec) { errors.push('execution.json missing'); return errors; }
  if (!exec.items || exec.items.length === 0) {
    errors.push('execution.json: items is empty');
    return errors;
  }
  if (detectCycle(exec.items)) errors.push('execution.json: DAG has a cycle');
  const ready = readyItems(exec);
  if (ready.length === 0) errors.push('execution.json: no ready items (all blocked by dependencies?)');
  return errors;
}

function checkExecutionToVerify(dir: string, _p: Proposal): string[] {
  const exec = readArtifact<ExecutionArtifact>(dir, 'execution');
  const errors: string[] = [];
  if (!exec) { errors.push('execution.json missing'); return errors; }
  const incomplete = exec.items.filter(i => i.status !== 'done' && i.status !== 'cancelled');
  if (incomplete.length > 0) {
    errors.push(`execution.json: ${incomplete.length} items not done/cancelled: ${incomplete.map(i => i.id).join(', ')}`);
  }
  return errors;
}

function checkVerifyToPendingAcceptance(dir: string, _p: Proposal): string[] {
  const v = readArtifact<VerifyArtifact>(dir, 'verify');
  const errors: string[] = [];
  if (!v) { errors.push('verify.json missing'); return errors; }
  if (v.all_gating_passed !== true) {
    errors.push('verify.json: all_gating_passed is not true (gating checks failed without waiver)');
  }
  // Path B: an un-waived CRITICAL spec-review finding is a hard gate, even if
  // all_gating_passed is stale (e.g. review recorded after last `verify run`).
  const crit = v.spec_review?.findings?.filter(f => f.level === 'CRITICAL' && !f.waived) ?? [];
  if (crit.length > 0) {
    errors.push(`spec_review: ${crit.length} un-waived CRITICAL finding(s) — fix or waive before advancing`);
  }
  return errors;
}

function checkPendingAcceptanceToDone(dir: string, _p: Proposal): string[] {
  const events = readEvents(dir);
  const errors: string[] = [];
  const v = readArtifact<VerifyArtifact>(dir, 'verify');
  const currentRound = v?.verify_round ?? 1;
  const lastAcceptance = [...events].reverse().find(
    e => e.type === 'acceptance' && (e.verify_round ?? 1) >= currentRound
  );
  if (!lastAcceptance || lastAcceptance.detail !== 'confirmed_by_user:true') {
    errors.push('No user acceptance event found. AI cannot advance to done — user must run `accept`');
  }
  return errors;
}

function checkDoneToArchived(dir: string, p: Proposal): string[] {
  const errors: string[] = [];
  if (!existsSync(join(dir, 'events.jsonl'))) {
    errors.push('events.jsonl missing — cannot derive review');
  }
  if (!p.knowledge_processed) {
    errors.push('Knowledge candidates not processed. Run `knowledge suggest` then `knowledge save` or `knowledge skip`, then retry archive.');
  }
  const events = readEvents(dir);
  const hasAcceptance = events.some(e => e.type === 'acceptance' && e.detail === 'confirmed_by_user:true');
  if (!hasAcceptance) {
    errors.push('No user acceptance event found. Proposal must be accepted before archiving.');
  }
  const v = readArtifact<VerifyArtifact>(dir, 'verify');
  if (!v || !v.all_gating_passed) {
    errors.push('Verification incomplete: all_gating_passed is not true.');
  }
  return errors;
}

export const STAGE_GATES: Partial<Record<Stage, GateCheckFn>> = {
  analysis: checkIntakeToAnalysis,
  design: checkAnalysisToDesign,
  plan: checkDesignToPlan,
  execution: checkPlanToExecution,
  verify: checkExecutionToVerify,
  pending_acceptance: checkVerifyToPendingAcceptance,
  done: checkPendingAcceptanceToDone,
  archived: checkDoneToArchived,
};

export function canArchive(dir: string, proposal: Proposal): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (proposal.stage !== 'done') {
    errors.push(`Stage is '${proposal.stage}', expected 'done'`);
  }
  const events = readEvents(dir);
  if (!events.some(e => e.type === 'acceptance' && e.detail?.includes('confirmed_by_user:true'))) {
    errors.push('No user acceptance event found. Proposal must be accepted before archiving.');
  }
  const v = readArtifact<VerifyArtifact>(dir, 'verify');
  if (!v || !v.all_gating_passed) {
    errors.push('Verification incomplete: all_gating_passed is not true.');
  }
  if (!proposal.knowledge_processed) {
    errors.push('Knowledge candidates not processed. Run `knowledge suggest` then `knowledge save` or `knowledge skip`.');
  }
  return { ok: errors.length === 0, errors };
}

export function canAdvance(dir: string, proposal: Proposal): { ok: boolean; errors: string[] } {
  const currentIdx = STAGES.indexOf(proposal.stage);
  if (currentIdx < 0 || currentIdx >= STAGES.length - 1) {
    return { ok: false, errors: [`Cannot advance from stage '${proposal.stage}'`] };
  }
  const nextStage = STAGES[currentIdx + 1];
  const gate = STAGE_GATES[nextStage];
  if (!gate) return { ok: true, errors: [] };
  const errors = gate(dir, proposal);
  return { ok: errors.length === 0, errors };
}

export function nextStage(current: Stage): Stage | null {
  const idx = STAGES.indexOf(current);
  if (idx < 0 || idx >= STAGES.length - 1) return null;
  return STAGES[idx + 1];
}

export function prevStage(current: Stage): Stage | null {
  const idx = STAGES.indexOf(current);
  if (idx <= 0) return null;
  return STAGES[idx - 1];
}

// --- Execution-item state machine ---

const VALID_ITEM_TRANSITIONS: Record<ItemStatus, ItemStatus[]> = {
  todo: ['doing', 'cancelled'],
  doing: ['done', 'blocked', 'cancelled'],
  blocked: ['doing', 'cancelled'],
  done: [],
  cancelled: [],
};

export interface ItemTransitionResult {
  ok: boolean;
  error?: string;
}

export function canTransitionItem(
  exec: ExecutionArtifact, itemId: string, to: ItemStatus,
): ItemTransitionResult {
  const item = exec.items.find(i => i.id === itemId);
  if (!item) return { ok: false, error: `Item '${itemId}' not found` };

  const allowed = VALID_ITEM_TRANSITIONS[item.status];
  if (!allowed.includes(to)) {
    return { ok: false, error: `Cannot transition item from '${item.status}' to '${to}'` };
  }

  // Serial invariant: only one doing at a time
  if (to === 'doing') {
    const current = activeItem(exec);
    if (current && current.id !== itemId) {
      return { ok: false, error: `Serial violation: item '${current.id}' is already doing` };
    }
    // Dependency check: all depends_on must be done
    const doneIds = new Set(exec.items.filter(i => i.status === 'done').map(i => i.id));
    const unmet = item.depends_on.filter(dep => !doneIds.has(dep));
    if (unmet.length > 0) {
      return { ok: false, error: `Dependencies not met: ${unmet.join(', ')}` };
    }
  }

  return { ok: true };
}

// --- Back transitions ---

export type BackTarget = 'execution' | 'design' | 'analysis';

const VALID_BACKS: Partial<Record<Stage, BackTarget[]>> = {
  verify: ['execution'],
  execution: ['design', 'analysis'],
};

export function canBack(proposal: Proposal, to: BackTarget): { ok: boolean; error?: string } {
  const allowed = VALID_BACKS[proposal.stage];
  if (!allowed || !allowed.includes(to)) {
    return { ok: false, error: `Cannot back from '${proposal.stage}' to '${to}'` };
  }
  return { ok: true };
}
