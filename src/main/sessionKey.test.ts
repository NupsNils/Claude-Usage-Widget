import { describe, expect, it } from 'vitest';
import { normalizeSessionKey } from './sessionKey';

// Built at runtime so no file in the repository contains a secret-looking literal.
const key = ['sk', 'ant', 'sid02', `${'Ab9_'.repeat(20)}-xyzAA`].join('-');

describe('normalizeSessionKey', () => {
  it('accepts a bare key', () => {
    expect(normalizeSessionKey(key)).toBe(key);
  });

  it('strips whitespace, the cookie name, quotes and a trailing semicolon', () => {
    expect(normalizeSessionKey(`  ${key}\n`)).toBe(key);
    expect(normalizeSessionKey(`sessionKey=${key};`)).toBe(key);
    expect(normalizeSessionKey(`SessionKey = "${key}"`)).toBe(key);
    expect(normalizeSessionKey(`'${key}'`)).toBe(key);
  });

  it.each([
    ['empty input', ''],
    ['another cookie', 'lastActiveOrg=123'],
    ['a key without the prefix', 'sid01-abcdefghijklmnopqrstuvwxyz'],
    ['a truncated key', 'sk-ant-sid01-abc'],
    ['a key with spaces inside', `${key.slice(0, 30)} ${key.slice(30)}`],
    ['several cookies', `sessionKey=${key}; other=1`],
  ])('rejects %s', (_label, input) => {
    expect(normalizeSessionKey(input)).toBeNull();
  });
});
