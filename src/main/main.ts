import fs from 'node:fs';
import path from 'node:path';
import {
  BrowserWindow,
  Menu,
  Tray,
  app,
  dialog,
  ipcMain,
  nativeImage,
  powerMonitor,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron';
import { IpcChannels } from '../shared/ipc';
import type { ActionResult, AppState, Settings } from '../shared/types';
import { AccountStore } from './accountStore';
import { createLoginRunner, focusLoginWindow } from './loginWindow';
import { nextRefreshDelay } from './refreshSchedule';
import { ElectronSessionProvider } from './sessions';
import { SettingsStore } from './settingsStore';
import { trayTooltip } from './trayText';
import { orphanedPartitionDirectories } from './urlPolicy';
import { UsageService } from './usageService';
import { chromeUserAgent } from './userAgent';
import { createSettingsWindow, createWidgetWindow, fitWidgetHeight } from './windows';

const APP_USER_MODEL_ID = 'com.nupsnils.claude-usage-widget';
const RESUME_REFRESH_DELAY_MS = 5_000;
const ASSETS_DIR = path.join(__dirname, '../assets');

// Development builds keep their data apart from the installed app.
if (!app.isPackaged) {
  app.setPath('userData', path.join(app.getPath('appData'), 'Claude Usage Widget (dev)'));
}

const userAgent = chromeUserAgent(process.versions.chrome, process.platform);
app.userAgentFallback = userAgent;

let widget: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let refreshTimer: NodeJS.Timeout | null = null;

let settingsStore: SettingsStore;
let service: UsageService;
let appIcon: Electron.NativeImage;

function sendToWindows(channel: string, payload: unknown): void {
  for (const win of [widget, settingsWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function isTrustedSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? '';
  return url.startsWith('file://');
}

// ---------------------------------------------------------------- refreshing

function scheduleRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  const delay = nextRefreshDelay(Date.now(), settingsStore.get().refreshIntervalSeconds * 1000, service.resetTimes());
  refreshTimer = setTimeout(() => void refreshNow(), delay);
}

async function refreshNow(): Promise<void> {
  try {
    await service.refreshAll();
  } finally {
    scheduleRefresh();
  }
}

// ---------------------------------------------------------------- windows

function showWidget(): void {
  if (!widget || widget.isDestroyed()) return;
  widget.show();
  widget.focus();
  updateTrayMenu();
}

function hideWidget(): void {
  if (!widget || widget.isDestroyed()) return;
  widget.hide();
  updateTrayMenu();
}

function toggleWidget(): void {
  if (widget?.isVisible()) hideWidget();
  else showWidget();
}

function openSettings(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.focus();
    return;
  }
  settingsWindow = createSettingsWindow(appIcon);
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

function createWidget(): void {
  const win = createWidgetWindow(settingsStore.get(), appIcon);
  widget = win;
  // Do not steal the focus when the app starts (e.g. at login).
  win.once('ready-to-show', () => win.showInactive());
  win.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      hideWidget();
    }
  });
  win.on('moved', () => {
    const [x, y] = win.getPosition();
    if (x !== undefined && y !== undefined) saveSettingsSafely(() => settingsStore.setWidgetPosition({ x, y }));
  });
  win.on('show', updateTrayMenu);
  win.on('hide', updateTrayMenu);
}

// ---------------------------------------------------------------- tray

function updateTrayMenu(): void {
  if (!tray) return;
  const visible = widget?.isVisible() ?? false;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: visible ? 'Hide widget' : 'Show widget', click: toggleWidget },
      { label: 'Refresh now', click: () => void refreshNow() },
      { type: 'separator' },
      { label: 'Add account...', click: () => void addAccountViaLogin().then(showActionError) },
      { label: 'Settings...', click: openSettings },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
}

function createTray(): void {
  tray = new Tray(nativeImage.createFromPath(path.join(ASSETS_DIR, 'tray.png')));
  tray.setToolTip(trayTooltip(service.getState(), Date.now()));
  tray.on('click', toggleWidget);
  updateTrayMenu();
}

// ---------------------------------------------------------------- settings

function saveSettingsSafely(save: () => Settings): Settings {
  try {
    return save();
  } catch (error) {
    console.error('Could not save the settings:', error);
    return settingsStore.get();
  }
}

function applyLaunchAtStartup(enabled: boolean): void {
  // Registering the development binary (electron.exe) would start a bare Electron at login.
  if (!app.isPackaged) return;
  // The portable build extracts itself to a temporary folder; register the portable .exe itself.
  const exePath = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  app.setLoginItemSettings({ openAtLogin: enabled, path: exePath, args: [] });
}

function applySettings(previous: Settings, next: Settings): void {
  if (widget && !widget.isDestroyed() && previous.alwaysOnTop !== next.alwaysOnTop) {
    widget.setAlwaysOnTop(next.alwaysOnTop);
  }
  if (previous.launchAtStartup !== next.launchAtStartup) applyLaunchAtStartup(next.launchAtStartup);
  if (previous.refreshIntervalSeconds !== next.refreshIntervalSeconds) scheduleRefresh();
  sendToWindows(IpcChannels.settingsChanged, next);
}

// ---------------------------------------------------------------- accounts

async function afterAccountAction(result: Promise<ActionResult>): Promise<ActionResult> {
  const outcome = await result;
  scheduleRefresh();
  return outcome;
}

/**
 * The settings window shows action errors itself. For actions started from the
 * widget or the tray, a message box makes sure an error is not lost.
 */
function showActionError(result: ActionResult): void {
  if (result.status !== 'error') return;
  void dialog.showMessageBox({
    type: 'error',
    title: 'Claude Usage Widget',
    message: 'The account could not be signed in.',
    detail: result.error,
  });
}

function addAccountViaLogin(): Promise<ActionResult> {
  if (focusLoginWindow()) return Promise.resolve({ status: 'cancelled' });
  return afterAccountAction(service.addViaLogin());
}

function isFromSettings(event: IpcMainInvokeEvent): boolean {
  return settingsWindow !== null && !settingsWindow.isDestroyed() && event.sender === settingsWindow.webContents;
}

async function confirmRemoval(accountId: string): Promise<boolean> {
  const account = service.getState().accounts.find((entry) => entry.id === accountId);
  if (!account) return false;
  const options = {
    type: 'warning' as const,
    buttons: ['Remove', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Remove account',
    message: `Remove ${account.label}?`,
    detail: 'The account is signed out in this app and its session data is deleted. Your claude.ai account is not affected.',
  };
  const parent = settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : undefined;
  const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  return response === 0;
}

// ---------------------------------------------------------------- IPC

function registerIpc(): void {
  const handle = (channel: string, handler: (...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!isTrustedSender(event)) throw new Error('Untrusted sender');
      return handler(...args);
    });
  };
  /** Like `handle`, for account actions: errors are shown in a message box unless the settings window asked. */
  const handleAction = (channel: string, handler: (...args: unknown[]) => Promise<ActionResult> | ActionResult) => {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (!isTrustedSender(event)) throw new Error('Untrusted sender');
      const result = await handler(...args);
      if (!isFromSettings(event)) showActionError(result);
      return result;
    });
  };
  const on = (channel: string, handler: (event: IpcMainEvent, ...args: unknown[]) => void) => {
    ipcMain.on(channel, (event, ...args: unknown[]) => {
      if (isTrustedSender(event)) handler(event, ...args);
    });
  };

  handle(IpcChannels.getState, () => service.getState());
  handle(IpcChannels.getSettings, () => settingsStore.get());
  handle(IpcChannels.updateSettings, (patch) => {
    const previous = settingsStore.get();
    const next = saveSettingsSafely(() => settingsStore.update(patch));
    applySettings(previous, next);
    return next;
  });
  handle(IpcChannels.resetColors, () => {
    const previous = settingsStore.get();
    const next = saveSettingsSafely(() => settingsStore.resetColors());
    applySettings(previous, next);
    return next;
  });
  handle(IpcChannels.refreshNow, () => refreshNow());
  handleAction(IpcChannels.addAccountViaLogin, () => addAccountViaLogin());
  handleAction(IpcChannels.addAccountWithSessionKey, (sessionKey) =>
    typeof sessionKey === 'string'
      ? afterAccountAction(service.addWithSessionKey(sessionKey))
      : { status: 'error', error: 'Invalid session key.' },
  );
  handleAction(IpcChannels.reloginAccount, (accountId) => {
    if (typeof accountId !== 'string') return { status: 'error', error: 'Unknown account.' };
    if (focusLoginWindow()) return { status: 'cancelled' };
    return afterAccountAction(service.relogin(accountId));
  });
  handle(IpcChannels.renameAccount, (accountId, label) => {
    if (typeof accountId !== 'string' || typeof label !== 'string') return;
    if (service.getState().accounts.some((account) => account.id === accountId)) service.rename(accountId, label);
  });
  handle(IpcChannels.removeAccount, async (accountId) => {
    if (typeof accountId !== 'string' || !(await confirmRemoval(accountId))) return;
    await service.remove(accountId);
    scheduleRefresh();
  });

  on(IpcChannels.openSettings, () => openSettings());
  on(IpcChannels.hideWidget, () => hideWidget());
  on(IpcChannels.setWidgetHeight, (event, height) => {
    if (widget && !widget.isDestroyed() && event.sender === widget.webContents && typeof height === 'number') {
      fitWidgetHeight(widget, height);
    }
  });
}

// ---------------------------------------------------------------- startup

/** Deletes partition folders left behind by cancelled sign-ins or removed accounts. */
function removeOrphanedPartitions(activePartitions: string[]): void {
  const partitionsDir = path.join(app.getPath('userData'), 'Partitions');
  let entries: string[];
  try {
    entries = fs.readdirSync(partitionsDir);
  } catch {
    return;
  }
  for (const name of orphanedPartitionDirectories(entries, activePartitions)) {
    try {
      fs.rmSync(path.join(partitionsDir, name), { recursive: true, force: true });
    } catch (error) {
      console.error(`Could not delete the unused partition ${name}:`, error);
    }
  }
}

function onStateChanged(state: AppState): void {
  sendToWindows(IpcChannels.stateChanged, state);
  tray?.setToolTip(trayTooltip(state, Date.now()));
}

function start(): void {
  app.setAppUserModelId(APP_USER_MODEL_ID);
  Menu.setApplicationMenu(null);
  appIcon = nativeImage.createFromPath(path.join(ASSETS_DIR, 'icon.png'));

  const userData = app.getPath('userData');
  settingsStore = new SettingsStore(path.join(userData, 'settings.json'));
  const settings = settingsStore.load();
  const accountStore = new AccountStore(path.join(userData, 'accounts.json'));
  // After a damaged accounts file the sessions on disk may still belong to accounts; keep them.
  if (accountStore.load() !== 'corrupt') {
    removeOrphanedPartitions(accountStore.list().map((account) => account.partition));
  }

  const sessions = new ElectronSessionProvider(userAgent);
  service = new UsageService({
    store: accountStore,
    sessions,
    login: createLoginRunner(sessions, appIcon),
    onChange: onStateChanged,
  });

  registerIpc();
  createWidget();
  createTray();
  applyLaunchAtStartup(settings.launchAtStartup);

  powerMonitor.on('resume', () => setTimeout(() => void refreshNow(), RESUME_REFRESH_DELAY_MS));
  powerMonitor.on('unlock-screen', () => void refreshNow());

  void refreshNow();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWidget());
  app.on('before-quit', () => {
    quitting = true;
  });
  // The app lives in the tray; closing the settings window must not quit it.
  app.on('window-all-closed', () => undefined);
  app
    .whenReady()
    .then(start)
    .catch((error: unknown) => {
      dialog.showErrorBox('Claude Usage Widget', `The app could not start:\n${String(error)}`);
      app.quit();
    });
}
