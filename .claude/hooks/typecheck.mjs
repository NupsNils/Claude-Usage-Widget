#!/usr/bin/env node
// PostToolUse hook (Write|Edit|MultiEdit): after a TypeScript file in the
// project changed, runs both tsc projects of `npm run typecheck` with the local
// compiler. Exit 2 + stderr = type errors (shown to Claude); exit 0 otherwise.
// Stays silent when TypeScript is not installed or on unexpected errors.

import { parseHookInput, readStdin, resolveProjectRoot } from './lib/common.mjs';
import { evaluateTypecheckHook } from './lib/typecheck.mjs';

try {
  const input = parseHookInput(await readStdin(process.stdin));
  const projectRoot = resolveProjectRoot({ env: process.env, scriptUrl: import.meta.url });
  const result = await evaluateTypecheckHook(input, { projectRoot });
  if (result.exitCode === 2) {
    process.stderr.write(`${result.stderr}\n`);
  }
  process.exitCode = result.exitCode;
} catch (error) {
  process.stderr.write(`typecheck hook: internal error, skipping: ${error?.message ?? error}\n`);
  process.exitCode = 0;
}
