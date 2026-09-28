import { describe, expect, it } from 'vitest';

import { filterSourceChanges, isSourcePath, parsePorcelain, unquoteGitPath } from '../lib/git-status.mjs';

describe('unquoteGitPath', () => {
  it('returns unquoted paths unchanged', () => {
    expect(unquoteGitPath('src/a.ts')).toBe('src/a.ts');
    expect(unquoteGitPath('"')).toBe('"');
  });

  it('removes quotes around paths with spaces', () => {
    expect(unquoteGitPath('"src/my file.ts"')).toBe('src/my file.ts');
  });

  it('decodes C-style escapes', () => {
    expect(unquoteGitPath('"src/a\\"b\\\\c\\td.ts"')).toBe('src/a"b\\c\td.ts');
  });

  it('decodes octal escaped UTF-8 bytes', () => {
    expect(unquoteGitPath('"src/\\303\\244rger.ts"')).toBe('src/ärger.ts');
    expect(unquoteGitPath('"src/\\342\\202\\254.css"')).toBe('src/€.css');
  });
});

describe('parsePorcelain', () => {
  it('parses modified, added, deleted and untracked entries', () => {
    const output = [' M src/main/main.ts', 'M  scripts/build.mjs', 'A  src/new.ts', ' D src/old.ts', '?? notes.txt', 'MM README.md', ''].join('\n');
    expect(parsePorcelain(output)).toEqual([
      'src/main/main.ts',
      'scripts/build.mjs',
      'src/new.ts',
      'src/old.ts',
      'notes.txt',
      'README.md',
    ]);
  });

  it('returns both sides of renames and copies', () => {
    expect(parsePorcelain('R  src/old.ts -> src/new.ts\nC  a.ts -> src/copy.ts\n')).toEqual([
      'src/old.ts',
      'src/new.ts',
      'a.ts',
      'src/copy.ts',
    ]);
    expect(parsePorcelain('RM docs/x.md -> src/x.ts')).toEqual(['docs/x.md', 'src/x.ts']);
  });

  it('handles quoted paths, including quoted renames', () => {
    const output = [
      '?? "src/my file.ts"',
      'R  "src/old name.ts" -> "src/new name.ts"',
      'R  plain.ts -> "src/with space.ts"',
      'R  "with space.ts" -> src/plain.ts',
      ' M "src/\\303\\244.ts"',
    ].join('\n');
    expect(parsePorcelain(output)).toEqual([
      'src/my file.ts',
      'src/old name.ts',
      'src/new name.ts',
      'plain.ts',
      'src/with space.ts',
      'with space.ts',
      'src/plain.ts',
      'src/ä.ts',
    ]);
  });

  it('handles CRLF line endings, blank lines and branch headers', () => {
    expect(parsePorcelain('## main...origin/main\r\n M src/a.ts\r\n\r\n?? src/b.ts\r\n')).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('keeps untracked directory entries', () => {
    expect(parsePorcelain('?? src/\n?? .claude/\n')).toEqual(['src/', '.claude/']);
  });

  it('ignores malformed lines and non-string input', () => {
    expect(parsePorcelain('garbage\nX\n')).toEqual([]);
    expect(parsePorcelain(undefined)).toEqual([]);
    expect(parsePorcelain('')).toEqual([]);
  });
});

describe('isSourcePath', () => {
  it.each([
    'src/main/main.ts',
    'src/renderer/index.html',
    'src/renderer/styles.css',
    'src/renderer/tsconfig.json',
    'src/shared/types.mts',
    'src/legacy.js',
    '.claude/hooks/secret-guard.mjs',
    '.claude/hooks/lib/common.mjs',
    '.claude/hooks/__tests__/common.test.mjs',
    'scripts/build.mjs',
    'scripts/generate-icon.mjs',
    'src/upper-case-extension.TS',
  ])('accepts %s', (file) => {
    expect(isSourcePath(file)).toBe(true);
  });

  it.each([
    'README.md',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    '.claude/settings.json',
    '.claude/settings.local.json',
    'src/assets/icon.png',
    'src/notes.md',
    'docs/src/a.ts',
    'build/icon.png',
    'dist/main/main.js',
    '',
  ])('rejects %s', (file) => {
    expect(isSourcePath(file)).toBe(false);
  });

  it('normalizes backslashes and a leading ./', () => {
    expect(isSourcePath('src\\main\\main.ts')).toBe(true);
    expect(isSourcePath('./scripts/build.mjs')).toBe(true);
  });

  it('treats directory entries that overlap a source directory as source changes', () => {
    expect(isSourcePath('src/')).toBe(true);
    expect(isSourcePath('src/renderer/')).toBe(true);
    expect(isSourcePath('.claude/')).toBe(true);
    expect(isSourcePath('scripts/')).toBe(true);
    expect(isSourcePath('docs/')).toBe(false);
    expect(isSourcePath('.github/')).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(isSourcePath(undefined)).toBe(false);
    expect(isSourcePath(null)).toBe(false);
  });
});

describe('filterSourceChanges', () => {
  it('keeps matching paths once, in order', () => {
    expect(filterSourceChanges(['README.md', 'src/a.ts', 'scripts/b.mjs', 'src/a.ts', 'logo.png'])).toEqual([
      'src/a.ts',
      'scripts/b.mjs',
    ]);
  });

  it('works on parsed porcelain output with a rename out of src/', () => {
    const paths = parsePorcelain('R  src/moved.ts -> docs/moved.ts\n M README.md\n');
    expect(filterSourceChanges(paths)).toEqual(['src/moved.ts']);
  });

  it('handles empty input', () => {
    expect(filterSourceChanges([])).toEqual([]);
    expect(filterSourceChanges(undefined)).toEqual([]);
  });
});
