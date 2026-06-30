// vflow trace — R-ID end-to-end traceability matrix generation.

import { join, basename } from 'node:path';
import { existsSync } from 'node:fs';
import type { TaskJson, ArtifactEntry } from './config.js';
import { readJson, readText, TASKS } from './config.js';
import { parseRidDefinitions, verifySection } from './rid.js';
import { designPath } from './docs.js';

export interface TraceRow {
  rid: string;
  definition: string;
  designItems: string[];
  artifacts: ArtifactEntry[];
  verifyResult: string;
}

export function generateTraceMatrix(taskDir: string): TraceRow[] {
  const task = readJson<TaskJson>(join(taskDir, 'task.json'));
  if (!task) return [];

  // Read R-ID definitions from requirement.md (or task-spec.md §2)
  let reqText = readText(join(taskDir, 'requirement.md'));
  if (!reqText.trim()) {
    reqText = readText(join(taskDir, 'task-spec.md'));
  }

  const rids = parseRidDefinitions(reqText);
  if (rids.size === 0) return [];

  // Parse design checklist for R-ID references
  const dText = readText(designPath(taskDir));
  const designLines = dText.split('\n').filter(
    (l) => l.trim().startsWith('- [ ]') || l.trim().startsWith('- [x]') || l.trim().startsWith('- [X]'),
  );

  // Parse verify.md §1 for R-ID results
  const vText = readText(join(taskDir, 'verify.md'));
  const ledgerText = readText(join(taskDir, 'ledger.md'));
  const verifyContent = vText || ledgerText;
  const sec1 = verifySection(verifyContent, 1);
  const verifySec4 = verifySection(verifyContent, 4);

  // Artifacts from task.json
  const artifacts = task.artifacts ?? [];

  const rows: TraceRow[] = [];
  for (const rid of [...rids].sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)))) {
    // Find definition line
    const defPattern = new RegExp(`^\\s*-\\s*${rid}\\s*[:：]\\s*(.+)$`, 'm');
    const defMatch = reqText.match(defPattern);
    const definition = defMatch ? defMatch[1].trim() : '';

    // Find design items referencing this R-ID
    const ridPattern = new RegExp(`\\b${rid}\\b`);
    const designItems = designLines.filter((l) => ridPattern.test(l)).map((l) => l.trim());

    // Find artifacts for this R-ID
    const ridArtifacts = artifacts.filter((a) => a.rid === rid);

    // Find verify result for this R-ID
    const verifyText = sec1 || verifySec4;
    const verifyPattern = new RegExp(`^\\s*-\\s*${rid}\\s*[:：]\\s*(.+)$`, 'm');
    const verifyMatch = verifyText.match(verifyPattern);
    const verifyResult = verifyMatch ? verifyMatch[1].trim() : '(pending)';

    rows.push({ rid, definition, designItems, artifacts: ridArtifacts, verifyResult });
  }
  return rows;
}

export function formatTraceMatrix(rows: TraceRow[]): string {
  if (rows.length === 0) return '[vflow] No R-IDs found in task.';

  const lines: string[] = ['R-ID Traceability Matrix', '='.repeat(60)];
  for (const row of rows) {
    lines.push('');
    lines.push(`${row.rid}: ${row.definition}`);
    lines.push(`  Design items: ${row.designItems.length > 0 ? row.designItems.length + ' checklist items' : '(none)'}`);
    for (const item of row.designItems.slice(0, 3)) {
      lines.push(`    ${item.slice(0, 80)}`);
    }
    if (row.designItems.length > 3) {
      lines.push(`    ... and ${row.designItems.length - 3} more`);
    }
    lines.push(`  Artifacts: ${row.artifacts.length > 0 ? row.artifacts.map((a) => `${a.path ?? a.id} (${a.status})`).join(', ') : '(none)'}`);
    lines.push(`  Verification: ${row.verifyResult}`);
  }
  return lines.join('\n');
}
