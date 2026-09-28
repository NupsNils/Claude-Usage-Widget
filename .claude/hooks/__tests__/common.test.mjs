import path from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MAX_OUTPUT,
  parseHookInput,
  readStdin,
  relativeToProject,
  resolveProjectRoot,
  runProcess,
  stripAnsi,
  toForwardSlashes,
  trimOutput,
} from '../lib/common.mjs';
import { makeTempDir, removeTempDir } from './helpers.mjs';

describe('resolveProjectRoot', () => {
  const projectRoot = path.resolve('/some/project');
  const scriptUrl = pathToFileURL(path.join(projectRoot, '.claude', 'hooks', 'hook.mjs'));

  it('prefers CLAUDE_PROJECT_DIR', () => {
    const fromEnv = path.resolve('/elsewhere/root');
    expect(resolveProjectRoot({ env: { CLAUDE_PROJECT_DIR: fromEnv }, scriptUrl })).toBe(fromEnv);
  });

  it('falls back to two directories above the script when the variable is missing', () => {
    expect(resolveProjectRoot({ env: {}, scriptUrl })).toBe(projectRoot);
    expect(resolveProjectRoot({ scriptUrl: scriptUrl.href })).toBe(projectRoot);
  });

  it('ignores an empty or whitespace-only CLAUDE_PROJECT_DIR', () => {
    expect(resolveProjectRoot({ env: { CLAUDE_PROJECT_DIR: '   ' }, scriptUrl })).toBe(projectRoot);
    expect(resolveProjectRoot({ env: { CLAUDE_PROJECT_DIR: '' }, scriptUrl })).toBe(projectRoot);
  });
});

describe('readStdin', () => {
  it('concatenates buffer and string chunks', async () => {
    const stream = Readable.from([Buffer.from('{"a":'), '1}']);
    expect(await readStdin(stream)).toBe('{"a":1}');
  });

  it('decodes multi-byte UTF-8 characters split across chunks', async () => {
    const bytes = Buffer.from('"\u00e4\u20ac"', 'utf8');
    const stream = Readable.from([bytes.subarray(0, 2), bytes.subarray(2)]);
    expect(await readStdin(stream)).toBe('"\u00e4\u20ac"');
  });

  it('returns an empty string for a TTY or a missing stream', async () => {
    const tty = Readable.from(['ignored']);
    tty.isTTY = true;
    expect(await readStdin(tty)).toBe('');
    expect(await readStdin(undefined)).toBe('');
  });
});

describe('parseHookInput', () => {
  it('parses a JSON object', () => {
    expect(parseHookInput('{"tool_name":"Write"}')).toEqual({ tool_name: 'Write' });
  });

  it('tolerates a byte order mark and surrounding whitespace', () => {
    expect(parseHookInput('\uFEFF  {"a":1}\n')).toEqual({ a: 1 });
  });

  it('returns null for empty, invalid or non-object input', () => {
    expect(parseHookInput('')).toBeNull();
    expect(parseHookInput('   ')).toBeNull();
    expect(parseHookInput('not json')).toBeNull();
    expect(parseHookInput('{"broken":')).toBeNull();
    expect(parseHookInput('[1,2]')).toBeNull();
    expect(parseHookInput('null')).toBeNull();
    expect(parseHookInput('42')).toBeNull();
    expect(parseHookInput(undefined)).toBeNull();
  });
});

describe('stripAnsi', () => {
  it('removes color and cursor escape sequences', () => {
    expect(stripAnsi('\u001b[31mred\u001b[39m \u001b[1mbold\u001b[22m\u001b[2K')).toBe('red bold');
  });

  it('handles null and undefined', () => {
    expect(stripAnsi(undefined)).toBe('');
    expect(stripAnsi(null)).toBe('');
  });
});

describe('trimOutput', () => {
  it('returns short output unchanged apart from trimming and newline normalization', () => {
    expect(trimOutput('  line1\r\nline2\rline3  \n')).toBe('line1\nline2\nline3');
  });

  it('strips ANSI codes', () => {
    expect(trimOutput('\u001b[32mok\u001b[39m')).toBe('ok');
  });

  it('keeps head and tail of long output within the limit', () => {
    const text = `HEAD-${'a'.repeat(10_000)}${'b'.repeat(10_000)}-TAIL`;
    const result = trimOutput(text, 1000);
    expect(result.length).toBeLessThanOrEqual(1000);
    expect(result.startsWith('HEAD-')).toBe(true);
    expect(result.endsWith('-TAIL')).toBe(true);
    expect(result).toMatch(/\[\d+ characters omitted\]/);
  });

  it('uses the default limit of about 4000 characters', () => {
    const result = trimOutput('x'.repeat(50_000));
    expect(DEFAULT_MAX_OUTPUT).toBe(4000);
    expect(result.length).toBeLessThanOrEqual(DEFAULT_MAX_OUTPUT);
    expect(result.length).toBeGreaterThan(3500);
  });

  it('falls back to a plain cut when the limit is smaller than the marker', () => {
    expect(trimOutput('abcdefghijklmnopqrstuvwxyz'.repeat(10), 10)).toBe('abcdefghij');
  });
});

describe('toForwardSlashes', () => {
  it('converts backslashes', () => {
    expect(toForwardSlashes('C:\\Users\\me\\project')).toBe('C:/Users/me/project');
  });

  it('maps Git Bash drive paths to Windows drive paths', () => {
    expect(toForwardSlashes('/c/Users/me/project')).toBe('C:/Users/me/project');
    expect(toForwardSlashes('/d')).toBe('D:/');
  });

  it('leaves POSIX paths alone', () => {
    expect(toForwardSlashes('/home/me/project')).toBe('/home/me/project');
  });
});

describe('relativeToProject', () => {
  const winRoot = 'C:\\Users\\me\\Claude-Usage-Widget';

  it('handles Windows backslash paths inside the project', () => {
    expect(relativeToProject('C:\\Users\\me\\Claude-Usage-Widget\\src\\main\\main.ts', winRoot)).toBe('src/main/main.ts');
  });

  it('compares Windows paths case-insensitively and accepts mixed separators', () => {
    expect(relativeToProject('c:/users/ME/claude-usage-widget\\src/a.ts', winRoot)).toBe('src/a.ts');
  });

  it('accepts a root with a trailing separator', () => {
    expect(relativeToProject('C:\\Users\\me\\Claude-Usage-Widget\\a.ts', `${winRoot}\\`)).toBe('a.ts');
  });

  it('rejects paths outside the project, including sibling folders with the same prefix', () => {
    expect(relativeToProject('C:\\Users\\me\\other\\a.ts', winRoot)).toBeNull();
    expect(relativeToProject('C:\\Users\\me\\Claude-Usage-Widget-old\\a.ts', winRoot)).toBeNull();
    expect(relativeToProject('D:\\Claude-Usage-Widget\\a.ts', winRoot)).toBeNull();
  });

  it('resolves .. segments before comparing', () => {
    expect(relativeToProject('C:\\Users\\me\\Claude-Usage-Widget\\..\\evil\\a.ts', winRoot)).toBeNull();
    expect(relativeToProject('C:\\Users\\me\\Claude-Usage-Widget\\src\\..\\lib\\a.ts', winRoot)).toBe('lib/a.ts');
  });

  it('interprets relative paths relative to the project root', () => {
    expect(relativeToProject('src\\a.ts', winRoot)).toBe('src/a.ts');
    expect(relativeToProject('../outside.ts', winRoot)).toBeNull();
  });

  it('supports Git Bash style paths', () => {
    expect(relativeToProject('/c/Users/me/Claude-Usage-Widget/src/a.ts', winRoot)).toBe('src/a.ts');
  });

  it('supports POSIX paths case-sensitively', () => {
    expect(relativeToProject('/home/me/proj/src/a.ts', '/home/me/proj')).toBe('src/a.ts');
    expect(relativeToProject('/home/me/PROJ/src/a.ts', '/home/me/proj')).toBeNull();
  });

  it('returns null for the root itself and for invalid input', () => {
    expect(relativeToProject(winRoot, winRoot)).toBeNull();
    expect(relativeToProject('', winRoot)).toBeNull();
    expect(relativeToProject(undefined, winRoot)).toBeNull();
    expect(relativeToProject('C:\\a.ts', '')).toBeNull();
  });
});

describe('runProcess', () => {
  it('captures stdout, stderr and the exit code without a shell', async () => {
    const result = await runProcess(process.execPath, [
      '-e',
      "process.stdout.write('out'); process.stderr.write('err'); process.exitCode = 3;",
    ]);
    expect(result).toMatchObject({ code: 3, stdout: 'out', stderr: 'err', timedOut: false, error: null });
  });

  it('runs in the given working directory', async () => {
    const dir = makeTempDir();
    try {
      const result = await runProcess(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], { cwd: dir });
      expect(path.resolve(result.stdout).toLowerCase()).toBe(path.resolve(dir).toLowerCase());
    } finally {
      removeTempDir(dir);
    }
  });

  it('kills the process after the timeout', async () => {
    const started = Date.now();
    const result = await runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
    expect(result.code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('reports spawn failures through result.error instead of rejecting', async () => {
    const result = await runProcess('definitely-not-an-existing-binary-7f3a', []);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.code).toBeNull();
  });

  it('caps collected output', async () => {
    const result = await runProcess(process.execPath, ['-e', "process.stdout.write('z'.repeat(5000))"], {
      maxBufferBytes: 100,
    });
    expect(result.stdout).toBe('z'.repeat(100));
  });
});
