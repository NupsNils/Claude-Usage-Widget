import path from 'node:path';
import { BrowserWindow, nativeTheme, screen, type NativeImage, type WebContents } from 'electron';
import type { Settings } from '../shared/types';
import { clampRectToArea, resolveWidgetPosition } from './windowPlacement';

export const WIDGET_WIDTH = 340;
const WIDGET_INITIAL_HEIGHT = 180;
const WIDGET_MIN_HEIGHT = 80;

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
  const size = { width: WIDGET_WIDTH, height: WIDGET_INITIAL_HEIGHT };
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
    frame: false,
    resizable: false,
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

/** Sets the widget height to its content and keeps it on screen. */
export function fitWidgetHeight(win: BrowserWindow, contentHeight: number): void {
  if (!Number.isFinite(contentHeight)) return;
  const bounds = win.getBounds();
  const workArea = screen.getDisplayMatching(bounds).workArea;
  const height = Math.round(Math.min(Math.max(contentHeight, WIDGET_MIN_HEIGHT), workArea.height));
  const [currentWidth, currentHeight] = win.getContentSize();
  if (currentWidth !== WIDGET_WIDTH || currentHeight !== height) {
    win.setContentSize(WIDGET_WIDTH, height);
  }
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
