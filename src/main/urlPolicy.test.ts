import { describe, expect, it } from 'vitest';
import { isAllowedLoginPopup, isExternalWebUrl, orphanedPartitionDirectories } from './urlPolicy';

describe('isAllowedLoginPopup', () => {
  it.each([
    'https://accounts.google.com/o/oauth2/v2/auth?client_id=x',
    'https://appleid.apple.com/auth/authorize',
    'https://claude.ai/login',
    'https://www.anthropic.com/legal',
  ])('allows %s', (url) => {
    expect(isAllowedLoginPopup(url)).toBe(true);
  });

  it.each([
    'http://accounts.google.com/',
    'https://evilgoogle.com/',
    'https://google.com.evil.example/',
    'https://example.com/',
    'file:///C:/Windows',
    'javascript:alert(1)',
    'not a url',
  ])('rejects %s', (url) => {
    expect(isAllowedLoginPopup(url)).toBe(false);
  });
});

describe('isExternalWebUrl', () => {
  it('accepts only http and https', () => {
    expect(isExternalWebUrl('https://support.claude.com/')).toBe(true);
    expect(isExternalWebUrl('http://example.com/')).toBe(true);
    expect(isExternalWebUrl('file:///C:/secret.txt')).toBe(false);
    expect(isExternalWebUrl('ms-settings:privacy')).toBe(false);
    expect(isExternalWebUrl('')).toBe(false);
  });
});

describe('orphanedPartitionDirectories', () => {
  const used = 'acct-0b8f6a52-6c1e-4d4b-9a57-2f1a7c3e9d10';
  const unused = 'acct-7d3c2b1a-0f9e-4d8c-b7a6-5e4d3c2b1a09';

  it('returns only unused account partitions', () => {
    expect(
      orphanedPartitionDirectories([used, unused, 'acct-short', 'other-partition', 'smoke-test'], [`persist:${used}`]),
    ).toEqual([unused]);
  });

  it('compares case-insensitively', () => {
    expect(orphanedPartitionDirectories([used.toUpperCase().replace('ACCT', 'acct')], [`persist:${used}`])).toEqual([]);
  });
});
