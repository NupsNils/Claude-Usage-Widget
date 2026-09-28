// Integration tests: spawn the real hook entry scripts with sample stdin.
// They never run the real TypeScript compiler or Vitest: every test points
// CLAUDE_PROJECT_DIR at a temporary project that holds fake tools (or none).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { fakeSecret, makeTempDir, removeTempDir, VARIED_BODY, writeFileDeep } from './helpers.mjs';

const HOOKS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(HOOKS_DIR, '..', '..');
const SCRIPT = {
  secretGuard: path.join(HOOKS_DIR, 'secret-guard.mjs'),
  typecheck: path.join(HOOKS_DIR, 'typecheck.mjs'),
  testGate: path.join(HOOKS_DIR, 'test-gate.mjs'),
};

const tempDirs = [];
afterAll(() => {
  for (const dir of tempDirs) removeTempDir(dir);
});

function tempDir() {
  const dir = makeTempDir();
  tempDirs.push(dir);
  return dir;
}

/** Environment for a hook run: isolated project dir, no inherited git overrides. */
function hookEnv(projectDir, extra = {}) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: projectDir, ...extra };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[key];
  return env;
}

/** Spawns a hook script with `stdin` and returns status, output and duration. */
function runHook(script, stdin, env) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [script], {
    input: typeof stdin === 'string' ? stdin : JSON.stringify(stdin),
    env,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, ms: Date.now() - started };
}

// Fake tools. They log every call to $FAKE_LOG and fail when asked to.
// process.getBuiltinModule works in both CommonJS and ESM scope.
const FAKE_TSC = `
const fs = process.getBuiltinModule('node:fs');
fs.appendFileSync(process.env.FAKE_LOG, 'tsc ' + process.argv.slice(2).join(' ') + '\\n');
if (process.env.FAKE_TSC_FAIL === '1') {
  process.stdout.write("src/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\\n");
  process.exitCode = 2;
}
`;
const FAKE_VITEST = `
const fs = process.getBuiltinModule('node:fs');
fs.appendFileSync(process.env.FAKE_LOG, 'vitest ' + process.argv.slice(2).join(' ') + '\\n');
if (process.env.FAKE_VITEST_FAIL === '1') {
  process.stdout.write('FAIL src/a.test.ts > fake failure\\n Tests  1 failed (1)\\n');
  process.exitCode = 1;
}
`;

/**
 * Creates a temporary project with fake tsc / vitest and the tsconfig files.
 * `renderer: false` omits src/renderer/tsconfig.json, which would otherwise
 * count as an untracked source file for the test gate.
 */
function fakeProject({ tsc = true, vitest = true, renderer = true } = {}) {
  const dir = tempDir();
  writeFileDeep(path.join(dir, 'tsconfig.json'), '{}\n');
  if (renderer) writeFileDeep(path.join(dir, 'src', 'renderer', 'tsconfig.json'), '{}\n');
  if (tsc) writeFileDeep(path.join(dir, 'node_modules', 'typescript', 'bin', 'tsc'), FAKE_TSC);
  if (vitest) writeFileDeep(path.join(dir, 'node_modules', 'vitest', 'vitest.mjs'), FAKE_VITEST);
  const log = path.join(dir, 'fake-calls.log');
  return { dir, log, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []) };
}

const gitAvailable = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;

function git(dir, args) {
  const result = spawnSync('git', args, { cwd: dir, env: hookEnv(dir), windowsHide: true, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

describe('secret-guard.mjs', () => {
  const env = hookEnv(tempDir());
  const secret = fakeSecret('sid01', VARIED_BODY);

  it('blocks a Write containing a session key with exit code 2 and a masked message', () => {
    const result = runHook(
      SCRIPT.secretGuard,
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: 'C:\\proj\\src\\main\\config.ts', content: `export const KEY = '${secret}';\n` },
      },
      env,
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Blocked by .claude/hooks/secret-guard.mjs');
    expect(result.stderr).toContain(secret.slice(0, 12));
    expect(result.stderr).not.toContain(secret);
    expect(result.stdout).toBe('');
  });

  it('blocks a MultiEdit when a later edit contains a token', () => {
    const result = runHook(
      SCRIPT.secretGuard,
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'MultiEdit',
        tool_input: {
          file_path: '/p/a.ts',
          edits: [
            { old_string: 'a', new_string: 'b' },
            { old_string: 'c', new_string: fakeSecret('api03', VARIED_BODY) },
          ],
        },
      },
      env,
    );
    expect(result.status).toBe(2);
  });

  it('allows clean edits and placeholders with exit code 0 and no output', () => {
    const placeholder = ['sk', 'ant', 'sid01', '...'].join('-');
    const result = runHook(
      SCRIPT.secretGuard,
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: {
          file_path: '/p/a.ts',
          old_string: 'x',
          new_string: `if (key.startsWith('${['sk', 'ant', ''].join('-')}')) { /* e.g. ${placeholder} */ }`,
        },
      },
      env,
    );
    expect(result).toMatchObject({ status: 0, stdout: '', stderr: '' });
  });

  it('fails open on unparseable or empty stdin', () => {
    expect(runHook(SCRIPT.secretGuard, 'not json at all', env).status).toBe(0);
    expect(runHook(SCRIPT.secretGuard, '', env).status).toBe(0);
  });
});

describe('typecheck.mjs', () => {
  it('exits 0 quickly and silently for a non-TypeScript file', () => {
    const project = fakeProject();
    const env = hookEnv(project.dir, { FAKE_LOG: project.log, FAKE_TSC_FAIL: '1' });
    const result = runHook(
      SCRIPT.typecheck,
      { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: path.join(project.dir, 'README.md') } },
      env,
    );
    expect(result).toMatchObject({ status: 0, stdout: '', stderr: '' });
    expect(result.ms).toBeLessThan(10_000);
    expect(project.calls()).toEqual([]);
  });

  it('ignores TypeScript files outside the project', () => {
    const project = fakeProject();
    const env = hookEnv(project.dir, { FAKE_LOG: project.log, FAKE_TSC_FAIL: '1' });
    const outside = path.join(tempDir(), 'src', 'a.ts');
    const result = runHook(SCRIPT.typecheck, { tool_name: 'Edit', tool_input: { file_path: outside } }, env);
    expect(result).toMatchObject({ status: 0, stdout: '', stderr: '' });
    expect(project.calls()).toEqual([]);
  });

  it('exits 0 silently when TypeScript is not installed', () => {
    const project = fakeProject({ tsc: false });
    const env = hookEnv(project.dir, { FAKE_LOG: project.log });
    const result = runHook(
      SCRIPT.typecheck,
      { tool_name: 'Edit', tool_input: { file_path: path.join(project.dir, 'src', 'a.ts') } },
      env,
    );
    expect(result).toMatchObject({ status: 0, stdout: '', stderr: '' });
  });

  it('exits 2 with the compiler output when the (fake) compiler reports errors', () => {
    const project = fakeProject();
    const env = hookEnv(project.dir, { FAKE_LOG: project.log, FAKE_TSC_FAIL: '1' });
    const result = runHook(
      SCRIPT.typecheck,
      { tool_name: 'Edit', tool_input: { file_path: path.join(project.dir, 'src', 'a.ts') } },
      env,
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('after editing src/a.ts');
    expect(result.stderr).toContain('error TS2322');
    expect(project.calls()).toEqual([
      'tsc -p tsconfig.json --noEmit',
      'tsc -p src/renderer/tsconfig.json --noEmit',
    ]);
  });

  it('exits 0 silently when the (fake) compiler succeeds', () => {
    const project = fakeProject();
    const env = hookEnv(project.dir, { FAKE_LOG: project.log });
    const result = runHook(
      SCRIPT.typecheck,
      { tool_name: 'Write', tool_input: { file_path: path.join(project.dir, 'src', 'main', 'main.ts') } },
      env,
    );
    expect(result).toMatchObject({ status: 0, stdout: '', stderr: '' });
    expect(project.calls()).toHaveLength(2);
  });
});

describe('test-gate.mjs', () => {
  it('exits 0 immediately without running anything when stop_hook_active is true', () => {
    const project = fakeProject();
    const env = hookEnv(project.dir, { FAKE_LOG: project.log, FAKE_TSC_FAIL: '1', FAKE_VITEST_FAIL: '1' });
    const result = runHook(SCRIPT.testGate, { hook_event_name: 'Stop', stop_hook_active: true }, env);
    expect(result).toMatchObject({ status: 0, stdout: '', stderr: '' });
    expect(result.ms).toBeLessThan(10_000);
    expect(project.calls()).toEqual([]);
  });

  it('exits 0 on unparseable stdin', () => {
    const project = fakeProject();
    const result = runHook(SCRIPT.testGate, '{oops', hookEnv(project.dir, { FAKE_LOG: project.log }));
    expect(result).toMatchObject({ status: 0, stdout: '' });
    expect(project.calls()).toEqual([]);
  });

  it.skipIf(!gitAvailable)('exits 0 silently when the project is not a git repository', () => {
    const project = fakeProject();
    const env = hookEnv(project.dir, {
      FAKE_LOG: project.log,
      FAKE_TSC_FAIL: '1',
      GIT_CEILING_DIRECTORIES: path.dirname(project.dir),
    });
    const result = runHook(SCRIPT.testGate, { hook_event_name: 'Stop', stop_hook_active: false }, env);
    expect(result).toMatchObject({ status: 0, stdout: '' });
    expect(project.calls()).toEqual([]);
  });

  it.skipIf(!gitAvailable)('does not run the checks when only non-source files changed', () => {
    const project = fakeProject({ renderer: false });
    git(project.dir, ['init', '-q']);
    writeFileDeep(path.join(project.dir, 'docs', 'notes.md'), '# notes\n');
    const env = hookEnv(project.dir, { FAKE_LOG: project.log, FAKE_TSC_FAIL: '1' });
    const result = runHook(SCRIPT.testGate, { hook_event_name: 'Stop', stop_hook_active: false }, env);
    expect(result).toMatchObject({ status: 0, stdout: '' });
    expect(project.calls()).toEqual([]);
  });

  it.skipIf(!gitAvailable)('prints a block decision when source changed and the (fake) checks fail', () => {
    const project = fakeProject();
    git(project.dir, ['init', '-q']);
    writeFileDeep(path.join(project.dir, 'src', 'a.ts'), 'export const a: number = 1;\n');
    const env = hookEnv(project.dir, { FAKE_LOG: project.log, FAKE_TSC_FAIL: '1', FAKE_VITEST_FAIL: '1' });
    const result = runHook(SCRIPT.testGate, { hook_event_name: 'Stop', stop_hook_active: false }, env);
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.decision).toBe('block');
    expect(output.reason).toContain('typecheck failed and tests failed');
    expect(output.reason).toContain('src/a.ts');
    expect(output.reason).toContain('error TS2322');
    expect(output.reason).toContain('fake failure');
    expect(project.calls()).toEqual([
      'tsc -p tsconfig.json --noEmit',
      'tsc -p src/renderer/tsconfig.json --noEmit',
      'vitest run',
    ]);
  });

  it.skipIf(!gitAvailable)('allows stopping silently when the (fake) checks pass', () => {
    const project = fakeProject();
    git(project.dir, ['init', '-q']);
    writeFileDeep(path.join(project.dir, 'scripts', 'build.mjs'), 'export {};\n');
    const env = hookEnv(project.dir, { FAKE_LOG: project.log });
    const result = runHook(SCRIPT.testGate, { hook_event_name: 'Stop', stop_hook_active: false }, env);
    expect(result).toMatchObject({ status: 0, stdout: '' });
    expect(project.calls()).toHaveLength(3);
  });
});

describe('.claude/settings.json', () => {
  const settings = JSON.parse(readFileSync(path.join(REPO_ROOT, '.claude', 'settings.json'), 'utf8'));

  const registrations = (event) => (settings.hooks[event] || []).flatMap((group) => group.hooks.map((hook) => ({ group, hook })));

  it.each([
    ['PreToolUse', 'Write|Edit|MultiEdit|NotebookEdit', 'secret-guard.mjs'],
    ['PostToolUse', 'Write|Edit|MultiEdit', 'typecheck.mjs'],
    ['Stop', undefined, 'test-gate.mjs'],
  ])('registers %s -> %s', (event, matcher, script) => {
    const entries = registrations(event).filter(({ hook }) => hook.args?.[0]?.endsWith(`/.claude/hooks/${script}`));
    expect(entries).toHaveLength(1);
    const { group, hook } = entries[0];
    expect(group.matcher).toBe(matcher);
    expect(hook.type).toBe('command');
    // Exec form: no shell, the placeholder is substituted into the argument.
    expect(hook.command).toBe('node');
    expect(hook.args).toEqual([`\${CLAUDE_PROJECT_DIR}/.claude/hooks/${script}`]);
    expect(hook.timeout).toBeGreaterThan(0);
    expect(existsSync(path.join(REPO_ROOT, '.claude', 'hooks', script))).toBe(true);
  });

  it('gives the Stop hook enough time for typecheck plus tests', () => {
    const [{ hook }] = registrations('Stop');
    expect(hook.timeout).toBeGreaterThanOrEqual(270);
  });
});
