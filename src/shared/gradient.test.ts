import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COLORS,
  gradientCss,
  isHexColor,
  mixColors,
  normalizeHexColor,
  parseHexColor,
  sampleGradient,
  toHexColor,
} from './gradient';

describe('parseHexColor', () => {
  it('parses six-digit colors', () => {
    expect(parseHexColor('#22c55e')).toEqual({ r: 0x22, g: 0xc5, b: 0x5e });
  });

  it('parses three-digit colors and ignores case and surrounding whitespace', () => {
    expect(parseHexColor(' #F0a ')).toEqual({ r: 0xff, g: 0x00, b: 0xaa });
  });

  it.each(['', '22c55e', '#12345', '#1234567', '#ggg', 'red', '#12 456'])('rejects %j', (value) => {
    expect(parseHexColor(value)).toBeNull();
  });
});

describe('isHexColor / normalizeHexColor', () => {
  it('accepts only strings in hex notation', () => {
    expect(isHexColor('#abc')).toBe(true);
    expect(isHexColor('#AABBCC')).toBe(true);
    expect(isHexColor(123)).toBe(false);
    expect(isHexColor(null)).toBe(false);
    expect(isHexColor('rgb(0,0,0)')).toBe(false);
  });

  it('normalizes to lowercase six-digit notation', () => {
    expect(normalizeHexColor('#ABC')).toBe('#aabbcc');
    expect(normalizeHexColor('#EF4444')).toBe('#ef4444');
    expect(normalizeHexColor('nope')).toBeNull();
  });
});

describe('toHexColor', () => {
  it('rounds and clamps channels', () => {
    expect(toHexColor({ r: 254.6, g: -10, b: 300 })).toBe('#ff00ff');
    expect(toHexColor({ r: 0, g: 15.4, b: 16 })).toBe('#000f10');
  });
});

describe('mixColors', () => {
  it('returns the exact endpoints at 0 and 1', () => {
    expect(mixColors('#22c55e', '#ef4444', 0)).toBe('#22c55e');
    expect(mixColors('#22c55e', '#ef4444', 1)).toBe('#ef4444');
  });

  it('clamps the mix amount', () => {
    expect(mixColors('#000000', '#ffffff', -1)).toBe('#000000');
    expect(mixColors('#000000', '#ffffff', 2)).toBe('#ffffff');
    expect(mixColors('#000000', '#ffffff', Number.NaN)).toBe('#000000');
  });

  it('keeps identical colors unchanged', () => {
    expect(mixColors('#336699', '#336699', 0.37)).toBe('#336699');
  });

  it('interpolates perceptually between black and white', () => {
    // OKLab lightness 0.5 is a mid grey of roughly #636363.
    const mid = parseHexColor(mixColors('#000000', '#ffffff', 0.5));
    expect(mid).not.toBeNull();
    expect(mid!.r).toBe(mid!.g);
    expect(mid!.g).toBe(mid!.b);
    expect(mid!.r).toBeGreaterThan(0x5c);
    expect(mid!.r).toBeLessThan(0x6a);
  });

  it('throws on invalid colors', () => {
    expect(() => mixColors('#000', 'blue', 0.5)).toThrow(/Invalid color/);
  });
});

describe('sampleGradient', () => {
  it('hits the three stops exactly', () => {
    expect(sampleGradient(DEFAULT_COLORS, 0)).toBe(DEFAULT_COLORS.low);
    expect(sampleGradient(DEFAULT_COLORS, 50)).toBe(DEFAULT_COLORS.mid);
    expect(sampleGradient(DEFAULT_COLORS, 100)).toBe(DEFAULT_COLORS.high);
  });

  it('clamps percentages outside 0-100', () => {
    expect(sampleGradient(DEFAULT_COLORS, -20)).toBe(DEFAULT_COLORS.low);
    expect(sampleGradient(DEFAULT_COLORS, 140)).toBe(DEFAULT_COLORS.high);
  });

  it('moves from green towards red as usage grows', () => {
    const red = (percent: number) => parseHexColor(sampleGradient(DEFAULT_COLORS, percent))!.r;
    const green = (percent: number) => parseHexColor(sampleGradient(DEFAULT_COLORS, percent))!.g;
    expect(red(25)).toBeGreaterThan(red(0));
    expect(red(50)).toBeGreaterThan(red(25));
    expect(green(75)).toBeLessThan(green(50));
    expect(green(100)).toBeLessThan(green(75));
  });
});

describe('gradientCss', () => {
  it('builds a left-to-right OKLab gradient with the three stops', () => {
    expect(gradientCss({ low: '#000000', mid: '#777777', high: '#ffffff' })).toBe(
      'linear-gradient(to right in oklab, #000000 0%, #777777 50%, #ffffff 100%)',
    );
  });
});
