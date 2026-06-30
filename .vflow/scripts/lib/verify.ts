// vflow verify — test execution and machine verification.

import { join, basename } from 'node:path';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { VflowConfig, TaskJson } from './config.js';
import { readText, isoNow, ROOT, TEST_OUTPUT_TAIL, TEST_TIMEOUT, MACHINE_BLOCK_HEADER } from './config.js';

export function runVerification(
  taskDir: string,
  cfg: VflowConfig,
  task: TaskJson,
): [boolean, string] {
  const cmd = task.test_scope || (cfg.build?.test_command ?? '');
  const testRequired = cfg.test_required !== undefined ? cfg.test_required : true;
  if (!cmd) {
    if (testRequired) {
      return [
        false,
        'config.build.test_command is empty but test_required=true. Configure a test command (or set test_required=false) first.',
      ];
    }
    return [true, 'test_required=false and no test_command; verification skipped'];
  }

  const result = spawnSync(cmd, [], {
    shell: true,
    cwd: ROOT.replace(/[/\\].vflow$/, ''),
    encoding: 'utf-8',
    timeout: TEST_TIMEOUT * 1000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (result.error && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
    return [false, `test command timed out after ${TEST_TIMEOUT}s: ${cmd}`];
  }

  const stamp = isoNow();
  const combined = (result.stdout ?? '') + (result.stderr ?? '');
  const output = combined.slice(-TEST_OUTPUT_TAIL);
  const block = [
    '',
    MACHINE_BLOCK_HEADER,
    `- 命令: \`${cmd}\``,
    `- 时间: ${stamp}`,
    `- 退出码: ${result.status}`,
    '```',
    output.trim(),
    '```',
    '',
  ].join('\n');

  const vp = join(taskDir, 'verify.md');
  try {
    const existing = readText(vp);
    writeFileSync(vp, existing + block, 'utf-8');
  } catch {
    writeFileSync(vp, block, 'utf-8');
  }

  if (result.status !== 0) {
    return [
      false,
      `test command failed (exit ${result.status}). Output appended to verify.md; fix the failures and advance again.`,
    ];
  }
  task.verified_at = stamp;
  return [true, 'tests passed; machine record appended to verify.md'];
}
