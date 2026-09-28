#!/usr/bin/env node
// Stop hook: if source files changed (git status), runs the typecheck and
// `vitest run` before Claude may finish. On failure prints
// {"decision":"block","reason":"..."} to stdout (Claude continues and sees the
// reason). Always exits 0; skips when stop_hook_active is true, when git or the
// tools are unavailable, or on unexpected errors.

import { parseHookInput, readStdin, resolveProjectRoot } from './lib/common.mjs';
import { evaluateStopGate } from './lib/test-gate.mjs';

try {
  const input = parseHookInput(await readStdin(process.stdin));
  // Check the loop guard before doing any other work.
  if (input && input.stop_hook_active !== true) {
    const projectRoot = resolveProjectRoot({ env: process.env, scriptUrl: import.meta.url });
    const result = await evaluateStopGate(input, { projectRoot });
    if (result.block) {
      process.stdout.write(`${JSON.stringify({ decision: 'block', reason: result.reason })}\n`);
    }
  }
} catch (error) {
  process.stderr.write(`test-gate: internal error, allowing stop: ${error?.message ?? error}\n`);
}
process.exitCode = 0;
