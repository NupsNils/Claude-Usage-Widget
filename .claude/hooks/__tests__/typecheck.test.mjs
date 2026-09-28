import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  evaluateTypecheckHook,
  formatCommandFailure,
  isTypeScriptFile,
  runTypecheck,
  shouldTypecheck,
  tscBinPath,
  TYPECHECK_PROJECTS,
  TYPECHECK_TIMEOUT_MS,
  typecheckCommands,
} from '../lib/typecheck.mjs';
import { fakeRunner, runResult } from './helpers.mjs';

const ROOT = path.resolve('/virtual/Claude-Usage-Widget');
const WIN_ROOT = 'C:\\Users\\me\\Claude-Usage-Widget';
const everythingExists = () => true;
const isTscCall = (args) => args[0] === tscBinPath(ROOT);

describe('isTypeScriptFile', () => {
  it.each(['a.ts', 'a.mts', 'a.cts', 'a.tsx', 'types.d.ts', 'UPPER.TS', 'C:\\p\\src\\x.ts'])('accepts %s', (file) => {
    expect(isTypeScriptFile(file)).toBe(true);
  });

  it.each(['a.js', 'a.mjs', 'a.json', 'a.ts.bak', 'README.md', 'ts', ''])('rejects %s', (file) => {
    expect(isTypeScriptFile(file)).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(isTypeScriptFile(undefined)).toBe(false);
    expect(isTypeScriptFile(null)).toBe(false);
    expect(isTypeScriptFile(42)).toBe(false);
  });
});

describe('shouldTypecheck', () => {
  it('accepts TypeScript files inside the project, including Windows backslash paths', () => {
    expect(shouldTypecheck(`${WIN_ROOT}\\src\\main\\main.ts`, WIN_ROOT)).toBe(true);
    expect(shouldTypecheck(`${WIN_ROOT}\\vitest.config.ts`, WIN_ROOT)).toBe(true);
    expect(shouldTypecheck('c:/users/me/claude-usage-widget/src/shared/x.tsx', WIN_ROOT)).toBe(true);
  });

  it('rejects files outside the project', () => {
    expect(shouldTypecheck('C:\\Users\\me\\other-project\\src\\a.ts', WIN_ROOT)).toBe(false);
    expect(shouldTypecheck(`${WIN_ROOT}-copy\\src\\a.ts`, WIN_ROOT)).toBe(false);
    expect(shouldTypecheck(`${WIN_ROOT}\\..\\a.ts`, WIN_ROOT)).toBe(false);
  });

  it('rejects node_modules at any depth and top-level dist/ and release/', () => {
    expect(shouldTypecheck(`${WIN_ROOT}\\node_modules\\pkg\\index.d.ts`, WIN_ROOT)).toBe(false);
    expect(shouldTypecheck(`${WIN_ROOT}\\src\\node_modules\\x.ts`, WIN_ROOT)).toBe(false);
    expect(shouldTypecheck(`${WIN_ROOT}\\dist\\main\\main.ts`, WIN_ROOT)).toBe(false);
    expect(shouldTypecheck(`${WIN_ROOT}\\release\\x.ts`, WIN_ROOT)).toBe(false);
    expect(shouldTypecheck(`${WIN_ROOT}\\Dist\\x.ts`, WIN_ROOT)).toBe(false);
  });

  it('accepts nested folders that are merely named dist or release', () => {
    expect(shouldTypecheck(`${WIN_ROOT}\\src\\release\\notes.ts`, WIN_ROOT)).toBe(true);
    expect(shouldTypecheck(`${WIN_ROOT}\\src\\dist-utils.ts`, WIN_ROOT)).toBe(true);
  });

  it('rejects non-TypeScript files and missing paths', () => {
    expect(shouldTypecheck(`${WIN_ROOT}\\src\\renderer\\index.html`, WIN_ROOT)).toBe(false);
    expect(shouldTypecheck(`${WIN_ROOT}\\README.md`, WIN_ROOT)).toBe(false);
    expect(shouldTypecheck(undefined, WIN_ROOT)).toBe(false);
  });

  it('works with POSIX roots', () => {
    expect(shouldTypecheck('/home/me/proj/src/a.ts', '/home/me/proj')).toBe(true);
    expect(shouldTypecheck('/home/me/elsewhere/a.ts', '/home/me/proj')).toBe(false);
  });
});

describe('tscBinPath', () => {
  it('points at the local TypeScript bin', () => {
    expect(tscBinPath(ROOT)).toBe(path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'));
  });
});

describe('typecheckCommands', () => {
  it('mirrors npm run typecheck using node and the local tsc', () => {
    expect(TYPECHECK_PROJECTS).toEqual(['tsconfig.json', 'src/renderer/tsconfig.json']);
    expect(typecheckCommands(ROOT, everythingExists)).toEqual([
      {
        label: 'tsc -p tsconfig.json --noEmit',
        command: process.execPath,
        args: [tscBinPath(ROOT), '-p', 'tsconfig.json', '--noEmit'],
      },
      {
        label: 'tsc -p src/renderer/tsconfig.json --noEmit',
        command: process.execPath,
        args: [tscBinPath(ROOT), '-p', 'src/renderer/tsconfig.json', '--noEmit'],
      },
    ]);
  });

  it('skips tsconfig projects that do not exist', () => {
    const exists = (file) => !file.endsWith(path.join('renderer', 'tsconfig.json'));
    expect(typecheckCommands(ROOT, exists).map((c) => c.label)).toEqual(['tsc -p tsconfig.json --noEmit']);
  });
});

describe('formatCommandFailure', () => {
  it('includes the command, exit code and output', () => {
    const text = formatCommandFailure('tsc -p x', runResult({ code: 2, stdout: 'error TS1\n', stderr: 'warn\n' }));
    expect(text).toBe('$ tsc -p x (exit code 2)\nerror TS1\nwarn');
  });

  it('reports timeouts and missing output', () => {
    expect(formatCommandFailure('vitest run', runResult({ code: null, timedOut: true }))).toBe(
      '$ vitest run (timed out)\n(no output)',
    );
  });
});

describe('runTypecheck', () => {
  it('is unavailable when the local TypeScript is not installed', async () => {
    const { run, calls } = fakeRunner();
    const result = await runTypecheck({ projectRoot: ROOT, run, exists: () => false });
    expect(result.status).toBe('unavailable');
    expect(calls).toHaveLength(0);
  });

  it('is unavailable when no tsconfig exists', async () => {
    const { run, calls } = fakeRunner();
    const exists = (file) => file === tscBinPath(ROOT);
    expect((await runTypecheck({ projectRoot: ROOT, run, exists })).status).toBe('unavailable');
    expect(calls).toHaveLength(0);
  });

  it('passes when both projects compile, running both in the project root', async () => {
    const { run, calls } = fakeRunner(() => ({ code: 0 }));
    const result = await runTypecheck({ projectRoot: ROOT, run, exists: everythingExists });
    expect(result).toEqual({ status: 'passed', output: '' });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.command).toBe(process.execPath);
      expect(isTscCall(call.args)).toBe(true);
      expect(call.options.cwd).toBe(ROOT);
      expect(call.options.timeoutMs).toBeGreaterThan(0);
      expect(call.options.timeoutMs).toBeLessThanOrEqual(TYPECHECK_TIMEOUT_MS);
    }
  });

  it('runs every project and reports all failures', async () => {
    const { run, calls } = fakeRunner((command, args) => ({
      code: 2,
      stdout: `${args[2]}(1,1): error TS2322: broken`,
    }));
    const result = await runTypecheck({ projectRoot: ROOT, run, exists: everythingExists });
    expect(calls).toHaveLength(2);
    expect(result.status).toBe('failed');
    expect(result.output).toContain('$ tsc -p tsconfig.json --noEmit (exit code 2)');
    expect(result.output).toContain('src/renderer/tsconfig.json(1,1): error TS2322: broken');
  });

  it('stops and reports a timeout', async () => {
    const { run, calls } = fakeRunner(() => ({ code: null, timedOut: true, stdout: 'partial' }));
    const result = await runTypecheck({ projectRoot: ROOT, run, exists: everythingExists });
    expect(calls).toHaveLength(1);
    expect(result.status).toBe('timeout');
    expect(result.output).toContain('(timed out)');
  });

  it('shares one time budget across the commands', async () => {
    let clock = 0;
    const { run, calls } = fakeRunner(() => {
      clock += 1500;
      return { code: 0 };
    });
    const result = await runTypecheck({ projectRoot: ROOT, run, exists: everythingExists, timeoutMs: 1000, now: () => clock });
    expect(calls).toHaveLength(1);
    expect(calls[0].options.timeoutMs).toBe(1000);
    expect(result.status).toBe('timeout');
    expect(result.output).toContain('time budget');
  });

  it('is unavailable when the compiler cannot be started', async () => {
    const { run } = fakeRunner(() => ({ code: null, error: new Error('spawn failed') }));
    expect((await runTypecheck({ projectRoot: ROOT, run, exists: everythingExists })).status).toBe('unavailable');
  });
});

describe('evaluateTypecheckHook', () => {
  const input = (filePath) => ({ tool_name: 'Edit', tool_input: { file_path: filePath } });

  it('does nothing for non-TypeScript files', async () => {
    const { run, calls } = fakeRunner();
    const result = await evaluateTypecheckHook(input(path.join(ROOT, 'README.md')), {
      projectRoot: ROOT,
      run,
      exists: everythingExists,
    });
    expect(result).toEqual({ exitCode: 0, stderr: '' });
    expect(calls).toHaveLength(0);
  });

  it('does nothing for files outside the project, invalid input or a missing root', async () => {
    const { run, calls } = fakeRunner();
    const deps = { projectRoot: ROOT, run, exists: everythingExists };
    expect(await evaluateTypecheckHook(input(path.resolve('/other/a.ts')), deps)).toEqual({ exitCode: 0, stderr: '' });
    expect(await evaluateTypecheckHook(null, deps)).toEqual({ exitCode: 0, stderr: '' });
    expect(await evaluateTypecheckHook({ tool_input: {} }, deps)).toEqual({ exitCode: 0, stderr: '' });
    expect(await evaluateTypecheckHook(input(path.join(ROOT, 'src', 'a.ts')), { run })).toEqual({
      exitCode: 0,
      stderr: '',
    });
    expect(calls).toHaveLength(0);
  });

  it('exits 2 with trimmed compiler output on type errors', async () => {
    const { run } = fakeRunner(() => ({ code: 2, stdout: `src/a.ts(3,5): error TS2322: bad\n${'x'.repeat(20_000)}` }));
    const result = await evaluateTypecheckHook(input(path.join(ROOT, 'src', 'a.ts')), {
      projectRoot: ROOT,
      run,
      exists: everythingExists,
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('after editing src/a.ts');
    expect(result.stderr).toContain('error TS2322: bad');
    expect(result.stderr.length).toBeLessThan(4400);
  });

  it.each([
    ['passed', { code: 0 }],
    ['timed out', { code: null, timedOut: true }],
    ['could not start', { code: null, error: new Error('nope') }],
  ])('exits 0 silently when the compiler %s', async (_label, response) => {
    const { run } = fakeRunner(() => response);
    const result = await evaluateTypecheckHook(input(path.join(ROOT, 'src', 'a.ts')), {
      projectRoot: ROOT,
      run,
      exists: everythingExists,
    });
    expect(result).toEqual({ exitCode: 0, stderr: '' });
  });

  it('exits 0 silently when TypeScript is not installed', async () => {
    const { run, calls } = fakeRunner();
    const result = await evaluateTypecheckHook(input(path.join(ROOT, 'src', 'a.ts')), {
      projectRoot: ROOT,
      run,
      exists: () => false,
    });
    expect(result).toEqual({ exitCode: 0, stderr: '' });
    expect(calls).toHaveLength(0);
  });
});
