import { describe, expect, it } from 'vitest';
import { chromeUserAgent } from './userAgent';

describe('chromeUserAgent', () => {
  it('builds a reduced Chrome user agent for Windows', () => {
    expect(chromeUserAgent('142.0.7444.59', 'win32')).toBe(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
    );
  });

  it('does not mention Electron or the app name', () => {
    const ua = chromeUserAgent('142.0.7444.59', 'win32');
    expect(ua).not.toMatch(/electron/i);
    expect(ua).not.toMatch(/claude/i);
  });

  it('supports other platforms and falls back to Linux', () => {
    expect(chromeUserAgent('130.1', 'darwin')).toContain('(Macintosh; Intel Mac OS X 10_15_7)');
    expect(chromeUserAgent('130.1', 'freebsd')).toContain('(X11; Linux x86_64)');
  });

  it('handles a malformed version', () => {
    expect(chromeUserAgent('', 'win32')).toContain('Chrome/0.0.0.0');
  });
});
