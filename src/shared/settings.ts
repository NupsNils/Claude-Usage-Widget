import { DEFAULT_COLORS, normalizeHexColor } from './gradient';
import type { GradientColors, Settings, SettingsPatch, WindowPosition } from './types';

export const MIN_REFRESH_INTERVAL_SECONDS = 30;
export const MAX_REFRESH_INTERVAL_SECONDS = 3600;

export const DEFAULT_WIDGET_WIDTH = 340;
/** Narrower, a collapsed account with a status badge would leave almost no room for its name. */
export const MIN_WIDGET_WIDTH = 280;
export const MAX_WIDGET_WIDTH = 800;
export const MIN_WIDGET_HEIGHT = 80;
/** Upper bound for a stored height; the widget is also never taller than the screen. */
export const MAX_WIDGET_HEIGHT = 10_000;

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  refreshIntervalSeconds: 60,
  alwaysOnTop: true,
  launchAtStartup: false,
  colors: { ...DEFAULT_COLORS },
  widgetPosition: null,
  widgetWidth: DEFAULT_WIDGET_WIDTH,
  widgetHeight: null,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeRefreshInterval(value: unknown, fallback: number): number {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number)) return fallback;
  return Math.min(MAX_REFRESH_INTERVAL_SECONDS, Math.max(MIN_REFRESH_INTERVAL_SECONDS, Math.round(number)));
}

function normalizeColors(value: unknown, fallback: GradientColors): GradientColors {
  const raw = isRecord(value) ? value : {};
  return {
    low: normalizeHexColor(raw.low) ?? fallback.low,
    mid: normalizeHexColor(raw.mid) ?? fallback.mid,
    high: normalizeHexColor(raw.high) ?? fallback.high,
  };
}

function normalizePosition(value: unknown): WindowPosition | null {
  if (!isRecord(value)) return null;
  const { x, y } = value;
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: Math.round(x), y: Math.round(y) };
}

function clampRounded(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function normalizeWidgetWidth(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_WIDGET_WIDTH;
  return clampRounded(value, MIN_WIDGET_WIDTH, MAX_WIDGET_WIDTH);
}

/** A missing or invalid height means "fit the content". */
export function normalizeWidgetHeight(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return clampRounded(value, MIN_WIDGET_HEIGHT, MAX_WIDGET_HEIGHT);
}

/** Turns whatever was stored on disk into valid settings, falling back to defaults field by field. */
export function normalizeSettings(value: unknown): Settings {
  const raw = isRecord(value) ? value : {};
  return {
    refreshIntervalSeconds: normalizeRefreshInterval(raw.refreshIntervalSeconds, DEFAULT_SETTINGS.refreshIntervalSeconds),
    alwaysOnTop: typeof raw.alwaysOnTop === 'boolean' ? raw.alwaysOnTop : DEFAULT_SETTINGS.alwaysOnTop,
    launchAtStartup: typeof raw.launchAtStartup === 'boolean' ? raw.launchAtStartup : DEFAULT_SETTINGS.launchAtStartup,
    colors: normalizeColors(raw.colors, DEFAULT_SETTINGS.colors),
    widgetPosition: normalizePosition(raw.widgetPosition),
    widgetWidth: normalizeWidgetWidth(raw.widgetWidth),
    widgetHeight: normalizeWidgetHeight(raw.widgetHeight),
  };
}

/** Applies a patch from the settings window. Invalid fields in the patch are ignored. */
export function applySettingsPatch(current: Settings, patch: unknown): Settings {
  if (!isRecord(patch)) return current;
  const typed = patch as Record<keyof SettingsPatch, unknown>;
  return {
    ...current,
    refreshIntervalSeconds:
      typed.refreshIntervalSeconds === undefined
        ? current.refreshIntervalSeconds
        : normalizeRefreshInterval(typed.refreshIntervalSeconds, current.refreshIntervalSeconds),
    alwaysOnTop: typeof typed.alwaysOnTop === 'boolean' ? typed.alwaysOnTop : current.alwaysOnTop,
    launchAtStartup: typeof typed.launchAtStartup === 'boolean' ? typed.launchAtStartup : current.launchAtStartup,
    colors: normalizeColors({ ...current.colors, ...(isRecord(typed.colors) ? typed.colors : {}) }, current.colors),
  };
}
