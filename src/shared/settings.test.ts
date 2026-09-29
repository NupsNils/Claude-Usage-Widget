import { describe, expect, it } from 'vitest';
import { DEFAULT_COLORS } from './gradient';
import {
  DEFAULT_SETTINGS,
  DEFAULT_WIDGET_WIDTH,
  MAX_REFRESH_INTERVAL_SECONDS,
  MAX_WIDGET_WIDTH,
  MIN_REFRESH_INTERVAL_SECONDS,
  MIN_WIDGET_HEIGHT,
  MIN_WIDGET_WIDTH,
  applySettingsPatch,
  normalizeRefreshInterval,
  normalizeSettings,
  normalizeWidgetHeight,
  normalizeWidgetWidth,
} from './settings';

describe('normalizeSettings', () => {
  it('returns the defaults for missing or invalid input', () => {
    for (const input of [undefined, null, 42, 'text', [], {}]) {
      expect(normalizeSettings(input)).toEqual(DEFAULT_SETTINGS);
    }
  });

  it('keeps valid values', () => {
    const stored = {
      refreshIntervalSeconds: 120,
      alwaysOnTop: false,
      launchAtStartup: true,
      colors: { low: '#00FF00', mid: '#ff0', high: '#aa0000' },
      widgetPosition: { x: 100.4, y: -20 },
      widgetWidth: 420.6,
      widgetHeight: 300,
    };
    expect(normalizeSettings(stored)).toEqual({
      refreshIntervalSeconds: 120,
      alwaysOnTop: false,
      launchAtStartup: true,
      colors: { low: '#00ff00', mid: '#ffff00', high: '#aa0000' },
      widgetPosition: { x: 100, y: -20 },
      widgetWidth: 421,
      widgetHeight: 300,
    });
  });

  it('replaces invalid fields individually', () => {
    const result = normalizeSettings({
      refreshIntervalSeconds: 'soon',
      alwaysOnTop: 'yes',
      colors: { low: 'green', mid: '#123456' },
      widgetPosition: { x: 'left', y: 3 },
      widgetWidth: 'wide',
      widgetHeight: Number.NaN,
    });
    expect(result.refreshIntervalSeconds).toBe(DEFAULT_SETTINGS.refreshIntervalSeconds);
    expect(result.alwaysOnTop).toBe(DEFAULT_SETTINGS.alwaysOnTop);
    expect(result.colors).toEqual({ low: DEFAULT_COLORS.low, mid: '#123456', high: DEFAULT_COLORS.high });
    expect(result.widgetPosition).toBeNull();
    expect(result.widgetWidth).toBe(DEFAULT_WIDGET_WIDTH);
    expect(result.widgetHeight).toBeNull();
  });

  it('does not share the default colors object', () => {
    const result = normalizeSettings({});
    result.colors.low = '#000000';
    expect(DEFAULT_SETTINGS.colors.low).toBe(DEFAULT_COLORS.low);
  });
});

describe('normalizeRefreshInterval', () => {
  it('clamps and rounds', () => {
    expect(normalizeRefreshInterval(5, 60)).toBe(MIN_REFRESH_INTERVAL_SECONDS);
    expect(normalizeRefreshInterval(99_999, 60)).toBe(MAX_REFRESH_INTERVAL_SECONDS);
    expect(normalizeRefreshInterval(90.6, 60)).toBe(91);
  });

  it('accepts numeric strings', () => {
    expect(normalizeRefreshInterval('300', 60)).toBe(300);
  });

  it('falls back for non-numeric values', () => {
    expect(normalizeRefreshInterval('', 60)).toBe(60);
    expect(normalizeRefreshInterval('abc', 45)).toBe(45);
    expect(normalizeRefreshInterval(Number.NaN, 60)).toBe(60);
    expect(normalizeRefreshInterval(null, 60)).toBe(60);
  });
});

describe('widget size', () => {
  it('clamps the width and rounds it', () => {
    expect(normalizeWidgetWidth(10)).toBe(MIN_WIDGET_WIDTH);
    expect(normalizeWidgetWidth(5000)).toBe(MAX_WIDGET_WIDTH);
    expect(normalizeWidgetWidth(333.4)).toBe(333);
    expect(normalizeWidgetWidth(null)).toBe(DEFAULT_WIDGET_WIDTH);
    expect(normalizeWidgetWidth(Number.POSITIVE_INFINITY)).toBe(DEFAULT_WIDGET_WIDTH);
  });

  it('clamps the height and treats anything else as "fit the content"', () => {
    expect(normalizeWidgetHeight(1)).toBe(MIN_WIDGET_HEIGHT);
    expect(normalizeWidgetHeight(250.5)).toBe(251);
    expect(normalizeWidgetHeight(null)).toBeNull();
    expect(normalizeWidgetHeight('200')).toBeNull();
  });
});

describe('applySettingsPatch', () => {
  const current = normalizeSettings({ widgetPosition: { x: 10, y: 20 } });

  it('applies valid fields and keeps the rest', () => {
    const next = applySettingsPatch(current, { refreshIntervalSeconds: 300, alwaysOnTop: false });
    expect(next).toEqual({ ...current, refreshIntervalSeconds: 300, alwaysOnTop: false });
  });

  it('merges individual colors', () => {
    const next = applySettingsPatch(current, { colors: { high: '#FF0000' } });
    expect(next.colors).toEqual({ ...current.colors, high: '#ff0000' });
  });

  it('ignores invalid fields', () => {
    const next = applySettingsPatch(current, {
      refreshIntervalSeconds: 'never',
      launchAtStartup: 1,
      colors: { low: 'not a color' },
    });
    expect(next).toEqual(current);
  });

  it('does not let the patch move or resize the widget', () => {
    const next = applySettingsPatch(current, { widgetPosition: { x: 0, y: 0 }, widgetWidth: 500, widgetHeight: 100 });
    expect(next.widgetPosition).toEqual({ x: 10, y: 20 });
    expect(next.widgetWidth).toBe(DEFAULT_WIDGET_WIDTH);
    expect(next.widgetHeight).toBeNull();
  });

  it('ignores non-object patches', () => {
    expect(applySettingsPatch(current, null)).toBe(current);
    expect(applySettingsPatch(current, 'x')).toBe(current);
  });
});
