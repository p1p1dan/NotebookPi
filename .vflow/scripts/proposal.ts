#!/usr/bin/env node
// proposal.ts — CLI entry point for the vflow2 proposal system.

import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { isoNow, todayCompact, PROPOSALS_DIR, KNOWLEDGE_DIR, loadConfig } from './lib/config.js';
import { STAGES } from './lib/schema.js';
import type {
  Proposal, Stage, LifecycleStatus, ProposalType, Tier, ItemStatus,
  ExecutionArtifact, ExecutionItem, VflowEvent, RepoIndexEntry,
  AnalysisArtifact, DesignArtifact, PlanArtifact, VerifyArtifact, SpecReview,
} from './lib/schema.js';
import {
  nextProposalId, proposalDir, findProposalDir,
  readProposal, writeProposal, readArtifact, writeArtifact,
  appendEvent, readEvents, readRepoIndex, upsertRepoIndex, removeFromIndex,
  readExecution, readyItems, activeItem, findItem, setItemStatus, detectCycle,
} from './lib/store.js';
import {
  canAdvance, canArchive, nextStage, canTransitionItem, canBack,
} from './lib/checks.js';
import {
  resolveCliProposalId, bindSession, resolveSessionKey,
  readLastActiveSession, updateSessionExecutionItem, updateSessionConfirmation,
} from './lib/session-runtime.js';

// --- Arg parsing ---

// 用户验收闸门。三条通道(优先级从高到低):
// 1. userApproved=true —— AI 在对话内已取得用户明确同意,转达执行(caller 把事件
//    from 记成 ai_relay,留痕可审计)。这是 AI 的正路:先暂停汇报征询,拿到用户对话
//    同意后带 --user-approved 重跑,而不是傻乎乎让用户滚去命令行自己敲。
// 2. TTY 交互 yes/no —— 用户自己在终端跑命令时亲自确认。
// 3. 非 TTY 读 stdin —— 测试/CI 与高级用户用管道喂 "yes" 的通道。
async function confirmByUser(prompt: string, userApproved = false): Promise<boolean> {
  if (userApproved) return true;
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>(resolve => {
      rl.question(`${prompt} (yes/no): `, ans => { rl.close(); resolve(ans.trim().toLowerCase()); });
    });
    return answer === 'yes' || answer === 'y';
  }
  try {
    const data = await new Promise<string>((resolve, reject) => {
      let buf = '';
      const timeout = setTimeout(() => { process.stdin.removeAllListeners(); reject(new Error('timeout')); }, 200);
      process.stdin.setEncoding('utf-8');
      process.stdin.on('data', (chunk: string) => {
        buf += chunk;
        if (buf.includes('\n')) {
          clearTimeout(timeout);
          process.stdin.removeAllListeners();
          resolve(buf.split('\n')[0].trim().toLowerCase());
        }
      });
      process.stdin.on('end', () => {
        clearTimeout(timeout);
        process.stdin.removeAllListeners();
        resolve(buf.trim().toLowerCase());
      });
      process.stdin.on('error', () => {
        clearTimeout(timeout);
        reject(new Error('stdin error'));
      });
      process.stdin.resume();
    });
    return data === 'yes' || data === 'y';
  } catch { return false; }
}

// --- Arg parsing helper ---

function parseArgs(args: string[]): { cmd: string; sub?: string; positional: string[]; flags: Record<string, string> } {
  const cmd = args[0] ?? '';
  const sub = args[1] && !args[1].startsWith('--') ? args[1] : undefined;
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  const startIdx = sub ? 2 : 1;
  for (let i = startIdx; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const [key, ...rest] = a.slice(2).split('=');
      flags[key] = rest.length ? rest.join('=') : (args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : 'true');
    } else {
      positional.push(a);
    }
  }
  return { cmd, sub, positional, flags };
}

// --- Resolve current proposal ---

function resolveProposal(flags: Record<string, string>): { dir: string; proposal: Proposal } | null {
  let id: string | null = flags['id'] ?? null;
  if (!id) {
    const repoFallback = () => {
      const index = readRepoIndex();
      const active = index.proposals.filter(p => p.lifecycle_status === 'active');
      return active.length === 1 ? active[0].id : null;
    };
    const resolved = resolveCliProposalId(repoFallback);
    id = resolved.id;
  }
  if (!id) { console.log('No active proposal. Use --id or create one.'); return null; }
  const dir = findProposalDir(id);
  if (!dir) { console.log(`Proposal directory not found for '${id}'.`); return null; }
  const proposal = readProposal(dir);
  if (!proposal) { console.log(`Cannot read proposal.json in '${dir}'.`); return null; }
  return { dir, proposal };
}

// --- Commands ---

function cmdCreate(positional: string[], flags: Record<string, string>): void {
  const slug = positional[0] ?? flags['slug'];
  if (!slug) { console.log('Usage: create <slug> --title "..." --type feature --tier T2'); return; }
  const title = flags['title'] ?? slug;
  const type = (flags['type'] ?? 'feature') as ProposalType;
  const tier = (flags['tier'] ?? 'T2') as Tier;

  const id = nextProposalId();
  const dir = proposalDir(id, slug);
  mkdirSync(dir, { recursive: true });

  const proposal: Proposal = {
    id, title, slug,
    stage: 'intake',
    lifecycle_status: 'active',
    blocking: { status: 'none' },
    tier, type,
    workspace: { isolate_intent: false, branch: null },
    created_at: isoNow(),
    updated_at: isoNow(),
    schema_version: 1,
  };
  writeProposal(dir, proposal);

  const event: VflowEvent = { ts: isoNow(), type: 'proposal_created', detail: `${id} ${title}` };
  appendEvent(dir, event);

  const entry: RepoIndexEntry = {
    id, slug, dir: basename(dir), title,
    stage: 'intake', lifecycle_status: 'active', type, updated_at: isoNow(),
  };
  upsertRepoIndex(entry);

  // Bind session
  const sessionKey = resolveSessionKey(undefined) ?? readLastActiveSession();
  if (sessionKey) bindSession(sessionKey, id);

  console.log(`Created proposal ${id} (${slug}) [${tier}/${type}]`);
}

function cmdContinue(flags: Record<string, string>): void {
  const resolved = resolveProposal(flags);
  if (!resolved) return;
  const sessionKey = resolveSessionKey(undefined) ?? readLastActiveSession();
  if (sessionKey) {
    bindSession(sessionKey, resolved.proposal.id);
    console.log(`Session bound to ${resolved.proposal.id}`);
  } else {
    console.log('Cannot determine session key.');
  }
}

function cmdStatus(flags: Record<string, string>): void {
  const resolved = resolveProposal(flags);
  if (!resolved) return;
  const { proposal, dir } = resolved;
  console.log(`Proposal: ${proposal.id} — ${proposal.title}`);
  console.log(`  Stage: ${proposal.stage} | Lifecycle: ${proposal.lifecycle_status} | Tier: ${proposal.tier} | Type: ${proposal.type}`);
  if (proposal.blocking.status === 'blocked') {
    console.log(`  Blocked: ${proposal.blocking.reason ?? 'unknown'}`);
  }
  if (proposal.stage === 'execution') {
    const exec = readExecution(dir);
    if (exec) {
      const doing = activeItem(exec);
      const ready = readyItems(exec);
      const done = exec.items.filter(i => i.status === 'done').length;
      console.log(`  Execution: ${done}/${exec.items.length} done | Active: ${doing?.id ?? 'none'} | Ready: ${ready.map(i => i.id).join(', ') || 'none'}`);
    }
  }
}

function cmdList(): void {
  const index = readRepoIndex();
  if (index.proposals.length === 0) { console.log('No proposals.'); return; }
  for (const p of index.proposals) {
    console.log(`  ${p.id} [${p.stage}/${p.lifecycle_status}] ${p.title}`);
  }
}

const FORCE_ALLOWED_TARGETS: Set<string> = new Set(['analysis', 'design', 'plan', 'execution']);

async function cmdAdvance(flags: Record<string, string>): Promise<void> {
  const resolved = resolveProposal(flags);
  if (!resolved) return;
  const { dir, proposal } = resolved;
  const force = flags['force'] === 'true';

  const check = canAdvance(dir, proposal);
  const next = nextStage(proposal.stage);
  if (!next) { console.log('Already at final stage.'); return; }

  if (proposal.stage === 'done') {
    console.log('Cannot advance from done. Use `archive` command to archive the proposal.');
    return;
  }

  if (!check.ok && !force) {
    console.log(`Cannot advance from '${proposal.stage}':`);
    for (const e of check.errors) console.log(`  - ${e}`);
    return;
  }

  if (!check.ok && force) {
    if (!FORCE_ALLOWED_TARGETS.has(next)) {
      console.log(`Cannot force-advance to '${next}'. Force is only allowed for early stages (up to execution).`);
      return;
    }
    const reason = flags['reason'];
    if (!reason) {
      console.log('--reason is required for force advance.');
      return;
    }
    if (!await confirmByUser(`Force advance ${proposal.stage}→${next} despite gate errors?`)) {
      console.log('Force advance cancelled.');
      return;
    }
    console.log(`Force advancing despite errors:`);
    for (const e of check.errors) console.log(`  - ${e}`);
    appendEvent(dir, { ts: isoNow(), type: 'gate_bypassed', from: proposal.stage, to: next, detail: reason });
  }

  const prev = proposal.stage;
  proposal.stage = next;
  writeProposal(dir, proposal);

  appendEvent(dir, { ts: isoNow(), type: 'stage_changed', from: prev, to: next });
  upsertRepoIndex({
    id: proposal.id, slug: proposal.slug, dir: basename(dir), title: proposal.title,
    stage: next, lifecycle_status: proposal.lifecycle_status, type: proposal.type, updated_at: isoNow(),
  });

  if (next === 'pending_acceptance') {
    const sk = resolveSessionKey(undefined) ?? readLastActiveSession();
    if (sk) updateSessionConfirmation(sk, true);
  }

  console.log(`Advanced: ${prev} → ${next}`);
}

function cmdBack(flags: Record<string, string>): void {
  const resolved = resolveProposal(flags);
  if (!resolved) return;
  const { dir, proposal } = resolved;
  const to = flags['to'] as Stage | undefined;

  if (!to) { console.log('Usage: back --to <stage>'); return; }
  const result = canBack(proposal, to as any);
  if (!result.ok) { console.log(result.error); return; }

  const prev = proposal.stage;

  // verify→execution: reopen done items only if there are failed checks
  if (prev === 'verify' && to === 'execution') {
    const exec = readExecution(dir);
    const verify = readArtifact<VerifyArtifact>(dir, 'verify');
    if (exec && verify) {
      const currentRound = verify.verify_round ?? 1;
      const evts = readEvents(dir);
      const waiverIds = new Set(evts.filter(e => e.type === 'waiver_granted' && (e.verify_round ?? 1) >= currentRound).map(e => e.item_id));
      const failedCheckIds = verify.results.filter(r => !r.passed && !waiverIds.has(r.id)).map(r => r.id);
      let reopened = 0;
      if (failedCheckIds.length > 0) {
        const doneItems = exec.items.filter(i => i.status === 'done');
        for (const item of doneItems) {
          item.status = 'todo';
          reopened++;
          appendEvent(dir, {
            ts: isoNow(), type: 'item_status_changed',
            item_id: item.id, from: 'done', to: 'todo',
            detail: `Reopened due to verify failure: ${failedCheckIds.join(', ')}`,
          });
        }
      }
      // Increment verify_round for next cycle
      verify.verify_round = currentRound + 1;
      writeArtifact(dir, 'verify', verify);
      writeArtifact(dir, 'execution', exec);
      if (reopened > 0) {
        console.log(`Reopened ${reopened} execution item(s) for rework.`);
      } else {
        console.log('No failed checks — no items reopened.');
      }
    }
  }

  proposal.stage = to;
  writeProposal(dir, proposal);
  appendEvent(dir, { ts: isoNow(), type: 'stage_changed', from: prev, to, detail: 'back' });
  upsertRepoIndex({
    id: proposal.id, slug: proposal.slug, dir: basename(dir), title: proposal.title,
    stage: to, lifecycle_status: proposal.lifecycle_status, type: proposal.type, updated_at: isoNow(),
  });
  // Session runtime cleanup on back transitions
  const sk = resolveSessionKey(undefined) ?? readLastActiveSession();
  if (sk) {
    if (to === 'execution') updateSessionExecutionItem(sk, null);
    if (prev === 'pending_acceptance') updateSessionConfirmation(sk, false);
  }

  console.log(`Back: ${prev} → ${to}`);
}

function cmdSet(sub: string | undefined, flags: Record<string, string>): void {
  const resolved = resolveProposal(flags);
  if (!resolved) return;
  const { dir, proposal } = resolved;
  const value = flags['value'] ?? flags['to'] ?? Object.values(flags).find(v => v !== 'true' && v !== resolved.proposal.id);

  switch (sub) {
    case 'tier': {
      if (!value) { console.log('Usage: set tier --value T1'); return; }
      const prev = proposal.tier;
      proposal.tier = value as Tier;
      writeProposal(dir, proposal);
      appendEvent(dir, { ts: isoNow(), type: 'tier_changed', from: prev, to: value });
      console.log(`Tier: ${prev} → ${value}`);
      break;
    }
    case 'type': {
      if (!value) { console.log('Usage: set type --value bug'); return; }
      const prev = proposal.type;
      proposal.type = value as ProposalType;
      writeProposal(dir, proposal);
      appendEvent(dir, { ts: isoNow(), type: 'type_changed', from: prev, to: value });
      console.log(`Type: ${prev} → ${value}`);
      break;
    }
    case 'lifecycle': {
      if (!value) { console.log('Usage: set lifecycle --value on_hold'); return; }
      const prev = proposal.lifecycle_status;
      proposal.lifecycle_status = value as LifecycleStatus;
      writeProposal(dir, proposal);
      appendEvent(dir, { ts: isoNow(), type: 'lifecycle_changed', from: prev, to: value });
      upsertRepoIndex({
        id: proposal.id, slug: proposal.slug, dir: basename(dir), title: proposal.title,
        stage: proposal.stage, lifecycle_status: proposal.lifecycle_status, type: proposal.type, updated_at: isoNow(),
      });
      console.log(`Lifecycle: ${prev} → ${value}`);
      break;
    }
    case 'blocking': {
      const reason = flags['reason'] ?? '';
      const type = flags['type'] ?? 'generic';
      if (value === 'none') {
        proposal.blocking = { status: 'none' };
      } else {
        proposal.blocking = { status: 'blocked', type, reason, since: isoNow() };
      }
      writeProposal(dir, proposal);
      appendEvent(dir, { ts: isoNow(), type: 'blocking_changed', detail: JSON.stringify(proposal.blocking) });
      console.log(`Blocking: ${JSON.stringify(proposal.blocking)}`);
      break;
    }
    default:
      console.log('Usage: set <tier|type|lifecycle|blocking> --value ...');
  }
}

function cmdExecution(sub: string | undefined, positional: string[], flags: Record<string, string>): void {
  const resolved = resolveProposal(flags);
  if (!resolved) return;
  const { dir, proposal } = resolved;

  let exec = readExecution(dir) ?? { items: [] };

  switch (sub) {
    case 'add-item': {
      const title = flags['title'] ?? positional[0];
      if (!title) { console.log('Usage: execution add-item --title "..." [--depends ...]'); return; }
      const id = `E-${String(exec.items.length + 1).padStart(3, '0')}`;
      const depends = flags['depends'] ? flags['depends'].split(',') : [];
      const item: ExecutionItem = { id, title, status: 'todo', depends_on: depends, evidence: [] };
      exec.items.push(item);
      writeArtifact(dir, 'execution', exec);
      appendEvent(dir, { ts: isoNow(), type: 'item_added', item_id: id, detail: title });
      console.log(`Added item ${id}: ${title}`);
      break;
    }
    case 'start-item': {
      const itemId = flags['item'] ?? positional[0];
      if (!itemId) { console.log('Usage: execution start-item --item E-001'); return; }
      const check = canTransitionItem(exec, itemId, 'doing');
      if (!check.ok) { console.log(check.error); return; }
      setItemStatus(exec, itemId, 'doing');
      writeArtifact(dir, 'execution', exec);
      appendEvent(dir, { ts: isoNow(), type: 'item_status_changed', item_id: itemId, from: 'todo', to: 'doing' });
      const sk = resolveSessionKey(undefined) ?? readLastActiveSession();
      if (sk) updateSessionExecutionItem(sk, itemId);
      console.log(`Started item ${itemId}`);
      break;
    }
    case 'complete-item': {
      const itemId = flags['item'] ?? positional[0];
      if (!itemId) { console.log('Usage: execution complete-item --item E-001 [--evidence "..."]'); return; }
      const check = canTransitionItem(exec, itemId, 'done');
      if (!check.ok) { console.log(check.error); return; }
      const item = findItem(exec, itemId)!;
      if (flags['evidence']) item.evidence.push(flags['evidence']);
      setItemStatus(exec, itemId, 'done');
      writeArtifact(dir, 'execution', exec);
      appendEvent(dir, { ts: isoNow(), type: 'item_status_changed', item_id: itemId, from: 'doing', to: 'done', detail: flags['evidence'] || undefined });
      const sk2 = resolveSessionKey(undefined) ?? readLastActiveSession();
      if (sk2) updateSessionExecutionItem(sk2, null);
      console.log(`Completed item ${itemId}`);
      break;
    }
    case 'block-item': {
      const itemId = flags['item'] ?? positional[0];
      if (!itemId) { console.log('Usage: execution block-item --item E-001 [--reason "..."]'); return; }
      const check = canTransitionItem(exec, itemId, 'blocked');
      if (!check.ok) { console.log(check.error); return; }
      const item = findItem(exec, itemId)!;
      if (flags['reason']) item.note = flags['reason'];
      setItemStatus(exec, itemId, 'blocked');
      writeArtifact(dir, 'execution', exec);
      appendEvent(dir, { ts: isoNow(), type: 'item_status_changed', item_id: itemId, from: 'doing', to: 'blocked' });
      const sk3 = resolveSessionKey(undefined) ?? readLastActiveSession();
      if (sk3) updateSessionExecutionItem(sk3, null);
      console.log(`Blocked item ${itemId}`);
      break;
    }
    case 'cancel-item': {
      const itemId = flags['item'] ?? positional[0];
      if (!itemId) { console.log('Usage: execution cancel-item --item E-001'); return; }
      const check = canTransitionItem(exec, itemId, 'cancelled');
      if (!check.ok) { console.log(check.error); return; }
      const prev = findItem(exec, itemId)!.status;
      setItemStatus(exec, itemId, 'cancelled');
      writeArtifact(dir, 'execution', exec);
      appendEvent(dir, { ts: isoNow(), type: 'item_cancelled', item_id: itemId, from: prev, to: 'cancelled' });
      if (prev === 'doing') {
        const sk4 = resolveSessionKey(undefined) ?? readLastActiveSession();
        if (sk4) updateSessionExecutionItem(sk4, null);
      }
      console.log(`Cancelled item ${itemId}`);
      break;
    }
    default:
      console.log('Usage: execution <add-item|start-item|complete-item|block-item|cancel-item>');
  }
}

// Path B: an un-waived CRITICAL spec-review finding blocks gating.
function hasBlockingSpecReview(verify: VerifyArtifact): boolean {
  const sr = verify.spec_review;
  if (!sr || !sr.findings) return false;
  return sr.findings.some(f => f.level === 'CRITICAL' && !f.waived);
}

function cmdVerifyRun(flags: Record<string, string>): void {
  const resolved = resolveProposal(flags);
  if (!resolved) return;
  const { dir, proposal } = resolved;

  const plan = readArtifact<PlanArtifact>(dir, 'plan');
  if (!plan || !plan.verify_plan) { console.log('No verify plan in plan.json'); return; }

  // Read existing verify.json or create skeleton with all checks NOT passed
  let verify = readArtifact<VerifyArtifact>(dir, 'verify');
  if (!verify) {
    verify = {
      results: plan.verify_plan.checks.map(c => ({
        id: c.id, passed: false, evidence: '',
      })),
      all_gating_passed: false,
      verify_round: 1,
    };
    writeArtifact(dir, 'verify', verify);
    console.log(`Verify skeleton created with ${verify.results.length} checks (all pending).`);
    console.log('Fill each check with: verify check --check <id> --passed --evidence "..."');
    console.log('Or mark failed: verify check --check <id> --failed --evidence "reason"');
    return;
  }

  // Recompute all_gating_passed from plan checks as master list
  const gatingChecks = plan.verify_plan.checks.filter(c => c.gating);
  const events = readEvents(dir);
  const currentRound = verify.verify_round ?? 1;
  const waiverIds = new Set(events.filter(e => e.type === 'waiver_granted' && (e.verify_round ?? 1) >= currentRound).map(e => e.item_id));
  const allGatingPassed = gatingChecks.every(c => {
    const r = verify.results.find(res => res.id === c.id);
    return (r && r.passed) || waiverIds.has(c.id);
  }) && !hasBlockingSpecReview(verify);
  verify.all_gating_passed = allGatingPassed;
  writeArtifact(dir, 'verify', verify);

  const gatingIds = new Set(gatingChecks.map(c => c.id));
  const pending = verify.results.filter(r => !r.passed && !waiverIds.has(r.id));
  if (pending.length) {
    console.log(`Verify: ${pending.length} checks still not passed:`);
    for (const r of pending) {
      const isGating = gatingIds.has(r.id) ? ' [GATING]' : '';
      console.log(`  - ${r.id}${isGating}: ${r.evidence || '(no evidence)'}`);
    }
  }
  if (hasBlockingSpecReview(verify)) {
    const crit = verify.spec_review!.findings.filter(f => f.level === 'CRITICAL' && !f.waived);
    console.log(`Spec review: ${crit.length} un-waived CRITICAL finding(s) [GATING]:`);
    for (const f of crit) {
      console.log(`  - ${f.file}${f.line ? `:${f.line}` : ''} (${f.dimension}): ${f.issue}${f.spec_ref ? ` [${f.spec_ref}]` : ''}`);
    }
  }
  appendEvent(dir, { ts: isoNow(), type: 'verify_completed', detail: `all_gating_passed=${allGatingPassed}` });
  console.log(`Verify run complete. all_gating_passed=${allGatingPassed}`);
}

function cmdVerifyCheck(flags: Record<string, string>): void {
  const resolved = resolveProposal(flags);
  if (!resolved) return;
  const { dir } = resolved;

  const checkId = flags['check'] ?? flags['check-id'];
  if (!checkId) { console.log('Usage: verify check --check V1 --passed --evidence "..."'); return; }

  let verify = readArtifact<VerifyArtifact>(dir, 'verify');
  if (!verify) { console.log('No verify.json. Run `verify run` first to create skeleton.'); return; }

  const result = verify.results.find(r => r.id === checkId);
  if (!result) { console.log(`Check '${checkId}' not found in verify.json.`); return; }

  const passed = flags['passed'] === 'true' || flags['passed'] === '';
  const failed = flags['failed'] === 'true' || flags['failed'] === '';
  if (!passed && !failed) { console.log('Specify --passed or --failed.'); return; }

  result.passed = passed && !failed;
  if (flags['evidence']) result.evidence = flags['evidence'];

  // Recompute all_gating_passed
  const plan = readArtifact<PlanArtifact>(dir, 'plan');
  if (plan?.verify_plan) {
    const events = readEvents(dir);
    const currentRound = verify.verify_round ?? 1;
    const waiverIds = new Set(events.filter(e => e.type === 'waiver_granted' && (e.verify_round ?? 1) >= currentRound).map(e => e.item_id));
    verify.all_gating_passed = plan.verify_plan.checks
      .filter(c => c.gating)
      .every(c => {
        const r = verify.results.find(res => res.id === c.id);
        return (r && r.passed) || waiverIds.has(c.id);
      }) && !hasBlockingSpecReview(verify);
  }

  writeArtifact(dir, 'verify', verify);
  appendEvent(dir, { ts: isoNow(), type: 'verify_result_recorded', item_id: checkId, detail: result.passed ? 'passed' : 'failed' });
  console.log(`Check ${checkId}: ${result.passed ? 'PASSED' : 'FAILED'}${result.waiver ? ' (waiver)' : ''}`);
}

async function cmdVerifyWaive(flags: Record<string, string>): Promise<void> {
  const resolved = resolveProposal(flags);
  if (!resolved) return;
  const { dir } = resolved;

  const checkId = flags['check'] ?? flags['check-id'];
  if (!checkId) { console.log('Usage: verify waive --check V1 --reason "..."'); return; }
  const reason = flags['reason'] ?? '';
  if (!reason) { console.log('--reason is required for waiver.'); return; }

  const verify = readArtifact<VerifyArtifact>(dir, 'verify');
  if (!verify) { console.log('No verify.json. Run `verify run` first.'); return; }
  const result = verify.results.find(r => r.id === checkId);
  if (!result) { console.log(`Check '${checkId}' not found in verify.json.`); return; }
  if (result.passed) { console.log(`Check '${checkId}' already passed — no waiver needed.`); return; }

  const userApproved = flags['user-approved'] === 'true';
  if (!await confirmByUser(`Waive check ${checkId}? Reason: ${reason}`, userApproved)) {
    console.log('REJECTED: waiver must be confirmed by user.');
    console.log('AI: explain to the user why this check should be waived and ask; after in-conversation approval, rerun `verify waive --check ... --reason ... --user-approved`.');
    return;
  }

  result.waiver = reason;

  const plan = readArtifact<PlanArtifact>(dir, 'plan');
  if (plan?.verify_plan) {
    const events = readEvents(dir);
    const currentRound = verify.verify_round ?? 1;
    const waiverIds = new Set(events.filter(e => e.type === 'waiver_granted' && (e.verify_round ?? 1) >= currentRound).map(e => e.item_id));
    waiverIds.add(checkId);
    verify.all_gating_passed = plan.verify_plan.checks
      .filter(c => c.gating)
      .every(c => {
        const r = verify.results.find(res => res.id === c.id);
        return (r && r.passed) || waiverIds.has(c.id);
      }) && !hasBlockingSpecReview(verify);
  }

  writeArtifact(dir, 'verify', verify);
  const via = userApproved ? 'ai_relay' : (process.stdin.isTTY ? 'tty_prompt' : 'stdin_pipe');
  appendEvent(dir, {
    ts: isoNow(), type: 'waiver_granted', item_id: checkId,
    detail: `reason=${reason},confirmed_by_user=true,via=${via}`,
    verify_round: verify.verify_round ?? 1,
  });
  console.log(`Waiver granted for ${checkId}: ${reason}`);
  console.log(`all_gating_passed=${verify.all_gating_passed}`);
}

// Path B: record/recompute the three-dimensional spec review. The AI writes
// verify.json's `spec_review` block (scope_files + graded findings) directly,
// then runs this to mark it reviewed, recompute gating, and print a summary.
// An un-waived CRITICAL finding forces all_gating_passed=false.
function cmdVerifyReview(flags: Record<string, string>): void {
  const resolved = resolveProposal(flags);
  if (!resolved) return;
  const { dir } = resolved;

  const verify = readArtifact<VerifyArtifact>(dir, 'verify');
  if (!verify) { console.log('No verify.json. Run `verify run` first to create skeleton.'); return; }

  if (!verify.spec_review) {
    console.log('No spec_review block in verify.json. Add it first, e.g.:');
    console.log('  "spec_review": { "reviewed": true, "scope_files": ["a.ts"],');
    console.log('    "findings": [{ "level": "CRITICAL", "dimension": "consistency",');
    console.log('      "file": "a.ts", "line": 42, "issue": "...", "spec_ref": "cpp.md#57" }] }');
    console.log('Levels: CRITICAL|WARNING|SUGGESTION. Dimensions: completeness|correctness|consistency.');
    return;
  }

  const sr: SpecReview = verify.spec_review;
  sr.reviewed = true;

  // Recompute gating from plan checks + spec review.
  const plan = readArtifact<PlanArtifact>(dir, 'plan');
  if (plan?.verify_plan) {
    const events = readEvents(dir);
    const currentRound = verify.verify_round ?? 1;
    const waiverIds = new Set(events.filter(e => e.type === 'waiver_granted' && (e.verify_round ?? 1) >= currentRound).map(e => e.item_id));
    verify.all_gating_passed = plan.verify_plan.checks
      .filter(c => c.gating)
      .every(c => {
        const r = verify.results.find(res => res.id === c.id);
        return (r && r.passed) || waiverIds.has(c.id);
      }) && !hasBlockingSpecReview(verify);
  }
  writeArtifact(dir, 'verify', verify);

  const counts = { CRITICAL: 0, WARNING: 0, SUGGESTION: 0 };
  for (const f of sr.findings) counts[f.level]++;
  const unwaivedCrit = sr.findings.filter(f => f.level === 'CRITICAL' && !f.waived).length;
  appendEvent(dir, {
    ts: isoNow(), type: 'spec_review_recorded',
    detail: `files=${sr.scope_files.length},CRITICAL=${counts.CRITICAL},WARNING=${counts.WARNING},SUGGESTION=${counts.SUGGESTION},unwaived_critical=${unwaivedCrit}`,
    verify_round: verify.verify_round ?? 1,
  });
  console.log(`Spec review recorded: ${sr.scope_files.length} files | ${counts.CRITICAL} CRITICAL / ${counts.WARNING} WARNING / ${counts.SUGGESTION} SUGGESTION`);
  if (unwaivedCrit > 0) {
    console.log(`${unwaivedCrit} un-waived CRITICAL → all_gating_passed=false (gating). Fix or waive before advancing.`);
  } else {
    console.log(`No un-waived CRITICAL. all_gating_passed=${verify.all_gating_passed}`);
  }
}

async function cmdAccept(flags: Record<string, string>): Promise<void> {
  const resolved = resolveProposal(flags);
  if (!resolved) return;
  const { dir, proposal } = resolved;

  if (proposal.stage !== 'pending_acceptance') {
    console.log(`Cannot accept: proposal is at '${proposal.stage}', expected 'pending_acceptance'.`);
    return;
  }

  const userApproved = flags['user-approved'] === 'true';
  if (!await confirmByUser(`Accept proposal ${proposal.id} "${proposal.title}"?`, userApproved)) {
    console.log('REJECTED: accept must be confirmed by user.');
    console.log('AI: pause first. Report goal / current state / diff-from-goal / verification results / risks to the user and ask. Only after explicit in-conversation approval, rerun `accept --user-approved` (logged as ai_relay). The user may also run `accept` in a terminal to confirm interactively.');
    return;
  }

  const via = userApproved ? 'ai_relay' : (process.stdin.isTTY ? 'tty_prompt' : 'stdin_pipe');
  const verify = readArtifact<VerifyArtifact>(dir, 'verify');
  const round = verify?.verify_round ?? 1;
  appendEvent(dir, { ts: isoNow(), type: 'acceptance', detail: 'confirmed_by_user:true', from: via, verify_round: round });
  appendEvent(dir, { ts: isoNow(), type: 'stage_changed', from: 'pending_acceptance', to: 'done' });
  proposal.stage = 'done';
  proposal.lifecycle_status = 'done';
  writeProposal(dir, proposal);
  upsertRepoIndex({
    id: proposal.id, slug: proposal.slug, dir: basename(dir), title: proposal.title,
    stage: 'done', lifecycle_status: 'done', type: proposal.type, updated_at: isoNow(),
  });

  const skAccept = resolveSessionKey(undefined) ?? readLastActiveSession();
  if (skAccept) updateSessionConfirmation(skAccept, false);

  console.log(`Accepted. Proposal ${proposal.id} is now done.`);
}

function cmdArchive(flags: Record<string, string>): void {
  const resolved = resolveProposal(flags);
  if (!resolved) return;
  const { dir, proposal } = resolved;

  const gate = canArchive(dir, proposal);
  if (!gate.ok) {
    console.log('Cannot archive:');
    for (const e of gate.errors) console.log(`  - ${e}`);
    return;
  }

  import('./lib/derive.js').then(({ archiveProposal }) => {
    archiveProposal(dir, proposal, flags['html'] === 'true');
  });
}

async function cmdConfirmDesign(flags: Record<string, string>): Promise<void> {
  const resolved = resolveProposal(flags);
  if (!resolved) return;
  const { dir, proposal } = resolved;

  if (proposal.stage !== 'design') {
    console.log(`Cannot confirm design: proposal is at '${proposal.stage}', expected 'design'.`);
    return;
  }
  if (proposal.tier !== 'T3') {
    console.log('Design confirmation is only required for T3 proposals.');
    return;
  }

  const design = readArtifact<import('./lib/schema.js').DesignArtifact>(dir, 'design');
  if (!design || design.decisions.length === 0) {
    console.log('No design decisions found. Write design.json first.');
    return;
  }

  console.log('Design decisions to confirm:');
  for (const d of design.decisions) {
    console.log(`  ${d.id}: ${d.decision} — ${d.rationale}`);
  }

  const userApproved = flags['user-approved'] === 'true';
  if (!await confirmByUser(`Confirm design for T3 proposal ${proposal.id}?`, userApproved)) {
    console.log('Design confirmation cancelled. AI: present the design decisions to the user and ask; after in-conversation approval, rerun `confirm-design --user-approved`.');
    return;
  }

  const via = userApproved ? 'ai_relay' : (process.stdin.isTTY ? 'tty_prompt' : 'stdin_pipe');
  const designContent = readFileSync(join(dir, 'design.json'), 'utf-8');
  const designHash = createHash('sha256').update(designContent).digest('hex');
  appendEvent(dir, { ts: isoNow(), type: 'design_confirmed', detail: `confirmed_by_user:true,via=${via},design_hash=${designHash}` });
  console.log('Design confirmed. You can now advance to plan.');
}

function cmdTrace(flags: Record<string, string>): void {
  const resolved = resolveProposal(flags);
  if (!resolved) return;
  const { dir } = resolved;
  const events = readEvents(dir);
  if (events.length === 0) { console.log('No events.'); return; }
  for (const e of events) {
    const parts = [e.ts, e.type];
    if (e.from || e.to) parts.push(`${e.from ?? ''}→${e.to ?? ''}`);
    if (e.item_id) parts.push(`[${e.item_id}]`);
    if (e.detail) parts.push(e.detail);
    console.log(`  ${parts.join(' | ')}`);
  }
}

function cmdKnowledge(sub: string | undefined, flags: Record<string, string>): void {
  if (sub === 'suggest') {
    const resolved = resolveProposal(flags);
    if (!resolved) return;
    import('./lib/derive.js').then(({ knowledgeSuggest }) => {
      const candidates = knowledgeSuggest(resolved.dir);
      if (candidates.length === 0) {
        console.log('No knowledge candidates found. Marking as processed.');
        resolved.proposal.knowledge_processed = true;
        writeProposal(resolved.dir, resolved.proposal);
        return;
      }
      console.log('Knowledge candidates:');
      for (let i = 0; i < candidates.length; i++) {
        console.log(`  ${i + 1}. ${candidates[i]}`);
      }
      console.log('\nUse `knowledge save --content "..." --reason "..."` to persist.');
      console.log('Or `knowledge skip` if no candidates are worth keeping.');
    });
  } else if (sub === 'save') {
    const resolved = resolveProposal(flags);
    if (!resolved) return;
    const content = flags['content'];
    const reason = flags['reason'];
    if (!content) { console.log('Usage: knowledge save --content "..." --reason "..."'); return; }
    const config = loadConfig();
    const repoName = config.project || 'default';
    mkdirSync(KNOWLEDGE_DIR, { recursive: true });
    const path = join(KNOWLEDGE_DIR, `${repoName}.md`);
    const entry = `\n## ${isoNow()}\n\n${content}\n\n> Reason: ${reason ?? 'N/A'}\n`;
    appendFileSync(path, entry, 'utf-8');
    resolved.proposal.knowledge_processed = true;
    writeProposal(resolved.dir, resolved.proposal);
    appendEvent(resolved.dir, { ts: isoNow(), type: 'knowledge_saved', detail: content.slice(0, 80) });
    console.log(`Knowledge saved to ${path}`);
  } else if (sub === 'skip') {
    const resolved = resolveProposal(flags);
    if (!resolved) return;
    resolved.proposal.knowledge_processed = true;
    writeProposal(resolved.dir, resolved.proposal);
    appendEvent(resolved.dir, { ts: isoNow(), type: 'knowledge_saved', detail: 'skipped' });
    console.log('Knowledge candidates skipped. Marked as processed.');
  } else {
    console.log('Usage: knowledge <suggest|save|skip>');
  }
}

// --- Main ---

const args = process.argv.slice(2);
const { cmd, sub, positional, flags } = parseArgs(args);

switch (cmd) {
  case 'create': cmdCreate(sub ? [sub, ...positional] : positional, flags); break;
  case 'continue': cmdContinue(flags); break;
  case 'status': cmdStatus(flags); break;
  case 'list': cmdList(); break;
  case 'advance': cmdAdvance(flags).catch(console.error); break;
  case 'back': cmdBack(flags); break;
  case 'set': cmdSet(sub, flags); break;
  case 'execution': cmdExecution(sub, positional, flags); break;
  case 'verify': {
    if (sub === 'run') cmdVerifyRun(flags);
    else if (sub === 'check') cmdVerifyCheck(flags);
    else if (sub === 'waive') cmdVerifyWaive(flags).catch(console.error);
    else if (sub === 'review') cmdVerifyReview(flags);
    else console.log('Usage: verify <run|check|waive|review>');
    break;
  }
  case 'accept': cmdAccept(flags).catch(console.error); break;
  case 'confirm-design': cmdConfirmDesign(flags).catch(console.error); break;
  case 'archive': cmdArchive(flags); break;
  case 'trace': cmdTrace(flags); break;
  case 'knowledge': cmdKnowledge(sub, flags); break;
  default: console.log('Usage: proposal.js <create|continue|status|list|advance|back|set|execution|verify|accept|confirm-design|archive|trace|knowledge>');
}
