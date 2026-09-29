import path from 'node:path';
import { BrowserWindow, nativeTheme, screen, type NativeImage, type WebContents } from 'electron';
import { MAX_WIDGET_WIDTH, MIN_WIDGET_HEIGHT, MIN_WIDGET_WIDTH } from '../shared/settings';
import type { Settings } from '../shared/types';
import { clampRectToArea, resolveWidgetPosition, widgetHeight } from './windowPlacement';

const WIDGET_INITIAL_HEIGHT = 180;

const PRELOAD_PATH = path.join(__dirname, '../preload/preload.js');
const RENDERER_DIR = path.join(__dirname, '../renderer');

function backgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? '#18181b' : '#ffffff';
}

/** App windows only ever show the bundled pages: no navigation, no popups. */
function lockDown(webContents: WebContents): void {
  webContents.on('will-navigate', (event) => event.preventDefault());
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

const secureWebPreferences = {
  preload: PRELOAD_PATH,
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  spellcheck: false,
};

export function createWidgetWindow(settings: Settings, icon: NativeImage): BrowserWindow {
  const size = { width: settings.widgetWidth, height: WIDGET_INITIAL_HEIGHT };
  const position = resolveWidgetPosition(
    settings.widgetPosition,
    size,
    screen.getAllDisplays().map((display) => display.workArea),
    screen.getPrimaryDisplay().workArea,
  );
  const win = new BrowserWindow({
    ...position,
    ...size,
    useContentSize: true,
    minWidth: MIN_WIDGET_WIDTH,
    maxWidth: MAX_WIDGET_WIDTH,
    minHeight: MIN_WIDGET_HEIGHT,
    frame: false,
    resizable: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: settings.alwaysOnTop,
    show: false,
    title: 'Claude Usage',
    icon,
    backgroundColor: backgroundColor(),
    webPreferences: secureWebPreferences,
  });
  lockDown(win.webContents);
  void win.loadFile(path.join(RENDERER_DIR, 'widget.html'));
  return win;
}

/**
 * Sets the widget height to its content, at most `userHeight` (the height the user
 * resized it to), and keeps it on screen. The user can resize the widget to be
 * shorter than its content (the account list then scrolls), but not taller.
 */
export function fitWidgetHeight(win: BrowserWindow, contentHeight: number, userHeight: number | null): void {
  if (!Number.isFinite(contentHeight)) return;
  const workArea = screen.getDisplayMatching(win.getBounds()).workArea;
  win.setMaximumSize(MAX_WIDGET_WIDTH, widgetHeight(contentHeight, null, workArea.height));
  const height = widgetHeight(contentHeight, userHeight, workArea.height);
  const [currentWidth = MIN_WIDGET_WIDTH, currentHeight] = win.getContentSize();
  if (currentHeight !== height) win.setContentSize(currentWidth, height);
  const resized = win.getBounds();
  const clamped = clampRectToArea(resized, workArea);
  if (clamped.x !== resized.x || clamped.y !== resized.y) win.setPosition(clamped.x, clamped.y);
}

export function createSettingsWindow(icon: NativeImage): BrowserWindow {
  const win = new BrowserWindow({
    width: 520,
    height: 760,
    minWidth: 440,
    minHeight: 480,
    title: 'Settings - Claude Usage Widget',
    icon,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: backgroundColor(),
    webPreferences: secureWebPreferences,
  });
  lockDown(win.webContents);
  win.once('ready-to-show', () => win.show());
  void win.loadFile(path.join(RENDERER_DIR, 'settings.html'));
  return win;
}
