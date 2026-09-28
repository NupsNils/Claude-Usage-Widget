import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildBlockReason,
  childEnv,
  evaluateStopGate,
  listChangedSourceFiles,
  runTests,
  TEST_TIMEOUT_MS,
  vitestBinPath,
} from '../lib/test-gate.mjs';
import { tscBinPath } from '../lib/typecheck.mjs';
import { fakeRunner } from './helpers.mjs';

const ROOT = path.resolve('/virtual/Claude-Usage-Widget');
const everythingExists = () => true;

const isGit = (command) => command === 'git';
const isTsc = (args) => args[0] === tscBinPath(ROOT);
const isVitest = (args) => args[0] === vitestBinPath(ROOT);

/**
 * Fake runner for the whole gate. Each responder returns a partial RunResult.
 */
function gateRunner({ git = { stdout: ' M src/main/main.ts\n' }, tsc = { code: 0 }, vitest = { code: 0 } } = {}) {
  return fakeRunner((command, args) => {
    if (isGit(command)) return git;
    if (isTsc(args)) return typeof tsc === 'function' ? tsc(args) : tsc;
    if (isVitest(args)) return vitest;
    throw new Error(`unexpected command ${command} ${args.join(' ')}`);
  });
}

describe('childEnv', () => {
  it('disables colors and keeps the rest of the environment', () => {
    expect(childEnv({ PATH: 'x', FORCE_COLOR: '3' })).toEqual({ PATH: 'x', NO_COLOR: '1', FORCE_COLOR: '0' });
  });
});

describe('vitestBinPath', () => {
  it('points at the local Vitest CLI', () => {
    expect(vitestBinPath(ROOT)).toBe(path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'));
  });
});

describe('listChangedSourceFiles', () => {
  it('runs git status in the project root, including untracked files', async () => {
    const { run, calls } = fakeRunner(() => ({ stdout: ' M src/a.ts\n?? README.md\nR  src/x.ts -> src/y.ts\n' }));
    expect(await listChangedSourceFiles({ projectRoot: ROOT, run })).toEqual(['src/a.ts', 'src/x.ts', 'src/y.ts']);
    expect(calls).toEqual([
      {
        command: 'git',
        args: ['status', '--porcelain', '--untracked-files=all'],
        options: expect.objectContaining({ cwd: ROOT }),
      },
    ]);
  });

  it.each([
    ['git is missing', { code: null, error: new Error('spawn git ENOENT') }],
    ['not a repository', { code: 128, stderr: 'fatal: not a git repository' }],
    ['git hangs', { code: null, timedOut: true }],
  ])('returns null when %s', async (_label, response) => {
    const { run } = fakeRunner(() => response);
    expect(await listChangedSourceFiles({ projectRoot: ROOT, run })).toBeNull();
  });
});

describe('runTests', () => {
  it('is unavailable when Vitest is not installed', async () => {
    const { run, calls } = fakeRunner();
    expect(await runTests({ projectRoot: ROOT, run, exists: () => false })).toEqual({ status: 'unavailable', output: '' });
    expect(calls).toHaveLength(0);
  });

  it('runs `vitest run` with node in the project root', async () => {
    const { run, calls } = fakeRunner(() => ({ code: 0 }));
    expect(await runTests({ projectRoot: ROOT, run, exists: everythingExists })).toEqual({ status: 'passed', output: '' });
    expect(calls[0].command).toBe(process.execPath);
    expect(calls[0].args).toEqual([vitestBinPath(ROOT), 'run']);
    expect(calls[0].options).toMatchObject({ cwd: ROOT, timeoutMs: TEST_TIMEOUT_MS });
    expect(calls[0].options.env.NO_COLOR).toBe('1');
  });

  it('reports failures with output', async () => {
    const { run } = fakeRunner(() => ({ code: 1, stdout: 'FAIL src/a.test.ts > adds' }));
    const result = await runTests({ projectRoot: ROOT, run, exists: everythingExists });
    expect(result.status).toBe('failed');
    expect(result.output).toContain('$ vitest run (exit code 1)');
    expect(result.output).toContain('FAIL src/a.test.ts > adds');
  });

  it('reports timeouts', async () => {
    const { run } = fakeRunner(() => ({ code: null, timedOut: true }));
    expect((await runTests({ projectRoot: ROOT, run, exists: everythingExists, timeoutMs: 5 })).status).toBe('timeout');
  });

  it('is unavailable when node cannot be started', async () => {
    const { run } = fakeRunner(() => ({ code: null, error: new Error('EPERM') }));
    expect((await runTests({ projectRoot: ROOT, run, exists: everythingExists })).status).toBe('unavailable');
  });
});

describe('buildBlockReason', () => {
  it('names the failed steps, the changed files and includes each output', () => {
    const reason = buildBlockReason(
      [
        { step: 'typecheck', status: 'failed', output: 'error TS2322' },
        { step: 'tests', status: 'timeout', output: 'still running' },
      ],
      ['src/a.ts', 'src/b.ts'],
    );
    expect(reason).toContain('typecheck failed and tests timed out');
    expect(reason).toContain('src/a.ts, src/b.ts');
    expect(reason).toContain('[typecheck]\nerror TS2322');
    expect(reason).toContain('[tests]\nstill running');
    expect(reason).toContain('npm run typecheck');
  });

  it('limits the output and the file list', () => {
    const files = Array.from({ length: 25 }, (_, i) => `src/f${i}.ts`);
    const reason = buildBlockReason([{ step: 'tests', status: 'failed', output: 'y'.repeat(50_000) }], files, 4000);
    expect(reason.length).toBeLessThan(4600);
    expect(reason).toContain('(25 total)');
    expect(reason).not.toContain('src/f10.ts');
  });
});

describe('evaluateStopGate', () => {
  const options = (run, extra = {}) => ({ projectRoot: ROOT, run, exists: everythingExists, ...extra });

  it('returns immediately when stop_hook_active is true', async () => {
    const { run, calls } = gateRunner({ tsc: { code: 2 }, vitest: { code: 1 } });
    expect(await evaluateStopGate({ hook_event_name: 'Stop', stop_hook_active: true }, options(run))).toEqual({
      block: false,
      note: 'stop_hook_active',
    });
    expect(calls).toHaveLength(0);
  });

  it('allows stopping on unparseable input or without a project root', async () => {
    const { run, calls } = gateRunner();
    expect((await evaluateStopGate(null, options(run))).block).toBe(false);
    expect((await evaluateStopGate({ stop_hook_active: false }, { run })).block).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('allows stopping when git is unavailable', async () => {
    const { run, calls } = gateRunner({ git: { code: 128, stderr: 'fatal' } });
    expect(await evaluateStopGate({ stop_hook_active: false }, options(run))).toEqual({
      block: false,
      note: 'git unavailable',
    });
    expect(calls).toHaveLength(1);
  });

  it('skips the checks when no source files changed', async () => {
    const { run, calls } = gateRunner({ git: { stdout: ' M README.md\n?? notes/todo.txt\n' } });
    expect(await evaluateStopGate({ stop_hook_active: false }, options(run))).toEqual({
      block: false,
      note: 'no source changes',
    });
    expect(calls.map((c) => c.command)).toEqual(['git']);
  });

  it('allows stopping when typecheck and tests pass', async () => {
    const { run, calls } = gateRunner();
    expect(await evaluateStopGate({ stop_hook_active: false }, options(run))).toEqual({
      block: false,
      note: 'checks passed',
    });
    // git status, two tsc projects, one vitest run
    expect(calls).toHaveLength(4);
    expect(calls.every((c) => c.options.cwd === ROOT)).toBe(true);
  });

  it('allows stopping when the tools are not installed', async () => {
    const { run, calls } = gateRunner();
    const result = await evaluateStopGate({ stop_hook_active: false }, options(run, { exists: () => false }));
    expect(result).toEqual({ block: false, note: 'tools unavailable' });
    expect(calls).toHaveLength(1);
  });

  it('blocks on type errors and still runs the tests', async () => {
    const { run, calls } = gateRunner({ tsc: { code: 2, stdout: 'src/main/main.ts(1,1): error TS2304: nope' } });
    const result = await evaluateStopGate({ stop_hook_active: false }, options(run));
    expect(result.block).toBe(true);
    expect(result.reason).toContain('typecheck failed');
    expect(result.reason).toContain('error TS2304: nope');
    expect(result.reason).toContain('src/main/main.ts');
    expect(calls.some((c) => isVitest(c.args))).toBe(true);
  });

  it('blocks on failing tests', async () => {
    const { run } = gateRunner({ vitest: { code: 1, stdout: 'Tests  1 failed | 3 passed' } });
    const result = await evaluateStopGate({ stop_hook_active: false }, options(run));
    expect(result.block).toBe(true);
    expect(result.reason).toContain('tests failed');
    expect(result.reason).toContain('1 failed | 3 passed');
    expect(result.reason).not.toContain('typecheck failed');
  });

  it('blocks when a step times out', async () => {
    const { run } = gateRunner({ vitest: { code: null, timedOut: true } });
    const result = await evaluateStopGate({ stop_hook_active: false }, options(run));
    expect(result.block).toBe(true);
    expect(result.reason).toContain('tests timed out');
  });

  it('reports both failures within the output budget', async () => {
    const { run } = gateRunner({
      tsc: { code: 2, stdout: `TSC-START${'t'.repeat(10_000)}` },
      vitest: { code: 1, stdout: `VITEST-START${'v'.repeat(10_000)}` },
    });
    const result = await evaluateStopGate({ stop_hook_active: false }, options(run, { maxOutput: 4000 }));
    expect(result.block).toBe(true);
    expect(result.reason).toContain('TSC-START');
    expect(result.reason).toContain('VITEST-START');
    expect(result.reason.length).toBeLessThan(4800);
  });
});
