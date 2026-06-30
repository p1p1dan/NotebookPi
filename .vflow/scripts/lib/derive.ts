// derive.ts — Archive derivation and knowledge extraction.

import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import {
  ARCHIVE_DIR, KNOWLEDGE_DIR, isoNow, yearMonth, readText,
} from './config.js';
import type {
  Proposal, VflowEvent, AnalysisArtifact, DesignArtifact,
  PlanArtifact, ExecutionArtifact, VerifyArtifact,
} from './schema.js';
import {
  readArtifact, readEvents, appendEvent, writeProposal,
  upsertRepoIndex, readRepoIndex,
} from './store.js';
import { clearProposalFromSessions } from './session-runtime.js';

export function deriveReviewMd(dir: string, proposal: Proposal): string {
  const events = readEvents(dir);
  const analysis = readArtifact<AnalysisArtifact>(dir, 'analysis');
  const design = readArtifact<DesignArtifact>(dir, 'design');
  const plan = readArtifact<PlanArtifact>(dir, 'plan');
  const exec = readArtifact<ExecutionArtifact>(dir, 'execution');
  const verify = readArtifact<VerifyArtifact>(dir, 'verify');

  const lines: string[] = [];
  lines.push(`# Review: ${proposal.title}`);
  lines.push('');
  lines.push(`**ID:** ${proposal.id}  `);
  lines.push(`**Type:** ${proposal.type} | **Tier:** ${proposal.tier}  `);
  lines.push(`**Created:** ${proposal.created_at}  `);
  lines.push(`**Completed:** ${proposal.updated_at}  `);
  lines.push('');

  lines.push('## Analysis');
  lines.push('');
  if (analysis) {
    lines.push(`**Problem:** ${analysis.problem}`);
    lines.push('');
    lines.push(`**Scope:** ${analysis.scope}`);
    lines.push('');
    if (analysis.constraints.length) {
      lines.push('**Constraints:**');
      for (const c of analysis.constraints) lines.push(`- ${c}`);
      lines.push('');
    }
  }

  lines.push('## Design Decisions');
  lines.push('');
  if (design) {
    for (const d of design.decisions) {
      lines.push(`### ${d.id}: ${d.decision}`);
      lines.push('');
      lines.push(`**Rationale:** ${d.rationale}`);
      lines.push('');
      lines.push(`**Tradeoffs:** ${d.tradeoffs}`);
      lines.push('');
    }
  }

  lines.push('## Execution');
  lines.push('');
  if (exec) {
    lines.push('| Item | Status | Evidence |');
    lines.push('|------|--------|----------|');
    for (const item of exec.items) {
      lines.push(`| ${item.id}: ${item.title} | ${item.status} | ${item.evidence.join('; ') || '-'} |`);
    }
    lines.push('');
  }

  lines.push('## Verification');
  lines.push('');
  if (verify) {
    lines.push(`**All gating passed:** ${verify.all_gating_passed}`);
    lines.push('');
    for (const r of verify.results) {
      lines.push(`- **${r.id}:** ${r.passed ? 'PASS' : 'FAIL'} — ${r.evidence}${r.waiver ? ` (waiver: ${r.waiver})` : ''}`);
    }
    lines.push('');
    const sr = verify.spec_review;
    if (sr && sr.findings.length) {
      lines.push('### Spec Review (completeness / correctness / consistency)');
      lines.push('');
      lines.push(`Scope: ${sr.scope_files.length} files`);
      lines.push('');
      for (const f of sr.findings) {
        const loc = `${f.file}${f.line ? `:${f.line}` : ''}`;
        lines.push(`- **${f.level}** [${f.dimension}] ${loc}: ${f.issue}${f.spec_ref ? ` (${f.spec_ref})` : ''}${f.waived ? ' — waived' : ''}`);
      }
      lines.push('');
    }
  }

  lines.push('## Event Timeline');
  lines.push('');
  for (const e of events) {
    const parts = [`${e.ts} — **${e.type}**`];
    if (e.from || e.to) parts.push(`${e.from ?? ''}→${e.to ?? ''}`);
    if (e.item_id) parts.push(`[${e.item_id}]`);
    if (e.detail) parts.push(e.detail);
    lines.push(`- ${parts.join(' | ')}`);
  }
  lines.push('');

  return lines.join('\n');
}

export function archiveProposal(dir: string, proposal: Proposal, html: boolean): void {
  // Derive review.md
  const reviewContent = deriveReviewMd(dir, proposal);
  writeFileSync(join(dir, 'review.md'), reviewContent, 'utf-8');
  console.log('Generated review.md');

  if (html) {
    const escaped = reviewContent.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const htmlContent = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Review: ${proposal.title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</title></head><body><pre>${escaped}</pre></body></html>`;
    writeFileSync(join(dir, 'review.html'), htmlContent, 'utf-8');
    console.log('Generated review.html');
  }

  // Move to archive
  const monthDir = join(ARCHIVE_DIR, yearMonth());
  mkdirSync(monthDir, { recursive: true });
  const dest = join(monthDir, basename(dir));
  renameSync(dir, dest);

  // Update proposal
  proposal.stage = 'archived';
  proposal.lifecycle_status = 'archived';
  writeProposal(dest, proposal);

  // Update repo index
  upsertRepoIndex({
    id: proposal.id, slug: proposal.slug, dir: `archive/${yearMonth()}/${basename(dir)}`,
    title: proposal.title, stage: 'archived', lifecycle_status: 'archived',
    type: proposal.type, updated_at: isoNow(),
  });

  // Clear session bindings
  clearProposalFromSessions(proposal.id);

  // Append archived event
  appendEvent(dest, { ts: isoNow(), type: 'stage_changed', from: 'done', to: 'archived' });
  appendEvent(dest, { ts: isoNow(), type: 'archived', detail: `Archived to ${monthDir}` });

  console.log(`Archived ${proposal.id} to ${dest}`);
}

// Knowledge writeback (path B): organize candidates under the four spec
// categories — Convention / Pattern / Forbidden / Gotcha — and point each at a
// target spec file. The AI refines these and runs `knowledge save` per entry.
// Target-file rule mirrors the old spec skill: common/ for language-agnostic
// principles, lang/<language>.md for language-specific, modules/ for feature
// (qt/embedded/...), domain/<topic>.md for project domain knowledge.
export function knowledgeSuggest(dir: string): string[] {
  const design = readArtifact<DesignArtifact>(dir, 'design');
  const verify = readArtifact<VerifyArtifact>(dir, 'verify');
  const entries: string[] = [];

  if (design) {
    for (const d of design.decisions) {
      entries.push(`[Pattern?] Decision ${d.id}: ${d.decision} — ${d.rationale} → target: <pick spec file>`);
    }
  }
  if (verify) {
    for (const r of verify.results) {
      if (!r.passed && r.waiver) {
        entries.push(`[Gotcha?] Known risk: ${r.evidence} (waiver: ${r.waiver}) → target: domain/ or lang/`);
      }
    }
    const sr = verify.spec_review;
    if (sr && sr.findings.length) {
      for (const f of sr.findings) {
        // A consistency violation against an existing spec usually reinforces a
        // Convention/Forbidden rule; surface it so the rule can be strengthened.
        const cat = f.dimension === 'consistency' ? 'Convention/Forbidden?' : 'Pattern/Gotcha?';
        const ref = f.spec_ref ? ` (existing: ${f.spec_ref})` : '';
        entries.push(`[${cat}] Review ${f.level} on ${f.file}: ${f.issue}${ref} → target: <pick spec file>`);
      }
    }
  }

  // Nothing learned worth capturing → empty, so `knowledge suggest` auto-skips.
  if (entries.length === 0) return [];

  // Prepend the four-category guidance so the AI organizes entries correctly.
  return [
    'Classify each entry into one category and pick a target spec file under .vflow/spec/:',
    '  - Convention (naming/format/structure agreement) | Pattern (verified approach)',
    '  - Forbidden (banned practice) | Gotcha (counter-intuitive trap)',
    '  - Target: common/ (principle) · lang/<language>.md · modules/ (qt/embedded) · domain/<topic>.md',
    '',
    ...entries,
  ];
}
