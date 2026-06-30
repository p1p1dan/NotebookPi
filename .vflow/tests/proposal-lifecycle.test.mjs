// proposal-lifecycle.test.mjs — 10 invariant tests for vflow2 proposal system.
// Run with: node --test tests/proposal-lifecycle.test.mjs

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = join(__dirname, '..', 'scripts');
const CLI = join(SCRIPTS_DIR, 'dist', 'proposal.js');
const VFLOW_ROOT = join(__dirname, '..');
const PROPOSALS_DIR = join(VFLOW_ROOT, 'proposals');
const REPO_INDEX = join(VFLOW_ROOT, 'repo.json');
const SESSIONS_DIR = join(VFLOW_ROOT, 'runtime', 'sessions');

function run(...args) {
  const lastArg = args[args.length - 1];
  let extraEnv = {};
  let stdinInput = undefined;
  if (lastArg && typeof lastArg === 'object' && !Array.isArray(lastArg)) {
    args.pop();
    if ('input' in lastArg || 'env' in lastArg) {
      stdinInput = lastArg.input;
      extraEnv = lastArg.env || {};
    } else {
      extraEnv = lastArg;
    }
  }
  try {
    return execFileSync('node', [CLI, ...args], {
      cwd: join(VFLOW_ROOT, '..'),
      encoding: 'utf-8',
      input: stdinInput,
      env: { ...process.env, CLAUDE_SESSION_ID: 'test-session-001', ...extraEnv },
    });
  } catch (e) {
    return (e.stdout || '') + '\n' + (e.stderr || '');
  }
}

const TEST_ACCEPT_OPTS = { input: 'yes\n' };

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function writeJson(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

function findDir(id) {
  for (const name of readdirSync(PROPOSALS_DIR)) {
    if (name.startsWith(id)) return join(PROPOSALS_DIR, name);
  }
  return null;
}

function cleanState() {
  if (existsSync(PROPOSALS_DIR)) rmSync(PROPOSALS_DIR, { recursive: true, force: true });
  mkdirSync(PROPOSALS_DIR, { recursive: true });
  mkdirSync(join(PROPOSALS_DIR, 'archive'), { recursive: true });
  if (existsSync(SESSIONS_DIR)) rmSync(SESSIONS_DIR, { recursive: true, force: true });
  writeJson(REPO_INDEX, { schema_version: 1, proposals: [] });
}

function createAndGetDir(slug, opts = {}) {
  const title = opts.title || slug;
  const type = opts.type || 'feature';
  const tier = opts.tier || 'T2';
  const out = run('create', slug, '--title', title, '--type', type, '--tier', tier);
  const id = out.match(/P-\d{8}-\d{3}/)?.[0];
  if (!id) throw new Error(`Failed to create proposal: ${out}`);
  return { id, dir: findDir(id) };
}

function advanceToExecution(dir) {
  writeJson(join(dir, 'analysis.json'), { problem: 'P', scope: 'S', constraints: [], investigation: '' });
  run('advance');
  writeJson(join(dir, 'design.json'), { decisions: [{ id: 'D1', decision: 'D', rationale: 'R', tradeoffs: 'T' }] });
  run('advance');
  writeJson(join(dir, 'plan.json'), { execution_outline: 'O', verify_plan: { checks: [{ id: 'V1', description: 'C', gating: true }], evidence_required: [] } });
  run('advance');
  writeJson(join(dir, 'execution.json'), { items: [{ id: 'E-001', title: 'X', status: 'todo', depends_on: [], evidence: [] }] });
  run('advance');
}

function advanceToDone(dir) {
  advanceToExecution(dir);
  run('execution', 'start-item', '--item', 'E-001');
  run('execution', 'complete-item', '--item', 'E-001', '--evidence', 'done');
  run('advance'); // → verify
  // Use verify check to mark individual checks passed (not auto-pass)
  run('verify', 'run'); // creates skeleton
  run('verify', 'check', '--check', 'V1', '--passed', '--evidence', 'tests pass');
  run('verify', 'run'); // recompute all_gating_passed
  run('advance'); // → pending_acceptance
  run('accept', TEST_ACCEPT_OPTS);
}

describe('vflow2 proposal lifecycle', () => {
  beforeEach(() => cleanState());

  test('1. single proposal full lifecycle intake→archived', () => {
    const { id, dir } = createAndGetDir('test-full', { title: 'Full lifecycle test' });

    writeJson(join(dir, 'analysis.json'), { problem: 'Test problem', scope: 'Test scope', constraints: [], investigation: '' });
    assert.match(run('advance'), /intake → analysis/);

    writeJson(join(dir, 'design.json'), { decisions: [{ id: 'D1', decision: 'Use X', rationale: 'Because', tradeoffs: 'None' }] });
    assert.match(run('advance'), /analysis → design/);

    writeJson(join(dir, 'plan.json'), {
      execution_outline: 'Do things',
      verify_plan: { checks: [{ id: 'V1', description: 'Check it', gating: true }], evidence_required: ['test output'] },
    });
    assert.match(run('advance'), /design → plan/);

    writeJson(join(dir, 'execution.json'), { items: [{ id: 'E-001', title: 'Do it', status: 'todo', depends_on: [], evidence: [] }] });
    assert.match(run('advance'), /plan → execution/);

    assert.match(run('execution', 'start-item', '--item', 'E-001'), /Started item/);
    assert.match(run('execution', 'complete-item', '--item', 'E-001', '--evidence', 'done'), /Completed item/);
    assert.match(run('advance'), /execution → verify/);

    // verify run creates skeleton (all checks pending/false)
    assert.match(run('verify', 'run'), /skeleton created/);

    // Mark check as passed with real evidence
    assert.match(run('verify', 'check', '--check', 'V1', '--passed', '--evidence', 'All tests pass'), /PASSED/);

    // Recompute — now should pass
    assert.match(run('verify', 'run'), /all_gating_passed=true/);
    assert.match(run('advance'), /verify → pending_acceptance/);

    // Cannot advance without accept
    assert.match(run('advance'), /No user acceptance event/);

    // Accept in non-TTY without force-accept should be rejected
    assert.match(run('accept'), /REJECTED.*confirmed/);

    // Accept with force-accept no longer works — must use test env var
    assert.match(run('accept', '--force-accept', 'true'), /REJECTED.*confirmed/);

    // Accept with test env var (replaces --force-accept)
    assert.match(run('accept', TEST_ACCEPT_OPTS), /Accepted/);
    const p = readJson(join(dir, 'proposal.json'));
    assert.equal(p.stage, 'done');

    // Process knowledge before archive
    run('knowledge', 'skip');

    // Archive moves the directory
    run('archive');
    assert.ok(!existsSync(dir), 'Original dir should be moved after archive');
  });

  test('2. stage and item-status do not contaminate each other', () => {
    const { dir } = createAndGetDir('test-sep', { title: 'Separation', type: 'bug', tier: 'T1' });
    advanceToExecution(dir);

    run('execution', 'start-item', '--item', 'E-001');
    let p = readJson(join(dir, 'proposal.json'));
    assert.equal(p.stage, 'execution');

    run('execution', 'complete-item', '--item', 'E-001', '--evidence', 'fixed');
    p = readJson(join(dir, 'proposal.json'));
    assert.equal(p.stage, 'execution');

    const exec = readJson(join(dir, 'execution.json'));
    assert.equal(exec.items[0].status, 'done');
  });

  test('3. session runtime does not overwrite proposal truth', () => {
    const { id, dir } = createAndGetDir('test-session', { title: 'Session test' });

    mkdirSync(SESSIONS_DIR, { recursive: true });
    writeJson(join(SESSIONS_DIR, 'claude_test-session-001.json'), {
      session_id: 'claude_test-session-001',
      active_proposal_id: id,
      active_execution_item_id: 'E-999',
      pending_user_confirmation: true,
      last_seen_at: '2026-01-01T00:00:00',
    });

    const p = readJson(join(dir, 'proposal.json'));
    assert.equal(p.stage, 'intake');
    assert.equal(p.lifecycle_status, 'active');
  });

  test('4. multiple proposals coexist without cross-contamination', () => {
    createAndGetDir('alpha', { title: 'Alpha' });
    createAndGetDir('beta', { title: 'Beta', type: 'bug', tier: 'T1' });

    const index = readJson(REPO_INDEX);
    assert.equal(index.proposals.length, 2);
    assert.notEqual(index.proposals[0].id, index.proposals[1].id);
    assert.equal(index.proposals[0].slug, 'alpha');
    assert.equal(index.proposals[1].slug, 'beta');
  });

  test('5. verify failure blocks advance + back reopens execution items', () => {
    const { dir } = createAndGetDir('test-vfail', { title: 'Verify fail' });
    advanceToExecution(dir);

    run('execution', 'start-item', '--item', 'E-001');
    run('execution', 'complete-item', '--item', 'E-001', '--evidence', 'done');
    run('advance'); // → verify

    // Write failed verify
    writeJson(join(dir, 'verify.json'), { results: [{ id: 'V1', passed: false, evidence: 'failed' }], all_gating_passed: false });

    // Try advance — should be blocked
    assert.match(run('advance'), /all_gating_passed is not true/);

    // Back to execution — should reopen items
    const backResult = run('back', '--to', 'execution');
    assert.match(backResult, /Reopened.*item/);
    assert.match(backResult, /verify → execution/);

    // Verify item was actually reopened
    const exec = readJson(join(dir, 'execution.json'));
    const reopened = exec.items.filter(i => i.status === 'todo');
    assert.ok(reopened.length >= 1, 'At least 1 item should be reopened to todo');
  });

  test('6. accept is rejected in non-TTY (AI cannot independently accept)', () => {
    const { dir } = createAndGetDir('test-noaccept', { title: 'No accept' });
    advanceToExecution(dir);

    run('execution', 'start-item', '--item', 'E-001');
    run('execution', 'complete-item', '--item', 'E-001', '--evidence', 'done');
    run('advance'); // → verify
    run('verify', 'run');
    run('verify', 'check', '--check', 'V1', '--passed', '--evidence', 'ok');
    run('verify', 'run');
    run('advance'); // → pending_acceptance

    // accept without force-accept in non-TTY → rejected
    const result = run('accept');
    assert.match(result, /REJECTED/);

    // Stage remains pending_acceptance
    const p = readJson(join(dir, 'proposal.json'));
    assert.equal(p.stage, 'pending_acceptance');

    // advance also fails (no acceptance event)
    assert.match(run('advance'), /No user acceptance event/);
  });

  test('7. archive derives review.md reproducibly from structured history', async () => {
    const { dir } = createAndGetDir('test-derive', { title: 'Derive test', type: 'refactor' });

    writeJson(join(dir, 'analysis.json'), { problem: 'Refactor X', scope: 'Module Y', constraints: ['time'], investigation: 'Explored' });
    run('advance');
    writeJson(join(dir, 'design.json'), { decisions: [{ id: 'D1', decision: 'Use pattern Z', rationale: 'Clean', tradeoffs: 'Complex' }] });
    run('advance');
    writeJson(join(dir, 'plan.json'), { execution_outline: 'Refactor', verify_plan: { checks: [{ id: 'V1', description: 'Tests pass', gating: true }], evidence_required: ['test'] } });
    run('advance');
    writeJson(join(dir, 'execution.json'), { items: [{ id: 'E-001', title: 'Refactor', status: 'done', depends_on: [], evidence: ['tests pass'] }] });
    run('advance');
    run('verify', 'run');
    run('verify', 'check', '--check', 'V1', '--passed', '--evidence', 'tests pass');
    run('verify', 'run');
    run('advance');
    run('accept', TEST_ACCEPT_OPTS);

    // Derive review twice — should be identical
    const derivePath = pathToFileURL(join(SCRIPTS_DIR, 'dist', 'lib', 'derive.js')).href;
    const derive = await import(derivePath);
    const proposal = readJson(join(dir, 'proposal.json'));
    const review1 = derive.deriveReviewMd(dir, proposal);
    const review2 = derive.deriveReviewMd(dir, proposal);
    assert.equal(review1, review2);
    assert.match(review1, /Refactor X/);
    assert.match(review1, /Use pattern Z/);
  });

  test('8. proposal directory and repo.json stay consistent', () => {
    createAndGetDir('test-consistency', { title: 'Consistency' });

    const index = readJson(REPO_INDEX);
    assert.equal(index.proposals.length, 1);
    const entry = index.proposals[0];
    const dir = join(PROPOSALS_DIR, entry.dir);
    assert.ok(existsSync(dir));
    assert.ok(existsSync(join(dir, 'proposal.json')));

    const p = readJson(join(dir, 'proposal.json'));
    assert.equal(p.id, entry.id);
    assert.equal(p.slug, entry.slug);
    assert.equal(p.stage, entry.stage);
  });

  test('9. serial executor: one doing at a time + dependency enforcement', () => {
    const { dir } = createAndGetDir('test-serial', { title: 'Serial' });

    writeJson(join(dir, 'analysis.json'), { problem: 'P', scope: 'S', constraints: [], investigation: '' });
    run('advance');
    writeJson(join(dir, 'design.json'), { decisions: [{ id: 'D1', decision: 'D', rationale: 'R', tradeoffs: 'T' }] });
    run('advance');
    writeJson(join(dir, 'plan.json'), { execution_outline: 'O', verify_plan: { checks: [{ id: 'V1', description: 'C', gating: true }], evidence_required: [] } });
    run('advance');
    writeJson(join(dir, 'execution.json'), {
      items: [
        { id: 'E-001', title: 'First', status: 'todo', depends_on: [], evidence: [] },
        { id: 'E-002', title: 'Second', status: 'todo', depends_on: ['E-001'], evidence: [] },
      ],
    });
    run('advance');

    // Start E-001
    assert.match(run('execution', 'start-item', '--item', 'E-001'), /Started/);

    // Try to start E-002 while E-001 is doing — serial violation
    assert.match(run('execution', 'start-item', '--item', 'E-002'), /Serial violation|already doing/);

    // Complete E-001, then try E-002 (dependency now met)
    run('execution', 'complete-item', '--item', 'E-001', '--evidence', 'done');
    assert.match(run('execution', 'start-item', '--item', 'E-002'), /Started/);
  });

  test('10. plan→execution gate rejects cyclic DAG', () => {
    const { dir } = createAndGetDir('test-cycle', { title: 'Cycle' });

    writeJson(join(dir, 'analysis.json'), { problem: 'P', scope: 'S', constraints: [], investigation: '' });
    run('advance');
    writeJson(join(dir, 'design.json'), { decisions: [{ id: 'D1', decision: 'D', rationale: 'R', tradeoffs: 'T' }] });
    run('advance');
    writeJson(join(dir, 'plan.json'), { execution_outline: 'O', verify_plan: { checks: [{ id: 'V1', description: 'C', gating: true }], evidence_required: [] } });
    run('advance'); // → plan

    // Write execution with cycle
    writeJson(join(dir, 'execution.json'), {
      items: [
        { id: 'E-001', title: 'A', status: 'todo', depends_on: ['E-002'], evidence: [] },
        { id: 'E-002', title: 'B', status: 'todo', depends_on: ['E-001'], evidence: [] },
      ],
    });

    // Advance should reject
    assert.match(run('advance'), /cycle/i);
  });

  test('11. --force-accept flag no longer bypasses accept gate', () => {
    const { dir } = createAndGetDir('test-no-force', { title: 'No force accept' });
    advanceToExecution(dir);
    run('execution', 'start-item', '--item', 'E-001');
    run('execution', 'complete-item', '--item', 'E-001', '--evidence', 'done');
    run('advance');
    run('verify', 'run');
    run('verify', 'check', '--check', 'V1', '--passed', '--evidence', 'ok');
    run('verify', 'run');
    run('advance');

    // --force-accept should be rejected in non-TTY (flag removed)
    assert.match(run('accept', '--force-accept', 'true'), /REJECTED.*confirmed/);

    // Stage stays at pending_acceptance
    const p = readJson(join(dir, 'proposal.json'));
    assert.equal(p.stage, 'pending_acceptance');
  });

  test('12. advance --force cannot cross pending_acceptance→done', () => {
    const { dir } = createAndGetDir('test-no-force-adv', { title: 'No force advance' });
    advanceToExecution(dir);
    run('execution', 'start-item', '--item', 'E-001');
    run('execution', 'complete-item', '--item', 'E-001', '--evidence', 'done');
    run('advance');
    run('verify', 'run');
    run('verify', 'check', '--check', 'V1', '--passed', '--evidence', 'ok');
    run('verify', 'run');
    run('advance');

    // advance --force from pending_acceptance should be blocked
    const result = run('advance', '--force', 'true');
    assert.match(result, /Cannot force-advance|pending_acceptance/);

    // Stage stays
    const p = readJson(join(dir, 'proposal.json'));
    assert.equal(p.stage, 'pending_acceptance');
  });

  test('13. waiver requires user confirmation gate, not just a flag', () => {
    const { dir } = createAndGetDir('test-waiver', { title: 'Waiver gate' });
    advanceToExecution(dir);
    run('execution', 'start-item', '--item', 'E-001');
    run('execution', 'complete-item', '--item', 'E-001', '--evidence', 'done');
    run('advance');
    run('verify', 'run');

    // Mark V1 as failed
    run('verify', 'check', '--check', 'V1', '--failed', '--evidence', 'test fails');

    // Old-style --waiver flag on verify check should no longer grant waiver
    run('verify', 'check', '--check', 'V1', '--failed', '--waiver', 'skip it');
    run('verify', 'run');
    const v1 = readJson(join(dir, 'verify.json'));
    assert.equal(v1.all_gating_passed, false, 'waiver flag alone should not pass gating');

    // verify waive without TTY/test-env should be rejected
    assert.match(run('verify', 'waive', '--check', 'V1', '--reason', 'acceptable risk'), /REJECTED.*confirmed/);

    // verify waive with test env var should succeed
    assert.match(
      run('verify', 'waive', '--check', 'V1', '--reason', 'acceptable risk', TEST_ACCEPT_OPTS),
      /Waiver granted/
    );

    // Now recompute — should pass with waiver_granted event
    run('verify', 'run');
    const v2 = readJson(join(dir, 'verify.json'));
    assert.equal(v2.all_gating_passed, true, 'waiver_granted event should satisfy gating');

    // events.jsonl should have waiver_granted event
    const events = readFileSync(join(dir, 'events.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    const waiverEvent = events.find(e => e.type === 'waiver_granted');
    assert.ok(waiverEvent, 'waiver_granted event should exist');
    assert.equal(waiverEvent.item_id, 'V1');
  });

  test('14. all_gating_passed fails when plan check is missing from results', () => {
    const { dir } = createAndGetDir('test-missing-check', { title: 'Missing check' });

    // Plan with TWO gating checks
    writeJson(join(dir, 'analysis.json'), { problem: 'P', scope: 'S', constraints: [], investigation: '' });
    run('advance');
    writeJson(join(dir, 'design.json'), { decisions: [{ id: 'D1', decision: 'D', rationale: 'R', tradeoffs: 'T' }] });
    run('advance');
    writeJson(join(dir, 'plan.json'), {
      execution_outline: 'O',
      verify_plan: {
        checks: [
          { id: 'V1', description: 'Check 1', gating: true },
          { id: 'V2', description: 'Check 2', gating: true },
        ],
        evidence_required: [],
      },
    });
    run('advance');
    writeJson(join(dir, 'execution.json'), { items: [{ id: 'E-001', title: 'X', status: 'todo', depends_on: [], evidence: [] }] });
    run('advance');
    run('execution', 'start-item', '--item', 'E-001');
    run('execution', 'complete-item', '--item', 'E-001', '--evidence', 'done');
    run('advance');

    // Create verify skeleton
    run('verify', 'run');

    // Only mark V1 as passed, deliberately remove V2 from results
    run('verify', 'check', '--check', 'V1', '--passed', '--evidence', 'ok');
    const v = readJson(join(dir, 'verify.json'));
    v.results = v.results.filter(r => r.id === 'V1');
    writeJson(join(dir, 'verify.json'), v);

    // Recompute — V2 is missing, should NOT pass
    run('verify', 'run');
    const v2 = readJson(join(dir, 'verify.json'));
    assert.equal(v2.all_gating_passed, false, 'missing gating check should fail');

    // Advance should also fail
    assert.match(run('advance'), /all_gating_passed is not true/);
  });

  test('15. verify→execution back with no failed checks does not reopen items', () => {
    const { dir } = createAndGetDir('test-noop-back', { title: 'Noop back' });
    advanceToExecution(dir);
    run('execution', 'start-item', '--item', 'E-001');
    run('execution', 'complete-item', '--item', 'E-001', '--evidence', 'done');
    run('advance');

    // Mark all checks passed
    run('verify', 'run');
    run('verify', 'check', '--check', 'V1', '--passed', '--evidence', 'ok');

    // Back to execution — no failures means no reopen
    const backResult = run('back', '--to', 'execution');
    assert.match(backResult, /verify → execution/);

    // Item should still be done
    const exec = readJson(join(dir, 'execution.json'));
    assert.equal(exec.items[0].status, 'done', 'done item should NOT be reopened when no failures');
  });

  // --- New tests for security/correctness fixes ---

  test('16. old env var bypass no longer works, stdin pipe does', () => {
    const { dir } = createAndGetDir('test-no-env-bypass', { title: 'No env bypass' });
    advanceToDone(dir);

    // Reset to pending_acceptance to test accept
    const p = readJson(join(dir, 'proposal.json'));
    p.stage = 'pending_acceptance';
    p.lifecycle_status = 'active';
    writeJson(join(dir, 'proposal.json'), p);

    // Old env var bypass should fail
    const oldResult = run('accept', { env: { NODE_ENV: 'test', VFLOW_TEST_ALLOW_ACCEPT: '1' } });
    assert.match(oldResult, /REJECTED|cancelled|no/i, 'old env var bypass should not work');

    const p2 = readJson(join(dir, 'proposal.json'));
    assert.equal(p2.stage, 'pending_acceptance', 'stage should not change with env bypass');
  });

  test('17. stdin pipe "no" rejects accept', () => {
    const { dir } = createAndGetDir('test-stdin-no', { title: 'Stdin no' });
    advanceToDone(dir);

    const p = readJson(join(dir, 'proposal.json'));
    p.stage = 'pending_acceptance';
    p.lifecycle_status = 'active';
    writeJson(join(dir, 'proposal.json'), p);

    const result = run('accept', { input: 'no\n' });
    assert.match(result, /REJECTED/i);

    const p2 = readJson(join(dir, 'proposal.json'));
    assert.equal(p2.stage, 'pending_acceptance');
  });

  test('18. force forbidden for late stages (execution→verify)', () => {
    const { dir } = createAndGetDir('test-force-late', { title: 'Force late' });
    advanceToExecution(dir);

    // Items not done — advance should fail normally
    const result = run('advance', '--force', 'true', '--reason', 'test', { input: 'yes\n' });
    assert.match(result, /Cannot force|Force.*not allowed|forbidden/i);

    const p = readJson(join(dir, 'proposal.json'));
    assert.equal(p.stage, 'execution', 'should stay at execution');
  });

  test('19. force allowed for early stages with reason + confirmation + gate_bypassed event', () => {
    const { dir } = createAndGetDir('test-force-early', { title: 'Force early' });
    // Don't write analysis.json — gate should fail
    const result = run('advance', '--force', 'true', '--reason', 'urgent prototype', { input: 'yes\n' });
    assert.match(result, /analysis|Advanced/i);

    const events = readFileSync(join(dir, 'events.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    const bypass = events.find(e => e.type === 'gate_bypassed');
    assert.ok(bypass, 'gate_bypassed event should exist');
    assert.match(bypass.detail, /urgent prototype/);
  });

  test('20. force without --reason is rejected', () => {
    const { dir } = createAndGetDir('test-force-no-reason', { title: 'Force no reason' });
    const result = run('advance', '--force', 'true', { input: 'yes\n' });
    assert.match(result, /reason.*required/i);
  });

  test('21. archive rejected without acceptance event', () => {
    const { dir } = createAndGetDir('test-archive-no-accept', { title: 'Archive no accept' });
    advanceToExecution(dir);
    run('execution', 'start-item', '--item', 'E-001');
    run('execution', 'complete-item', '--item', 'E-001', '--evidence', 'done');
    run('advance'); // → verify
    run('verify', 'run');
    run('verify', 'check', '--check', 'V1', '--passed', '--evidence', 'ok');
    run('verify', 'run');

    // Manually set stage=done WITHOUT going through accept
    const p = readJson(join(dir, 'proposal.json'));
    p.stage = 'done';
    p.lifecycle_status = 'done';
    p.knowledge_processed = true;
    writeJson(join(dir, 'proposal.json'), p);

    const result = run('archive');
    assert.match(result, /acceptance|Cannot archive/i, 'archive should fail without acceptance event');
  });

  test('22. archive does not require pre-existing review.md', () => {
    const { dir } = createAndGetDir('test-archive-no-review', { title: 'Archive no review' });
    advanceToDone(dir);
    run('knowledge', 'skip');

    // Verify review.md does NOT exist before archive
    assert.ok(!existsSync(join(dir, 'review.md')), 'review.md should not exist before archive');

    // Archive should succeed (generates review.md during process)
    run('archive');
    assert.ok(!existsSync(dir), 'original dir should be moved after archive');
  });

  test('23. waive immediately recalculates all_gating_passed', () => {
    const { dir } = createAndGetDir('test-waive-recalc', { title: 'Waive recalc' });
    advanceToExecution(dir);
    run('execution', 'start-item', '--item', 'E-001');
    run('execution', 'complete-item', '--item', 'E-001', '--evidence', 'done');
    run('advance'); // → verify
    run('verify', 'run');
    run('verify', 'check', '--check', 'V1', '--failed', '--evidence', 'known issue');

    // Waive the check
    run('verify', 'waive', '--check', 'V1', '--reason', 'acceptable risk', TEST_ACCEPT_OPTS);

    // all_gating_passed should already be true WITHOUT running verify run again
    const v = readJson(join(dir, 'verify.json'));
    assert.equal(v.all_gating_passed, true, 'waive should immediately recalculate all_gating_passed');
  });

  test('24. accept writes stage_changed event', () => {
    const { dir } = createAndGetDir('test-accept-event', { title: 'Accept event' });
    advanceToDone(dir);

    const events = readFileSync(join(dir, 'events.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    const stageChanged = events.filter(e => e.type === 'stage_changed' && e.from === 'pending_acceptance' && e.to === 'done');
    assert.ok(stageChanged.length >= 1, 'stage_changed event from pending_acceptance to done should exist');
  });

  test('25. back does not clear evidence', () => {
    const { dir } = createAndGetDir('test-keep-evidence', { title: 'Keep evidence' });
    advanceToExecution(dir);
    run('execution', 'start-item', '--item', 'E-001');
    run('execution', 'complete-item', '--item', 'E-001', '--evidence', 'important proof');
    run('advance'); // → verify
    run('verify', 'run');
    run('verify', 'check', '--check', 'V1', '--failed', '--evidence', 'test fails');

    // Back to execution
    run('back', '--to', 'execution');

    const exec = readJson(join(dir, 'execution.json'));
    const item = exec.items.find(i => i.id === 'E-001');
    assert.ok(item.evidence.length > 0, 'evidence should be preserved after back');
    assert.ok(item.evidence.includes('important proof'), 'original evidence should still exist');
  });

  test('26. advance from done is blocked (must use archive)', () => {
    const { dir } = createAndGetDir('test-no-adv-done', { title: 'No advance done' });
    advanceToDone(dir);

    const result = run('advance');
    assert.match(result, /Cannot advance from done|Use.*archive/i);

    const p = readJson(join(dir, 'proposal.json'));
    assert.equal(p.stage, 'done', 'stage should remain done');
  });

  test('27. T3 requires design confirmation before plan', () => {
    const { dir } = createAndGetDir('test-t3-gate', { title: 'T3 gate', tier: 'T3' });

    writeJson(join(dir, 'analysis.json'), { problem: 'P', scope: 'S', constraints: [], investigation: '' });
    run('advance'); // → analysis
    writeJson(join(dir, 'design.json'), { decisions: [{ id: 'D1', decision: 'D', rationale: 'R', tradeoffs: 'T' }] });
    run('advance'); // → design
    writeJson(join(dir, 'plan.json'), { execution_outline: 'O', verify_plan: { checks: [{ id: 'V1', description: 'C', gating: true }], evidence_required: [] } });

    // Try advance without design confirmation — should fail
    const result = run('advance');
    assert.match(result, /T3.*design confirmation|confirm/i);

    // Confirm design
    run('confirm-design', TEST_ACCEPT_OPTS);

    // Now advance should succeed
    assert.match(run('advance'), /design → plan/);
  });

  test('28. T2 does not require design confirmation', () => {
    const { dir } = createAndGetDir('test-t2-no-confirm', { title: 'T2 no confirm', tier: 'T2' });

    writeJson(join(dir, 'analysis.json'), { problem: 'P', scope: 'S', constraints: [], investigation: '' });
    run('advance');
    writeJson(join(dir, 'design.json'), { decisions: [{ id: 'D1', decision: 'D', rationale: 'R', tradeoffs: 'T' }] });
    run('advance');
    writeJson(join(dir, 'plan.json'), { execution_outline: 'O', verify_plan: { checks: [{ id: 'V1', description: 'C', gating: true }], evidence_required: [] } });

    // T2 should advance without design confirmation
    assert.match(run('advance'), /design → plan/);
  });

  test('29. T3 design confirmation invalidated after back to design', () => {
    const { dir } = createAndGetDir('test-t3-reconfirm', { title: 'T3 reconfirm', tier: 'T3' });

    writeJson(join(dir, 'analysis.json'), { problem: 'P', scope: 'S', constraints: [], investigation: '' });
    run('advance'); // → analysis
    writeJson(join(dir, 'design.json'), { decisions: [{ id: 'D1', decision: 'D', rationale: 'R', tradeoffs: 'T' }] });
    run('advance'); // → design
    writeJson(join(dir, 'plan.json'), { execution_outline: 'O', verify_plan: { checks: [{ id: 'V1', description: 'C', gating: true }], evidence_required: [] } });

    // Confirm design and advance to plan
    run('confirm-design', TEST_ACCEPT_OPTS);
    assert.match(run('advance'), /design → plan/);

    // Add execution items and advance to execution
    writeJson(join(dir, 'execution.json'), { items: [{ id: 'E-001', title: 'X', status: 'todo', depends_on: [], evidence: [] }] });
    run('advance'); // → execution

    // Back to design (simulates design change needed)
    run('back', '--to', 'design');
    const p = readJson(join(dir, 'proposal.json'));
    assert.equal(p.stage, 'design');

    // Old confirmation should be invalid — advance should fail
    writeJson(join(dir, 'plan.json'), { execution_outline: 'O', verify_plan: { checks: [{ id: 'V1', description: 'C', gating: true }], evidence_required: [] } });
    const result = run('advance');
    assert.match(result, /modified after last confirmation|confirm-design/i);

    // Re-confirm and advance should succeed
    run('confirm-design', TEST_ACCEPT_OPTS);
    assert.match(run('advance'), /design → plan/);
  });

  test('30. T3 design hash tamper detection', () => {
    const { dir } = createAndGetDir('test-t3-hash', { title: 'T3 hash', tier: 'T3' });

    writeJson(join(dir, 'analysis.json'), { problem: 'P', scope: 'S', constraints: [], investigation: '' });
    run('advance'); // → analysis
    writeJson(join(dir, 'design.json'), { decisions: [{ id: 'D1', decision: 'D', rationale: 'R', tradeoffs: 'T' }] });
    run('advance'); // → design
    writeJson(join(dir, 'plan.json'), { execution_outline: 'O', verify_plan: { checks: [{ id: 'V1', description: 'C', gating: true }], evidence_required: [] } });

    // Confirm design — hash is captured
    run('confirm-design', TEST_ACCEPT_OPTS);

    // Verify the event has design_hash
    const events = readFileSync(join(dir, 'events.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    const confirmEvent = events.find(e => e.type === 'design_confirmed');
    assert.ok(confirmEvent, 'design_confirmed event should exist');
    assert.match(confirmEvent.detail, /design_hash=[0-9a-f]{64}/, 'should contain sha256 hash');

    // Tamper with design.json after confirmation
    writeJson(join(dir, 'design.json'), { decisions: [{ id: 'D1', decision: 'CHANGED', rationale: 'R', tradeoffs: 'T' }] });

    // Advance should fail — hash mismatch
    const result = run('advance');
    assert.match(result, /changed after last confirmation|confirm-design/i);

    // Re-confirm with new content
    run('confirm-design', TEST_ACCEPT_OPTS);
    assert.match(run('advance'), /design → plan/);
  });

  test('31. corrupt JSON shows explicit warning', () => {
    const { dir } = createAndGetDir('test-corrupt-json', { title: 'Corrupt JSON' });

    // Write corrupt analysis.json
    writeFileSync(join(dir, 'analysis.json'), '{invalid json!!!', 'utf-8');

    // advance should mention the problem, and readJson should output warning
    const result = run('advance');
    assert.match(result, /WARNING.*corrupt.*JSON|analysis\.json missing/i);
  });

  test('32. review.html escapes HTML entities', async () => {
    const { dir } = createAndGetDir('test-html-escape', { title: '<script>alert("xss")</script>', type: 'bug' });

    writeJson(join(dir, 'analysis.json'), { problem: 'XSS <b>test</b>', scope: 'S&S', constraints: [], investigation: '' });
    run('advance');
    writeJson(join(dir, 'design.json'), { decisions: [{ id: 'D1', decision: 'D', rationale: 'R', tradeoffs: 'T' }] });
    run('advance');
    writeJson(join(dir, 'plan.json'), { execution_outline: 'O', verify_plan: { checks: [{ id: 'V1', description: 'C', gating: true }], evidence_required: [] } });
    run('advance');
    writeJson(join(dir, 'execution.json'), { items: [{ id: 'E-001', title: 'X', status: 'todo', depends_on: [], evidence: [] }] });
    run('advance');
    run('execution', 'start-item', '--item', 'E-001');
    run('execution', 'complete-item', '--item', 'E-001', '--evidence', 'done');
    run('advance');
    run('verify', 'run');
    run('verify', 'check', '--check', 'V1', '--passed', '--evidence', 'ok');
    run('verify', 'run');
    run('advance');
    run('accept', TEST_ACCEPT_OPTS);
    run('knowledge', 'skip');

    run('archive', '--html');

    // Find archived dir
    const archiveBase = join(PROPOSALS_DIR, 'archive');
    const months = readdirSync(archiveBase);
    let archivedDir = null;
    for (const month of months) {
      const entries = readdirSync(join(archiveBase, month));
      for (const entry of entries) {
        if (entry.includes('test-html-escape')) {
          archivedDir = join(archiveBase, month, entry);
        }
      }
    }
    assert.ok(archivedDir, 'archived dir should exist');

    const htmlContent = readFileSync(join(archivedDir, 'review.html'), 'utf-8');
    assert.ok(!htmlContent.includes('<script>'), 'raw <script> tag should not appear in HTML');
    assert.ok(htmlContent.includes('&lt;script&gt;'), 'script tag should be escaped');
    assert.ok(htmlContent.includes('&amp;'), '& should be escaped to &amp;');
  });
});
