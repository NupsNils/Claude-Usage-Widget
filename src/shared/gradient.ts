import type { GradientColors } from './types';

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

interface OkLab {
  l: number;
  a: number;
  b: number;
}

export const DEFAULT_COLORS: Readonly<GradientColors> = Object.freeze({
  low: '#22c55e',
  mid: '#facc15',
  high: '#ef4444',
});

const HEX_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_PATTERN.test(value.trim());
}

/** Parses `#rgb` or `#rrggbb`. Returns null for anything else. */
export function parseHexColor(value: string): Rgb | null {
  const hex = value.trim();
  if (!HEX_PATTERN.test(hex)) return null;
  const digits =
    hex.length === 4
      ? hex
          .slice(1)
          .split('')
          .map((c) => c + c)
          .join('')
      : hex.slice(1);
  return {
    r: Number.parseInt(digits.slice(0, 2), 16),
    g: Number.parseInt(digits.slice(2, 4), 16),
    b: Number.parseInt(digits.slice(4, 6), 16),
  };
}

export function toHexColor({ r, g, b }: Rgb): string {
  const channel = (v: number) =>
    Math.round(Math.min(255, Math.max(0, v)))
      .toString(16)
      .padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/** Normalizes a valid hex color to lowercase `#rrggbb`; returns null for invalid input. */
export function normalizeHexColor(value: unknown): string | null {
  if (!isHexColor(value)) return null;
  const rgb = parseHexColor(value);
  return rgb ? toHexColor(rgb) : null;
}

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value: number): number {
  const c = value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
  return Math.min(1, Math.max(0, c)) * 255;
}

function rgbToOkLab({ r, g, b }: Rgb): OkLab {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

function okLabToRgb({ l: L, a, b }: OkLab): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Mixes two hex colors in the OKLab color space, which is also what the CSS
 * gradient uses (`in oklab`), so sampled colors match the rendered bar.
 */
export function mixColors(from: string, to: string, t: number): string {
  const a = parseHexColor(from);
  const b = parseHexColor(to);
  if (!a || !b) throw new Error(`Invalid color: ${!a ? from : to}`);
  const amount = clamp01(t);
  if (amount === 0) return toHexColor(a);
  if (amount === 1) return toHexColor(b);
  const labA = rgbToOkLab(a);
  const labB = rgbToOkLab(b);
  return toHexColor(
    okLabToRgb({
      l: labA.l + (labB.l - labA.l) * amount,
      a: labA.a + (labB.a - labA.a) * amount,
      b: labA.b + (labB.b - labA.b) * amount,
    }),
  );
}

/** Returns the gradient color at `percent` (0-100): low at 0, mid at 50, high at 100. */
export function sampleGradient(colors: GradientColors, percent: number): string {
  const t = clamp01(percent / 100);
  return t <= 0.5 ? mixColors(colors.low, colors.mid, t * 2) : mixColors(colors.mid, colors.high, (t - 0.5) * 2);
}

/** CSS background for the full-width gradient track. */
export function gradientCss(colors: GradientColors): string {
  return `linear-gradient(to right in oklab, ${colors.low} 0%, ${colors.mid} 50%, ${colors.high} 100%)`;
}
