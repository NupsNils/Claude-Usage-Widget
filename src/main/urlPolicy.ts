/** Sign-in providers claude.ai may open in a popup during login. */
const LOGIN_POPUP_DOMAINS = ['claude.ai', 'anthropic.com', 'google.com', 'apple.com'];

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function hostMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

/** Whether the login window may open `url` as a popup inside the app (same session). */
export function isAllowedLoginPopup(url: string): boolean {
  const parsed = parseUrl(url);
  if (!parsed || parsed.protocol !== 'https:') return false;
  const hostname = parsed.hostname.toLowerCase();
  return LOGIN_POPUP_DOMAINS.some((domain) => hostMatches(hostname, domain));
}

/** Whether `url` may be handed to the system browser. */
export function isExternalWebUrl(url: string): boolean {
  const parsed = parseUrl(url);
  return parsed !== null && (parsed.protocol === 'https:' || parsed.protocol === 'http:');
}

/**
 * Chromium stores a persistent partition "persist:<name>" in the directory
 * "Partitions/<name>". Returns the directories of account partitions that no
 * account uses any more (e.g. from cancelled sign-ins), so they can be deleted.
 */
export function orphanedPartitionDirectories(directoryNames: readonly string[], activePartitions: readonly string[]): string[] {
  const active = new Set(activePartitions.map((partition) => partition.replace(/^persist:/, '').toLowerCase()));
  return directoryNames.filter(
    (name) => /^acct-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name) && !active.has(name.toLowerCase()),
  );
}
