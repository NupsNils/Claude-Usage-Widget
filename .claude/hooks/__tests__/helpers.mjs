// Shared test helpers. Not a test file itself (the include glob is *.test.mjs).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Builds a secret-looking Anthropic token at runtime so that no literal secret
 * ever appears in a source file (the secret guard would flag its own tests).
 *
 * @param {string} [kind]  e.g. 'sid01', 'api03', 'oat01', 'ort01', 'admin01'
 * @param {string} [body]
 */
export function fakeSecret(kind = 'sid01', body = 'A'.repeat(40)) {
  return ['sk', 'ant', kind, body].join('-');
}

/** A varied base64url body, closer to a real token than a repeated letter. */
export const VARIED_BODY = 'q7Zr_9xK-Lm2Pw4Tn8Vb'.repeat(3);

/** Creates a temporary directory and returns its path. */
export function makeTempDir(prefix = 'claude-hooks-test-') {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Removes a temporary directory created by makeTempDir. */
export function removeTempDir(dir) {
  if (dir) rmSync(dir, { recursive: true, force: true });
}

/** Writes a file, creating parent directories. */
export function writeFileDeep(file, content) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** A RunResult as returned by runProcess, with overrides. */
export function runResult(overrides = {}) {
  return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, error: null, ...overrides };
}

/**
 * A fake runProcess that records its calls and answers through `respond`.
 *
 * @param {(command: string, args: string[], options: object) => object} respond
 */
export function fakeRunner(respond = () => runResult()) {
  const calls = [];
  const run = async (command, args, options = {}) => {
    calls.push({ command, args, options });
    return runResult(respond(command, args, options) || {});
  };
  return { run, calls };
}
