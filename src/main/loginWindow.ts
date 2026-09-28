import { BrowserWindow, shell, type Cookie, type NativeImage, type WebContents, type WebPreferences } from 'electron';
import { CLAUDE_BASE_URL } from './claudeApi';
import { createSerializedCheck } from './loginFlow';
import type { ElectronSessionProvider } from './sessions';
import { isAllowedLoginPopup, isExternalWebUrl } from './urlPolicy';
import type { LoginOutcome, LoginRunner, VerifyResult } from './usageService';

const LOGIN_URL = `${CLAUDE_BASE_URL}/login`;
/**
 * Clearing a partition's storage while Chromium is still tearing down a page of
 * that partition can crash Electron. The result is therefore reported only after
 * the page is destroyed plus this delay; the fallback caps the wait.
 */
const TEARDOWN_SETTLE_MS = 750;
const TEARDOWN_FALLBACK_MS = 5_000;

let activeWindow: BrowserWindow | null = null;

/** Brings an open sign-in window to the front. Returns false when none is open. */
export function focusLoginWindow(): boolean {
  if (!activeWindow || activeWindow.isDestroyed()) return false;
  if (activeWindow.isMinimized()) activeWindow.restore();
  activeWindow.focus();
  return true;
}

/**
 * Sign-in providers may open popups (Google, Apple). They stay in the account's
 * session; every other link opens in the default browser. The same rule applies
 * to popups opened by popups.
 */
function applyPopupPolicy(contents: WebContents, icon: NativeImage, webPreferences: WebPreferences): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowedLoginPopup(url)) {
      return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, icon, webPreferences } };
    }
    if (isExternalWebUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('did-create-window', (child) => applyPopupPolicy(child.webContents, icon, webPreferences));
}

/**
 * Opens claude.ai's own sign-in page in the account's partition and waits
 * until claude.ai has set a working session cookie.
 */
export function createLoginRunner(sessions: ElectronSessionProvider, icon: NativeImage): LoginRunner {
  return (partition: string, verify: () => Promise<VerifyResult>) =>
    new Promise<LoginOutcome>((resolve) => {
      const ses = sessions.get(partition);
      const webPreferences: WebPreferences = { partition, sandbox: true, contextIsolation: true, nodeIntegration: false };
      const win = new BrowserWindow({
        width: 480,
        height: 760,
        minWidth: 380,
        minHeight: 520,
        title: 'Sign in to Claude',
        icon,
        show: false,
        autoHideMenuBar: true,
        webPreferences,
      });
      activeWindow = win;
      let finished = false;

      const contents = win.webContents;
      const pageDestroyed = new Promise<void>((resolvePage) => {
        contents.once('destroyed', () => resolvePage());
        setTimeout(resolvePage, TEARDOWN_FALLBACK_MS).unref();
      });

      const finish = (outcome: LoginOutcome) => {
        if (finished) return;
        finished = true;
        ses.cookies.removeListener('changed', onCookieChanged);
        if (activeWindow === win) activeWindow = null;
        // destroy() instead of close(): a beforeunload handler on the page must not keep the window open.
        if (!win.isDestroyed()) win.destroy();
        void pageDestroyed.then(() => setTimeout(() => resolve(outcome), TEARDOWN_SETTLE_MS));
      };

      const check = createSerializedCheck(verify, finish, () => finished);

      const checkIfSignedIn = async () => {
        if (!finished && (await sessions.hasSessionCookie(partition))) await check();
      };

      function onCookieChanged(_event: Electron.Event, cookie: Cookie, _cause: string, removed: boolean) {
        if (!removed && cookie.name === 'sessionKey' && (cookie.domain ?? '').endsWith('claude.ai')) void check();
      }

      ses.cookies.on('changed', onCookieChanged);
      // Keep "Sign in to Claude" instead of the page title, so the window is recognizable in the taskbar.
      win.on('page-title-updated', (event) => event.preventDefault());
      win.on('closed', () => finish('cancelled'));
      win.once('ready-to-show', () => {
        if (!win.isDestroyed()) win.show();
      });
      // claude.ai navigates after a successful sign-in; this catches a cookie that was set before verification could succeed.
      win.webContents.on('did-navigate', () => void checkIfSignedIn());
      win.webContents.on('did-navigate-in-page', () => void checkIfSignedIn());
      applyPopupPolicy(win.webContents, icon, webPreferences);
      win.loadURL(LOGIN_URL).catch(() => {
        // Chromium shows its own error page (e.g. when offline); the user can close the window.
        if (!win.isDestroyed()) win.show();
      });
    });
}
