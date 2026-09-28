import { session, type Session } from 'electron';
import { CLAUDE_BASE_URL, ClaudeApi } from './claudeApi';
import type { SessionProvider } from './usageService';

const SESSION_COOKIE = 'sessionKey';
/** Copying (e.g. a code) and the storage access checks sign-in providers use; everything else is denied. */
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'storage-access', 'top-level-storage-access']);
const MANUAL_KEY_LIFETIME_SECONDS = 365 * 24 * 60 * 60;

/**
 * Each account has its own persistent Chromium partition. It holds the
 * claude.ai cookies exactly like a browser profile, so a session key that
 * claude.ai rotates via Set-Cookie is picked up automatically.
 */
export class ElectronSessionProvider implements SessionProvider {
  private readonly configured = new Set<string>();

  constructor(private readonly userAgent: string) {}

  get(partition: string): Session {
    const ses = session.fromPartition(partition);
    if (!this.configured.has(partition)) {
      this.configured.add(partition);
      ses.setUserAgent(this.userAgent, 'en-US,en');
      ses.setPermissionRequestHandler((_webContents, permission, callback) => {
        callback(ALLOWED_PERMISSIONS.has(permission));
      });
      // Without a check handler Electron answers permission checks with "granted".
      ses.setPermissionCheckHandler((_webContents, permission) => ALLOWED_PERMISSIONS.has(permission));
      ses.on('will-download', (event) => event.preventDefault());
      ses.cookies.on('changed', (_event, cookie, _cause, removed) => {
        // Write a new or rotated session key to disk right away instead of on Chromium's timer.
        if (!removed && cookie.name === SESSION_COOKIE) void ses.cookies.flushStore().catch(() => undefined);
      });
    }
    return ses;
  }

  api(partition: string): ClaudeApi {
    const ses = this.get(partition);
    return new ClaudeApi((url, init) =>
      ses.fetch(url, { headers: init.headers, signal: init.signal, credentials: 'include' }),
    );
  }

  async hasSessionCookie(partition: string): Promise<boolean> {
    const cookies = await this.get(partition).cookies.get({ url: CLAUDE_BASE_URL, name: SESSION_COOKIE });
    return cookies.length > 0;
  }

  async lastActiveOrganization(partition: string): Promise<string | null> {
    const cookies = await this.get(partition).cookies.get({ url: CLAUDE_BASE_URL, name: 'lastActiveOrg' });
    const value = cookies[0]?.value.trim();
    return value ? value : null;
  }

  async setSessionKey(partition: string, sessionKey: string): Promise<void> {
    const ses = this.get(partition);
    await ses.cookies.set({
      url: CLAUDE_BASE_URL,
      domain: '.claude.ai',
      path: '/',
      name: SESSION_COOKIE,
      value: sessionKey,
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      expirationDate: Math.floor(Date.now() / 1000) + MANUAL_KEY_LIFETIME_SECONDS,
    });
    await ses.cookies.flushStore();
  }

  async clear(partition: string): Promise<void> {
    const ses = this.get(partition);
    await ses.clearStorageData();
    await ses.clearCache();
    await ses.cookies.flushStore();
  }
}
