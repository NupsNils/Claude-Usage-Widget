import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_COLORS } from '../shared/gradient';
import { DEFAULT_SETTINGS, MIN_WIDGET_HEIGHT } from '../shared/settings';
import { SettingsStore } from './settingsStore';

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuw-settings-'));
  filePath = path.join(dir, 'settings.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('SettingsStore', () => {
  it('uses the defaults without a settings file', () => {
    expect(new SettingsStore(filePath).load()).toEqual(DEFAULT_SETTINGS);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('saves patches and loads them again', () => {
    const store = new SettingsStore(filePath);
    store.load();
    const updated = store.update({ refreshIntervalSeconds: 120, colors: { mid: '#FFA500' } });
    expect(updated.refreshIntervalSeconds).toBe(120);
    expect(updated.colors.mid).toBe('#ffa500');
    expect(new SettingsStore(filePath).load()).toEqual(updated);
  });

  it('resets the colors only', () => {
    const store = new SettingsStore(filePath);
    store.load();
    store.update({ alwaysOnTop: false, colors: { low: '#000000', high: '#ffffff' } });
    const reset = store.resetColors();
    expect(reset.colors).toEqual(DEFAULT_COLORS);
    expect(reset.alwaysOnTop).toBe(false);
  });

  it('stores the widget position rounded', () => {
    const store = new SettingsStore(filePath);
    store.load();
    expect(store.setWidgetPosition({ x: 10.6, y: -3.2 }).widgetPosition).toEqual({ x: 11, y: -3 });
  });

  it('stores the widget size and resets it', () => {
    const store = new SettingsStore(filePath);
    store.load();
    store.update({ alwaysOnTop: false });
    const resized = store.setWidgetSize(412.4, 5);
    expect(resized).toMatchObject({ widgetWidth: 412, widgetHeight: MIN_WIDGET_HEIGHT, alwaysOnTop: false });
    expect(new SettingsStore(filePath).load()).toEqual(resized);
    expect(store.setWidgetSize(412, null).widgetHeight).toBeNull();
    const reset = store.resetWidgetSize();
    expect(reset).toMatchObject({ widgetWidth: DEFAULT_SETTINGS.widgetWidth, widgetHeight: null, alwaysOnTop: false });
  });

  it('returns copies', () => {
    const store = new SettingsStore(filePath);
    store.load();
    store.get().colors.low = '#123123';
    expect(store.get().colors.low).toBe(DEFAULT_COLORS.low);
  });

  it('repairs invalid values from disk', () => {
    fs.writeFileSync(filePath, JSON.stringify({ refreshIntervalSeconds: 1, colors: { low: 'nope' } }));
    const settings = new SettingsStore(filePath).load();
    expect(settings.refreshIntervalSeconds).toBe(30);
    expect(settings.colors.low).toBe(DEFAULT_COLORS.low);
  });
});
