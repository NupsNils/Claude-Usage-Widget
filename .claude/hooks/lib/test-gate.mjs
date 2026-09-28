// Stop hook logic: before Claude finishes a turn that changed source files,
// run the typecheck and the Vitest suite and block the stop when either fails.

import { existsSync } from 'node:fs';
import path from 'node:path';

import { DEFAULT_MAX_OUTPUT, runProcess, trimOutput } from './common.mjs';
import { filterSourceChanges, parsePorcelain } from './git-status.mjs';
import { formatCommandFailure, runTypecheck, TYPECHECK_TIMEOUT_MS } from './typecheck.mjs';

export const TEST_TIMEOUT_MS = 180_000;
export const GIT_TIMEOUT_MS = 15_000;

/** Environment for child processes: plain output without colors. */
export function childEnv(baseEnv = process.env) {
  return { ...baseEnv, NO_COLOR: '1', FORCE_COLOR: '0' };
}

/**
 * Absolute path of the locally installed Vitest CLI entry point.
 *
 * @param {string} projectRoot
 * @returns {string}
 */
export function vitestBinPath(projectRoot) {
  return path.join(projectRoot, 'node_modules', 'vitest', 'vitest.mjs');
}

/**
 * Lists the changed files (tracked and untracked) that match the source patterns.
 * Returns null when git is unavailable or the directory is not a repository.
 *
 * @param {{ projectRoot: string, run?: typeof runProcess }} options
 * @returns {Promise<string[] | null>}
 */
export async function listChangedSourceFiles({ projectRoot, run = runProcess }) {
  const result = await run('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: projectRoot,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (result.error || result.timedOut || result.code !== 0) {
    return null;
  }
  return filterSourceChanges(parsePorcelain(result.stdout));
}

/**
 * Runs `vitest run` through the local Vitest CLI (no npm, no shell).
 *
 * @param {{ projectRoot: string, run?: typeof runProcess, exists?: (file: string) => boolean, timeoutMs?: number }} options
 * @returns {Promise<import('./typecheck.mjs').StepResult>}
 */
export async function runTests({ projectRoot, run = runProcess, exists = existsSync, timeoutMs = TEST_TIMEOUT_MS }) {
  const bin = vitestBinPath(projectRoot);
  if (!exists(bin)) {
    return { status: 'unavailable', output: '' };
  }
  const result = await run(process.execPath, [bin, 'run'], { cwd: projectRoot, timeoutMs, env: childEnv() });
  if (result.timedOut) {
    return { status: 'timeout', output: formatCommandFailure('vitest run', result) };
  }
  if (result.error) {
    return { status: 'unavailable', output: '' };
  }
  return result.code === 0
    ? { status: 'passed', output: '' }
    : { status: 'failed', output: formatCommandFailure('vitest run', result) };
}

/**
 * Builds the `reason` text for a blocking Stop decision.
 *
 * @param {{ step: string, status: string, output: string }[]} failures
 * @param {string[]} changedFiles
 * @param {number} [maxOutput]  Total budget for the command output.
 * @returns {string}
 */
export function buildBlockReason(failures, changedFiles, maxOutput = DEFAULT_MAX_OUTPUT) {
  const perStep = Math.max(200, Math.floor(maxOutput / Math.max(1, failures.length)));
  const shownFiles = changedFiles.slice(0, 10).join(', ') + (changedFiles.length > 10 ? `, ... (${changedFiles.length} total)` : '');
  const summary = failures.map((failure) => `${failure.step} ${failure.status === 'timeout' ? 'timed out' : 'failed'}`).join(' and ');
  const sections = failures.map((failure) => `[${failure.step}]\n${trimOutput(failure.output, perStep)}`);
  return [
    `Test gate (.claude/hooks/test-gate.mjs): ${summary} after source changes (${shownFiles}).`,
    'Fix the problems and re-run `npm run typecheck` and `npm test` before finishing, or explain to the user why they cannot be fixed.',
    '',
    ...sections,
  ].join('\n');
}

/**
 * Decides whether Claude may stop.
 *
 * @param {Record<string, any> | null} input  Parsed Stop hook payload.
 * @param {{ projectRoot: string, run?: typeof runProcess, exists?: (file: string) => boolean,
 *           typecheckTimeoutMs?: number, testTimeoutMs?: number, maxOutput?: number }} options
 * @returns {Promise<{ block: false, note: string } | { block: true, reason: string, note: string }>}
 */
export async function evaluateStopGate(input, options) {
  const {
    projectRoot,
    run = runProcess,
    exists = existsSync,
    typecheckTimeoutMs = TYPECHECK_TIMEOUT_MS,
    testTimeoutMs = TEST_TIMEOUT_MS,
    maxOutput = DEFAULT_MAX_OUTPUT,
  } = options || /** @type {any} */ ({});

  if (!input || typeof input !== 'object') {
    return { block: false, note: 'unparseable input' };
  }
  // Claude is already continuing because of a Stop hook: never block twice.
  if (input.stop_hook_active === true) {
    return { block: false, note: 'stop_hook_active' };
  }
  if (!projectRoot) {
    return { block: false, note: 'no project root' };
  }

  const changed = await listChangedSourceFiles({ projectRoot, run });
  if (changed === null) {
    return { block: false, note: 'git unavailable' };
  }
  if (changed.length === 0) {
    return { block: false, note: 'no source changes' };
  }

  const failures = [];
  const typecheck = await runTypecheck({ projectRoot, run, exists, timeoutMs: typecheckTimeoutMs });
  if (typecheck.status === 'failed' || typecheck.status === 'timeout') {
    failures.push({ step: 'typecheck', status: typecheck.status, output: typecheck.output });
  }
  const tests = await runTests({ projectRoot, run, exists, timeoutMs: testTimeoutMs });
  if (tests.status === 'failed' || tests.status === 'timeout') {
    failures.push({ step: 'tests', status: tests.status, output: tests.output });
  }

  if (failures.length === 0) {
    const skipped = [typecheck, tests].every((step) => step.status === 'unavailable');
    return { block: false, note: skipped ? 'tools unavailable' : 'checks passed' };
  }
  return { block: true, reason: buildBlockReason(failures, changed, maxOutput), note: 'checks failed' };
}
