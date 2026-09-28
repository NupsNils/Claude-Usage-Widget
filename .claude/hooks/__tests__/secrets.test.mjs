import { describe, expect, it } from 'vitest';

import {
  collectWrittenText,
  evaluateSecretGuard,
  findSecrets,
  isObviousPlaceholder,
  MASK_VISIBLE_CHARS,
  maskSecret,
} from '../lib/secrets.mjs';
import { fakeSecret, VARIED_BODY } from './helpers.mjs';

// Every fixture is assembled at runtime; see helpers.fakeSecret.
const PREFIX = ['sk', 'ant', ''].join('-');

describe('findSecrets', () => {
  it.each(['sid01', 'api03', 'oat01', 'ort01', 'admin01'])('detects %s tokens', (kind) => {
    const secret = fakeSecret(kind, VARIED_BODY);
    expect(findSecrets(`value: ${secret}\n`)).toEqual([secret]);
  });

  it('detects the repeated-letter fixture', () => {
    const secret = fakeSecret('sid01', 'A'.repeat(40));
    expect(findSecrets(secret)).toEqual([secret]);
  });

  it('detects secrets embedded in code and JSON', () => {
    const secret = fakeSecret('api03', VARIED_BODY);
    expect(findSecrets(`const key = "${secret}";`)).toEqual([secret]);
    expect(findSecrets(JSON.stringify({ sessionKey: secret }))).toEqual([secret]);
    expect(findSecrets(`KEY=${secret}`)).toEqual([secret]);
  });

  it('returns each distinct secret once', () => {
    const a = fakeSecret('sid01', VARIED_BODY);
    const b = fakeSecret('oat01', VARIED_BODY);
    expect(findSecrets(`${a} ${b} ${a}`)).toEqual([a, b]);
  });

  it('detects a body of exactly 20 characters but not 19', () => {
    expect(findSecrets(fakeSecret('sid01', 'B'.repeat(20)))).toHaveLength(1);
    expect(findSecrets(fakeSecret('sid01', 'B'.repeat(19)))).toEqual([]);
  });

  it('ignores placeholders and prefix checks', () => {
    const samples = [
      `${PREFIX}sid01-...`,
      `const sample = '${PREFIX}sid01-...';`,
      `if (key.startsWith('${PREFIX}')) {}`,
      `key.startsWith("${PREFIX}sid01-")`,
      `/^${PREFIX}[a-z]+\\d{2}-/`,
      `${PREFIX}api03-<your key here>`,
      `${PREFIX}sid01-XXXXXXXX`,
      fakeSecret('api03', 'x'.repeat(40)),
      fakeSecret('api03', 'X'.repeat(30)),
    ];
    for (const sample of samples) {
      expect(findSecrets(sample), sample).toEqual([]);
    }
  });

  it('requires the lowercase kind and two-digit version', () => {
    expect(findSecrets(fakeSecret('sid', VARIED_BODY))).toEqual([]);
    expect(findSecrets(fakeSecret('sid1', VARIED_BODY))).toEqual([]);
    expect(findSecrets(fakeSecret('SID01', VARIED_BODY))).toEqual([]);
  });

  it('returns an empty list for non-strings and text without the prefix', () => {
    expect(findSecrets(undefined)).toEqual([]);
    expect(findSecrets(42)).toEqual([]);
    expect(findSecrets('nothing to see here')).toEqual([]);
  });
});

describe('isObviousPlaceholder', () => {
  it('flags bodies made only of x characters', () => {
    expect(isObviousPlaceholder(fakeSecret('api03', 'x'.repeat(24)))).toBe(true);
    expect(isObviousPlaceholder(fakeSecret('api03', 'xXxXxXxXxXxXxXxXxXxX'))).toBe(true);
  });

  it('does not flag real-looking bodies', () => {
    expect(isObviousPlaceholder(fakeSecret('api03', VARIED_BODY))).toBe(false);
    expect(isObviousPlaceholder(fakeSecret('sid01', 'A'.repeat(40)))).toBe(false);
  });
});

describe('maskSecret', () => {
  it('shows only the first 12 characters and the length', () => {
    const secret = fakeSecret('sid01', VARIED_BODY);
    const masked = maskSecret(secret);
    expect(MASK_VISIBLE_CHARS).toBe(12);
    expect(masked).toBe(`${secret.slice(0, 12)}... (${secret.length} chars)`);
    expect(masked).not.toContain(secret);
    expect(masked).not.toContain(VARIED_BODY.slice(0, 8));
  });

  it('handles short and missing values', () => {
    expect(maskSecret('abc')).toBe('abc... (3 chars)');
    expect(maskSecret(undefined)).toBe('... (0 chars)');
  });
});

describe('collectWrittenText', () => {
  it('collects Write content', () => {
    expect(collectWrittenText({ file_path: 'a.ts', content: 'hello' })).toEqual([{ field: 'content', text: 'hello' }]);
  });

  it('collects Edit new_string but not old_string', () => {
    expect(collectWrittenText({ file_path: 'a.ts', old_string: 'old', new_string: 'new' })).toEqual([
      { field: 'new_string', text: 'new' },
    ]);
  });

  it('collects every MultiEdit edit', () => {
    const toolInput = {
      file_path: 'a.ts',
      edits: [
        { old_string: 'a', new_string: 'one' },
        { old_string: 'b', new_string: 'two' },
      ],
    };
    expect(collectWrittenText(toolInput)).toEqual([
      { field: 'edits[0].new_string', text: 'one' },
      { field: 'edits[1].new_string', text: 'two' },
    ]);
  });

  it('collects NotebookEdit new_source', () => {
    expect(collectWrittenText({ notebook_path: 'n.ipynb', new_source: 'print(1)' })).toEqual([
      { field: 'new_source', text: 'print(1)' },
    ]);
  });

  it('allows empty strings and ignores non-string values and malformed edits', () => {
    expect(
      collectWrittenText({ content: '', new_string: 5, edits: [null, 'x', { new_string: 7 }, { new_string: 'ok' }] }),
    ).toEqual([
      { field: 'content', text: '' },
      { field: 'edits[3].new_string', text: 'ok' },
    ]);
    expect(collectWrittenText({ edits: 'not an array' })).toEqual([]);
  });

  it('returns an empty list for missing input', () => {
    expect(collectWrittenText(undefined)).toEqual([]);
    expect(collectWrittenText(null)).toEqual([]);
    expect(collectWrittenText('string')).toEqual([]);
  });
});

describe('evaluateSecretGuard', () => {
  const secret = fakeSecret('sid01', VARIED_BODY);

  it('allows null input and input without tool_input', () => {
    expect(evaluateSecretGuard(null)).toEqual({ block: false });
    expect(evaluateSecretGuard({ tool_name: 'Write' })).toEqual({ block: false });
  });

  it('blocks a Write that contains a secret without echoing it', () => {
    const result = evaluateSecretGuard({
      tool_name: 'Write',
      tool_input: { file_path: 'C:\\proj\\src\\config.ts', content: `export const KEY = '${secret}';` },
    });
    expect(result.block).toBe(true);
    expect(result.message).toContain('secret-guard');
    expect(result.message).toContain('C:\\proj\\src\\config.ts');
    expect(result.message).toContain(maskSecret(secret));
    expect(result.message).toContain('tool_input.content');
    expect(result.message).not.toContain(secret);
    expect(result.findings).toEqual([{ field: 'content', masked: maskSecret(secret) }]);
  });

  it('blocks an Edit whose new_string contains a secret', () => {
    const result = evaluateSecretGuard({
      tool_name: 'Edit',
      tool_input: { file_path: '/p/a.ts', old_string: 'x', new_string: secret },
    });
    expect(result.block).toBe(true);
  });

  it('allows an Edit that removes a secret', () => {
    const result = evaluateSecretGuard({
      tool_name: 'Edit',
      tool_input: { file_path: '/p/a.ts', old_string: secret, new_string: "process.env['CLAUDE_SESSION_KEY']" },
    });
    expect(result).toEqual({ block: false });
  });

  it('blocks a MultiEdit when any edit contains a secret and reports each distinct secret once', () => {
    const other = fakeSecret('api03', VARIED_BODY);
    const result = evaluateSecretGuard({
      tool_name: 'MultiEdit',
      tool_input: {
        file_path: '/p/a.ts',
        edits: [
          { old_string: 'a', new_string: 'clean' },
          { old_string: 'b', new_string: `${other} ${other}` },
          { old_string: 'c', new_string: other },
        ],
      },
    });
    expect(result.block).toBe(true);
    expect(result.findings).toEqual([{ field: 'edits[1].new_string', masked: maskSecret(other) }]);
  });

  it('blocks a NotebookEdit and names the notebook', () => {
    const result = evaluateSecretGuard({
      tool_name: 'NotebookEdit',
      tool_input: { notebook_path: '/p/n.ipynb', new_source: `key = "${secret}"` },
    });
    expect(result.block).toBe(true);
    expect(result.message).toContain('/p/n.ipynb');
  });

  it('mentions the count when several secrets are found', () => {
    const result = evaluateSecretGuard({
      tool_name: 'Write',
      tool_input: { file_path: '/p/a.ts', content: `${secret}\n${fakeSecret('oat01', VARIED_BODY)}` },
    });
    expect(result.block).toBe(true);
    expect(result.message).toContain('2 values that look like real Anthropic secrets');
  });

  it('allows placeholders and prefix checks', () => {
    const result = evaluateSecretGuard({
      tool_name: 'Write',
      tool_input: {
        file_path: '/p/a.ts',
        content: `const isKey = (k: string) => k.startsWith('${PREFIX}');\n// e.g. ${PREFIX}sid01-...\n`,
      },
    });
    expect(result).toEqual({ block: false });
  });
});
