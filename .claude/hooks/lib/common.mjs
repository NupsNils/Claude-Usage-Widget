// Shared helpers for the project's Claude Code hooks.
// Node standard library only; every function here is pure or takes its
// side-effecting dependencies as parameters so it can be unit tested.

import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Default size limit for tool output that is shown to Claude. */
export const DEFAULT_MAX_OUTPUT = 4000;

/**
 * Resolves the project root directory.
 * Prefers $CLAUDE_PROJECT_DIR (set by Claude Code for every hook) and falls back
 * to two directories above the entry script (<root>/.claude/hooks/<script>.mjs).
 * Never relies on process.cwd().
 *
 * @param {{ env?: Record<string, string | undefined>, scriptUrl: string | URL }} options
 * @returns {string}
 */
export function resolveProjectRoot({ env = {}, scriptUrl }) {
  const fromEnv = typeof env.CLAUDE_PROJECT_DIR === 'string' ? env.CLAUDE_PROJECT_DIR.trim() : '';
  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  const scriptDir = path.dirname(fileURLToPath(scriptUrl));
  return path.resolve(scriptDir, '..', '..');
}

/**
 * Reads a readable stream to the end and returns its content as UTF-8 text.
 * Returns an empty string for interactive terminals so a manual run never hangs.
 *
 * @param {NodeJS.ReadableStream & { isTTY?: boolean }} stream
 * @returns {Promise<string>}
 */
export async function readStdin(stream) {
  if (!stream || stream.isTTY) {
    return '';
  }
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Parses the JSON document Claude Code writes to a hook's stdin.
 * Returns null for anything that is not a JSON object (the hooks fail open).
 *
 * @param {string} text
 * @returns {Record<string, any> | null}
 */
export function parseHookInput(text) {
  if (typeof text !== 'string') {
    return null;
  }
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  if (!trimmed) {
    return null;
  }
  try {
    const value = JSON.parse(trimmed);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// Matches CSI / OSC style ANSI escape sequences (colors, cursor movement).
const ANSI_PATTERN = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)|[@-Z\\-_])/g;

/**
 * Removes ANSI escape sequences from terminal output.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripAnsi(text) {
  return String(text ?? '').replace(ANSI_PATTERN, '');
}

/**
 * Cleans tool output for display to Claude: strips ANSI codes, normalizes line
 * endings, trims surrounding whitespace and, when the result is longer than
 * `maxChars`, keeps the head and the tail around an omission marker (compiler
 * errors start at the top, test summaries end at the bottom).
 *
 * @param {string} text
 * @param {number} [maxChars]
 * @returns {string}
 */
export function trimOutput(text, maxChars = DEFAULT_MAX_OUTPUT) {
  const clean = stripAnsi(text).replace(/\r\n?/g, '\n').trim();
  if (clean.length <= maxChars) {
    return clean;
  }
  const marker = (omitted) => `\n... [${omitted} characters omitted] ...\n`;
  // Reserve room for the marker, sized for the worst case.
  const budget = Math.max(0, maxChars - marker(clean.length).length);
  if (budget === 0) {
    return clean.slice(0, Math.max(0, maxChars));
  }
  const headLength = Math.ceil(budget * 0.6);
  const tailLength = budget - headLength;
  const omitted = clean.length - headLength - tailLength;
  const head = clean.slice(0, headLength);
  const tail = tailLength > 0 ? clean.slice(clean.length - tailLength) : '';
  return `${head}${marker(omitted)}${tail}`;
}

/**
 * Converts a path to forward slashes and maps MSYS/Git Bash drive paths
 * (/c/Users/...) to Windows drive paths (C:/Users/...).
 *
 * @param {string} value
 * @returns {string}
 */
export function toForwardSlashes(value) {
  let result = String(value).replace(/\\/g, '/');
  const msys = /^\/([a-zA-Z])(\/|$)/.exec(result);
  if (msys) {
    result = `${msys[1].toUpperCase()}:/${result.slice(3)}`;
  }
  return result;
}

/**
 * Returns the path of `filePath` relative to `projectRoot` using forward
 * slashes, or null when the file is outside the project (or is the root).
 * Handles Windows backslash paths, mixed separators and `..` segments.
 * Relative input paths are interpreted relative to the project root.
 *
 * @param {string} filePath
 * @param {string} projectRoot
 * @returns {string | null}
 */
export function relativeToProject(filePath, projectRoot) {
  if (typeof filePath !== 'string' || !filePath.trim() || typeof projectRoot !== 'string' || !projectRoot.trim()) {
    return null;
  }
  const root = path.posix.normalize(toForwardSlashes(projectRoot.trim())).replace(/\/+$/, '');
  let file = toForwardSlashes(filePath.trim());
  const isAbsolute = file.startsWith('/') || /^[a-zA-Z]:\//.test(file);
  file = path.posix.normalize(isAbsolute ? file : `${root}/${file}`);

  // Windows file systems are case-insensitive; compare accordingly.
  const windowsLike = /^[a-zA-Z]:/.test(root) || /^[a-zA-Z]:/.test(file);
  const rootKey = windowsLike ? root.toLowerCase() : root;
  const fileKey = windowsLike ? file.toLowerCase() : file;
  if (!fileKey.startsWith(`${rootKey}/`)) {
    return null;
  }
  const relative = file.slice(root.length + 1);
  if (!relative || relative === '..' || relative.startsWith('../')) {
    return null;
  }
  return relative;
}

/**
 * Kills a child process and its descendants (tsc and vitest spawn children).
 *
 * @param {import('node:child_process').ChildProcess} child
 */
function killProcessTree(child) {
  if (!child || child.pid === undefined) {
    return;
  }
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      // The child was started as a process group leader (detached), so the
      // negative pid addresses the whole group.
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // The process is already gone.
    }
  }
}

/**
 * @typedef {object} RunResult
 * @property {number | null} code      Exit code, null if the process did not exit normally.
 * @property {string | null} signal    Terminating signal, if any.
 * @property {string} stdout
 * @property {string} stderr
 * @property {boolean} timedOut        True when the process was killed after `timeoutMs`.
 * @property {Error | null} error      Set when the process could not be started.
 */

/**
 * Runs a command without a shell and collects its output.
 * Never rejects: spawn failures are reported through `result.error`.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, timeoutMs?: number, env?: Record<string, string | undefined>, maxBufferBytes?: number }} [options]
 * @returns {Promise<RunResult>}
 */
export function runProcess(command, args, options = {}) {
  const { cwd, timeoutMs = 0, env = process.env, maxBufferBytes = 2_000_000 } = options;
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let timer = null;
    let stdout = '';
    let stderr = '';
    /** @type {Error | null} */
    let spawnError = null;

    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, signal: signal ?? null, stdout, stderr, timedOut, error: spawnError });
    };

    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      spawnError = error instanceof Error ? error : new Error(String(error));
      finish(null, null);
      return;
    }

    const append = (current, chunk) =>
      current.length >= maxBufferBytes ? current : current + chunk.toString('utf8').slice(0, maxBufferBytes - current.length);
    child.stdout?.on('data', (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = append(stderr, chunk);
    });

    child.on('error', (error) => {
      spawnError = error;
      // If the process never started there will be no meaningful exit.
      if (child.pid === undefined) finish(null, null);
    });
    child.on('close', (code, signal) => finish(code, signal));

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child);
      }, timeoutMs);
    }
  });
}
