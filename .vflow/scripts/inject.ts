#!/usr/bin/env node
// inject.ts — Hook injection script for Claude Code session/prompt hooks.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROOT, REPO_INDEX_PATH, WORKFLOW_PATH, SPEC_DIR, readText, readJson,
} from './lib/config.js';
import type {
  Proposal, RepoIndex, ExecutionArtifact, SessionRuntime,
} from './lib/schema.js';
import {
  readRepoIndex, readProposal, readArtifact, readExecution,
  readyItems, activeItem, findProposalDir,
} from './lib/store.js';
import {
  resolveActiveProposalId, resolveSessionKey, writeLastActiveSession,
  readSession, readLastActiveSession,
} from './lib/session-runtime.js';

// --- Workflow state block extraction ---

function extractWorkflowBlock(stage: string): string {
  const content = readText(WORKFLOW_PATH);
  const marker = `[workflow-state:${stage}]`;
  const idx = content.indexOf(marker);
  if (idx < 0) return '';
  const start = idx + marker.length;
  const nextMarker = content.indexOf('[workflow-state:', start);
  const block = nextMarker > 0 ? content.slice(start, nextMarker) : content.slice(start);
  return block.trim();
}

// --- Mode: session ---

function injectSession(): void {
  const index = readRepoIndex();
  const activeProposals = index.proposals.filter(p =>
    p.lifecycle_status === 'active' || p.lifecycle_status === 'blocked'
  );

  const lines: string[] = [];
  lines.push('<vflow-session>');

  if (activeProposals.length === 0) {
    lines.push('No active proposals. To start a new proposal:');
    lines.push('  node .vflow/scripts/dist/proposal.js create <slug> --title "..." --type feature --tier T2');
  } else {
    lines.push(`Active proposals (${activeProposals.length}):`);
    for (const p of activeProposals) {
      lines.push(`  ${p.id} [${p.stage}/${p.lifecycle_status}] ${p.title}`);
    }
    if (activeProposals.length === 1) {
      lines.push(`\nCurrent: ${activeProposals[0].id} — ${activeProposals[0].title}`);
    }
  }

  // Workflow overview — hand the AI the full process map up-front so it doesn't
  // reverse-engineer the lifecycle mid-task (root cause of the "边做边猜" problem).
  // Single source: workflow.md [workflow-state:overview]. DRY.
  const overview = extractWorkflowBlock('overview');
  if (overview) {
    lines.push('');
    lines.push(overview);
  }

  // Spec index
  const specIndex = join(SPEC_DIR, 'index.md');
  if (existsSync(specIndex)) {
    const specContent = readText(specIndex);
    if (specContent) {
      lines.push(`\nSpec library (${specIndex}):`);
      lines.push(specContent.trim());
    } else {
      lines.push('\nSpec library available at .vflow/spec/');
    }
  }

  lines.push('</vflow-session>');
  process.stdout.write(lines.join('\n') + '\n');
}

// --- Mode: prompt ---

function injectPrompt(payload?: Record<string, unknown>): void {
  const repoFallback = () => {
    const index = readRepoIndex();
    const active = index.proposals.filter(p => p.lifecycle_status === 'active');
    return active.length === 1 ? active[0].id : null;
  };

  const { id: proposalId, source } = resolveActiveProposalId(payload, repoFallback);

  const lines: string[] = [];
  lines.push('<vflow-prompt>');

  if (!proposalId) {
    const block = extractWorkflowBlock('no_proposal');
    if (block) lines.push(block);
    else lines.push('No active proposal. Create one with: node .vflow/scripts/dist/proposal.js create <slug> --title "..." --type feature --tier T2');
    lines.push('</vflow-prompt>');
    process.stdout.write(lines.join('\n') + '\n');
    return;
  }

  const dir = findProposalDir(proposalId);
  if (!dir) {
    lines.push(`Proposal ${proposalId} directory not found.`);
    lines.push('</vflow-prompt>');
    process.stdout.write(lines.join('\n') + '\n');
    return;
  }

  const proposal = readProposal(dir);
  if (!proposal) {
    lines.push(`Cannot read proposal.json for ${proposalId}.`);
    lines.push('</vflow-prompt>');
    process.stdout.write(lines.join('\n') + '\n');
    return;
  }

  lines.push(`Proposal: ${proposal.id} — ${proposal.title}`);
  lines.push(`Stage: ${proposal.stage} | Lifecycle: ${proposal.lifecycle_status} | Tier: ${proposal.tier} | Type: ${proposal.type}`);

  if (proposal.blocking.status === 'blocked') {
    lines.push(`BLOCKED: ${proposal.blocking.reason ?? proposal.blocking.type ?? 'unknown'}`);
  }

  // Stage-specific workflow block
  const block = extractWorkflowBlock(proposal.stage);
  if (block) {
    lines.push('');
    lines.push(block);
  }

  // Execution stage: inject item work queue + session runtime hints
  if (proposal.stage === 'execution') {
    const exec = readExecution(dir);
    if (exec) {
      const doing = activeItem(exec);
      const ready = readyItems(exec);
      const blocked = exec.items.filter(i => i.status === 'blocked');

      lines.push('');
      lines.push('--- Execution Work Queue ---');
      if (doing) {
        lines.push(`ACTIVE: ${doing.id} — ${doing.title}`);
      }
      if (ready.length) {
        lines.push(`READY: ${ready.map(i => `${i.id}(${i.title})`).join(', ')}`);
      }
      if (blocked.length) {
        lines.push(`BLOCKED: ${blocked.map(i => `${i.id}(${i.note ?? 'no reason'})`).join(', ')}`);
      }
      const done = exec.items.filter(i => i.status === 'done').length;
      const total = exec.items.length;
      lines.push(`Progress: ${done}/${total} done`);

      // Session runtime hints (read-only, truth source is execution.json)
      const sessionKey = resolveSessionKey(payload) ?? readLastActiveSession();
      if (sessionKey) {
        const session = readSession(sessionKey);
        if (session) {
          if (session.active_execution_item_id) {
            const execDoing = doing?.id ?? null;
            if (session.active_execution_item_id !== execDoing) {
              lines.push(`WARNING: session hints active item '${session.active_execution_item_id}' but execution.json shows '${execDoing ?? 'none'}'. Trust execution.json.`);
            }
          }
        }
      }
    }
  }

  // pending_acceptance stage: surface confirmation hint
  if (proposal.stage === 'pending_acceptance') {
    const sessionKey = resolveSessionKey(payload) ?? readLastActiveSession();
    if (sessionKey) {
      const session = readSession(sessionKey);
      if (session?.pending_user_confirmation) {
        lines.push('');
        lines.push('Session hint: pending_user_confirmation=true. User must run `accept` to proceed.');
      }
    }
  }

  lines.push('');
  lines.push('CLI: node .vflow/scripts/dist/proposal.js <command>');
  lines.push('</vflow-prompt>');
  process.stdout.write(lines.join('\n') + '\n');
}

// --- Entrypoint ---

const mode = process.argv[2];
let payload: Record<string, unknown> | undefined;

// Read stdin payload if available (non-blocking)
try {
  const stdin = readFileSync(0, 'utf-8').trim();
  if (stdin) payload = JSON.parse(stdin);
} catch {
  // No stdin or invalid JSON — that's fine
}

if (mode === 'session') {
  injectSession();
} else if (mode === 'prompt') {
  injectPrompt(payload);
} else {
  console.error('Usage: inject.js <session|prompt>');
  process.exit(1);
}
