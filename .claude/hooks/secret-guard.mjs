#!/usr/bin/env node
// PreToolUse hook (Write|Edit|MultiEdit|NotebookEdit): blocks writes that would
// put an Anthropic session key or API/OAuth token into a file.
// Exit 2 + stderr = blocked (stderr is shown to Claude); exit 0 = no objection.
// Fails open (exit 0) on unparseable input or unexpected errors.

import { parseHookInput, readStdin } from './lib/common.mjs';
import { evaluateSecretGuard } from './lib/secrets.mjs';

try {
  const input = parseHookInput(await readStdin(process.stdin));
  const result = evaluateSecretGuard(input);
  if (result.block) {
    process.stderr.write(`${result.message}\n`);
    process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(`secret-guard: internal error, allowing the tool call: ${error?.message ?? error}\n`);
  process.exitCode = 0;
}
