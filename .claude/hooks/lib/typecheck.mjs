// Type checking helpers shared by the PostToolUse typecheck hook and the Stop
// test gate. Mirrors `npm run typecheck` without going through npm or a shell.

import { existsSync } from 'node:fs';
import path from 'node:path';

import { relativeToProject, runProcess, trimOutput } from './common.mjs';

/** Default time budget for all typecheck commands together. */
export const TYPECHECK_TIMEOUT_MS = 90_000;

/** The tsconfig projects checked by `npm run typecheck`, in order. */
export const TYPECHECK_PROJECTS = ['tsconfig.json', 'src/renderer/tsconfig.json'];

const TYPESCRIPT_EXTENSION = /\.(?:ts|mts|cts|tsx)$/i;
const EXCLUDED_TOP_LEVEL_DIRS = new Set(['dist', 'release']);

/**
 * @param {unknown} filePath
 * @returns {boolean}
 */
export function isTypeScriptFile(filePath) {
  return typeof filePath === 'string' && TYPESCRIPT_EXTENSION.test(filePath.trim());
}

/**
 * True when an edited file should trigger a typecheck: a TypeScript file inside
 * the project that is not under node_modules/, dist/ or release/.
 *
 * @param {unknown} filePath
 * @param {string} projectRoot
 * @returns {boolean}
 */
export function shouldTypecheck(filePath, projectRoot) {
  if (!isTypeScriptFile(filePath)) {
    return false;
  }
  const relative = relativeToProject(/** @type {string} */ (filePath), projectRoot);
  if (!relative) {
    return false;
  }
  const segments = relative.split('/');
  if (segments.some((segment) => segment.toLowerCase() === 'node_modules')) {
    return false;
  }
  return !EXCLUDED_TOP_LEVEL_DIRS.has(segments[0].toLowerCase());
}

/**
 * Absolute path of the locally installed TypeScript compiler entry point.
 *
 * @param {string} projectRoot
 * @returns {string}
 */
export function tscBinPath(projectRoot) {
  return path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc');
}

/**
 * The typecheck commands to run, skipping tsconfig projects that do not exist.
 *
 * @param {string} projectRoot
 * @param {(file: string) => boolean} [exists]
 * @returns {{ label: string, command: string, args: string[] }[]}
 */
export function typecheckCommands(projectRoot, exists = existsSync) {
  const tsc = tscBinPath(projectRoot);
  return TYPECHECK_PROJECTS.filter((project) => exists(path.join(projectRoot, project))).map((project) => ({
    label: `tsc -p ${project} --noEmit`,
    command: process.execPath,
    args: [tsc, '-p', project, '--noEmit'],
  }));
}

/**
 * @typedef {object} StepResult
 * @property {'passed' | 'failed' | 'timeout' | 'unavailable'} status
 * @property {string} output   Combined output of the failed or timed out commands.
 */

/**
 * Formats the output of one failed command.
 *
 * @param {string} label
 * @param {import('./common.mjs').RunResult} result
 * @returns {string}
 */
export function formatCommandFailure(label, result) {
  const how = result.timedOut ? 'timed out' : `exit code ${result.code ?? result.signal ?? 'unknown'}`;
  const body = [result.stdout, result.stderr].map((part) => (part || '').trim()).filter(Boolean).join('\n');
  return `$ ${label} (${how})\n${body || '(no output)'}`;
}

/**
 * Runs every typecheck command (all of them, so Claude sees every error at
 * once) within a shared time budget.
 *
 * @param {{ projectRoot: string, run?: typeof runProcess, exists?: (file: string) => boolean,
 *           timeoutMs?: number, now?: () => number }} options
 * @returns {Promise<StepResult>}
 */
export async function runTypecheck({
  projectRoot,
  run = runProcess,
  exists = existsSync,
  timeoutMs = TYPECHECK_TIMEOUT_MS,
  now = Date.now,
}) {
  if (!exists(tscBinPath(projectRoot))) {
    return { status: 'unavailable', output: '' };
  }
  const commands = typecheckCommands(projectRoot, exists);
  if (commands.length === 0) {
    return { status: 'unavailable', output: '' };
  }
  const deadline = now() + timeoutMs;
  const failures = [];
  let ran = 0;
  for (const { label, command, args } of commands) {
    const remaining = deadline - now();
    if (remaining <= 0) {
      failures.push(`$ ${label} (skipped: time budget of ${Math.round(timeoutMs / 1000)}s exhausted)`);
      return { status: 'timeout', output: failures.join('\n\n') };
    }
    const result = await run(command, args, { cwd: projectRoot, timeoutMs: remaining });
    if (result.error && !result.timedOut) {
      // The compiler could not be started at all.
      continue;
    }
    ran += 1;
    if (result.timedOut) {
      failures.push(formatCommandFailure(label, result));
      return { status: 'timeout', output: failures.join('\n\n') };
    }
    if (result.code !== 0) {
      failures.push(formatCommandFailure(label, result));
    }
  }
  if (ran === 0) {
    return { status: 'unavailable', output: '' };
  }
  return failures.length > 0
    ? { status: 'failed', output: failures.join('\n\n') }
    : { status: 'passed', output: '' };
}

/**
 * Decides the outcome of the PostToolUse typecheck hook.
 * Exit code 2 feeds stderr back to Claude; exit 0 stays silent.
 *
 * @param {Record<string, any> | null} input  Parsed hook payload.
 * @param {{ projectRoot: string, run?: typeof runProcess, exists?: (file: string) => boolean,
 *           timeoutMs?: number, maxOutput?: number }} options
 * @returns {Promise<{ exitCode: 0 | 2, stderr: string }>}
 */
export async function evaluateTypecheckHook(input, { projectRoot, run, exists, timeoutMs, maxOutput } = /** @type {any} */ ({})) {
  const filePath = input && input.tool_input && input.tool_input.file_path;
  if (!projectRoot || !shouldTypecheck(filePath, projectRoot)) {
    return { exitCode: 0, stderr: '' };
  }
  const result = await runTypecheck({ projectRoot, run, exists, timeoutMs });
  if (result.status !== 'failed') {
    // Passed, timed out or no local TypeScript: never block editing on that.
    return { exitCode: 0, stderr: '' };
  }
  const relative = relativeToProject(filePath, projectRoot);
  const stderr =
    `TypeScript errors in the project after editing ${relative} ` +
    `(reported by .claude/hooks/typecheck.mjs, equivalent to npm run typecheck):\n` +
    trimOutput(result.output, maxOutput);
  return { exitCode: 2, stderr };
}
