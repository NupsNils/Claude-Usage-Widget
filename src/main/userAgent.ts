const PLATFORM_TOKENS: Record<string, string> = {
  win32: 'Windows NT 10.0; Win64; x64',
  darwin: 'Macintosh; Intel Mac OS X 10_15_7',
  linux: 'X11; Linux x86_64',
};

/**
 * Builds the user agent a regular Chrome browser of the same version would send
 * (reduced user agent format). Electron's default user agent contains the app
 * name and "Electron/x", which some sign-in providers reject for embedded browsers.
 */
export function chromeUserAgent(chromeVersion: string, platform: string): string {
  const major = /^\d+/.exec(chromeVersion)?.[0] ?? '0';
  const platformToken = PLATFORM_TOKENS[platform] ?? PLATFORM_TOKENS.linux;
  return `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}
