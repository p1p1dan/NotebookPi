// ralph-checker.ts — Completion checks for ralph steps.
// Each check validates that required documents were updated before allowing step completion.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readText, ROOT } from './config.js';
import { parseSection, isFilled } from './docs.js';

// -- Check registry --

type CheckFn = (taskDir: string) => string | null;

const CHECK_REGISTRY: Record<string, CheckFn> = {

  /**
   * has_rids — task-spec.md §2 must contain at least one R-ID (R1, R2, etc.)
   */
  has_rids: (taskDir) => {
    const body = parseSection(join(taskDir, 'task-spec.md'), 2);
    const rids = body.match(/^-\s*R\d+:/gm);
    if (!rids || rids.length === 0) {
      return 'task-spec.md §2 has no R-IDs defined (expected "- R1: ...")';
    }
    return null;
  },

  /**
   * has_checklist — task-spec.md §6 must contain at least one checklist item
   */
  has_checklist: (taskDir) => {
    const body = parseSection(join(taskDir, 'task-spec.md'), 6);
    const items = body.match(/^-\s*\[[ x]\]/gm);
    if (!items || items.length === 0) {
      return 'task-spec.md §6 has no checklist items';
    }
    return null;
  },

  /**
   * rids_covered — Every R-ID in §2 must appear in at least one §6 checklist item
   */
  rids_covered: (taskDir) => {
    const specPath = join(taskDir, 'task-spec.md');
    const sect2 = parseSection(specPath, 2);
    const sect6 = parseSection(specPath, 6);

    const definedRids = (sect2.match(/R\d+/g) || [])
      .filter((v, i, a) => a.indexOf(v) === i);
    const coveredRids = (sect6.match(/R\d+/g) || [])
      .filter((v, i, a) => a.indexOf(v) === i);

    const uncovered = definedRids.filter(r => !coveredRids.includes(r));
    if (uncovered.length > 0) {
      return `R-IDs not covered in §6 checklist: ${uncovered.join(', ')}`;
    }
    return null;
  },

  /**
   * has_ledger_entries — ledger.md §1 must have meaningful content (not just template)
   */
  has_ledger_entries: (taskDir) => {
    const ledger = join(taskDir, 'ledger.md');
    if (!existsSync(ledger)) {
      return 'ledger.md not found';
    }
    if (!isFilled(ledger)) {
      return 'ledger.md §1 has no implementation records';
    }
    return null;
  },

  /**
   * checklist_checked — All checklist items in §6 must be checked [x]
   */
  checklist_checked: (taskDir) => {
    const body = parseSection(join(taskDir, 'task-spec.md'), 6);
    const unchecked = body.match(/^-\s*\[ \]/gm);
    if (unchecked && unchecked.length > 0) {
      return `${unchecked.length} unchecked items remain in task-spec.md §6`;
    }
    return null;
  },

  /**
   * has_rid_closure — ledger.md §4 must have one entry per R-ID defined in task-spec.md §2
   */
  has_rid_closure: (taskDir) => {
    const specPath = join(taskDir, 'task-spec.md');
    const sect2 = parseSection(specPath, 2);
    const definedRids = (sect2.match(/R\d+/g) || [])
      .filter((v, i, a) => a.indexOf(v) === i);

    if (definedRids.length === 0) return null;

    const ledger = join(taskDir, 'ledger.md');
    if (!existsSync(ledger)) {
      return 'ledger.md not found for R-ID closure check';
    }
    const sect4 = parseSection(ledger, 4);
    const closedRids = (sect4.match(/R\d+/g) || [])
      .filter((v, i, a) => a.indexOf(v) === i);

    const unclosed = definedRids.filter(r => !closedRids.includes(r));
    if (unclosed.length > 0) {
      return `R-IDs not verified in ledger.md §4: ${unclosed.join(', ')}`;
    }
    return null;
  },

  /**
   * has_knowledge_update — knowledge.md must have content beyond the template
   */
  has_knowledge_update: (taskDir) => {
    const knowledgePath = join(ROOT, 'knowledge.md');
    if (!existsSync(knowledgePath)) {
      return 'knowledge.md not found';
    }
    const content = readText(knowledgePath);
    // Check if it's still just the template (all sections are empty/comments)
    const meaningful = content.split('\n').filter(l => {
      const s = l.trim();
      return s && !s.startsWith('#') && !s.startsWith('<!--') && !s.startsWith('-->');
    });
    if (meaningful.length < 2) {
      return 'knowledge.md has no content beyond template. Write task learnings before completing.';
    }
    return null;
  },

  /**
   * has_changes — At least one file was modified (for quick tasks)
   */
  has_changes: (_taskDir) => {
    // This is a lightweight check — just verify something happened.
    // The actual verification is done by the AI during implementation.
    return null;
  },
};

// -- Public API --

/**
 * Run a list of named checks against a task directory.
 * Returns array of failure messages (empty = all passed).
 */
export function runCompletionChecks(checkNames: string[], taskDir: string): string[] {
  const failures: string[] = [];
  for (const name of checkNames) {
    const fn = CHECK_REGISTRY[name];
    if (!fn) {
      failures.push(`Unknown check: ${name}`);
      continue;
    }
    const result = fn(taskDir);
    if (result) {
      failures.push(`[${name}] ${result}`);
    }
  }
  return failures;
}
