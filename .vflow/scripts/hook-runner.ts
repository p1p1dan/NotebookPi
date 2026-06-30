#!/usr/bin/env node
// hook-runner.ts — Shell-agnostic launcher for Claude Code hooks.
//
// Why this exists: Claude Code passes a hook `command` string to whatever shell
// the host OS hands it (cmd.exe / PowerShell / sh — unknown on Windows). Any
// shell-specific syntax (cd, &&, ||, $VAR expansion, quoted absolute exe paths)
// breaks on at least one of them. The only form that parses identically across
// all three is a bare `node <relative-script> <arg>` with no operators or
// quoting. So settings.json invokes ONLY this runner, and every shell concern
// (resolving cwd, locating node, spawning inject, stdin passthrough, degraded
// fallback) is handled here in JS where behavior is deterministic.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const mode = process.argv[2];
if (mode !== 'session' && mode !== 'prompt') {
  process.stderr.write('Usage: hook-runner.js <session|prompt>\n');
  process.exit(1);
}

// CLAUDE_PROJECT_DIR is the reliable project root under Claude Code; fall back
// to cwd for manual invocation. Resolve inject relative to it, never to a
// shell-expanded variable.
const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const injectPath = join(cwd, '.vflow', 'scripts', 'dist', 'inject.js');

// inject reads its hook payload from stdin (fd 0). Capture whatever the host
// piped in and forward it verbatim, so the prompt-mode payload survives.
let input = '';
try {
  input = readFileSync(0, 'utf-8');
} catch {
  // No stdin available — inject treats empty payload as "no payload".
}

const degraded =
  `<vflow-degraded>vflow inject hook failed. AI: run ` +
  `\`node .vflow/scripts/dist/inject.js ${mode}\` manually to diagnose ` +
  `(node missing? cwd? encoding?), report the cause to the user, ` +
  `then continue this turn.</vflow-degraded>\n`;

const r = spawnSync(process.execPath, [injectPath, mode], {
  cwd,
  input,
  encoding: 'utf8',
  timeout: 15000,
});

if (r.stdout) process.stdout.write(r.stdout);
if (r.stderr) process.stderr.write(r.stderr);

// Degraded notice is emitted by JS, not by a shell `|| echo`, so it is reliable
// regardless of which shell launched us.
if (r.error || r.status !== 0) process.stdout.write(degraded);
