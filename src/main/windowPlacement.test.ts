import { describe, expect, it } from 'vitest';
import { clampRectToArea, resolveWidgetPosition } from './windowPlacement';

const primary = { x: 0, y: 0, width: 1920, height: 1040 };
const secondary = { x: 1920, y: 0, width: 1280, height: 984 };
const size = { width: 340, height: 300 };

describe('resolveWidgetPosition', () => {
  it('uses the top-right corner of the primary display without a saved position', () => {
    expect(resolveWidgetPosition(null, size, [primary], primary)).toEqual({ x: 1920 - 340 - 16, y: 16 });
  });

  it('respects the offset of the primary work area', () => {
    const shifted = { x: 0, y: 48, width: 1920, height: 1032 };
    expect(resolveWidgetPosition(null, size, [shifted], shifted)).toEqual({ x: 1564, y: 64 });
  });

  it('keeps a saved position on any display', () => {
    expect(resolveWidgetPosition({ x: 2000, y: 100 }, size, [primary, secondary], primary)).toEqual({ x: 2000, y: 100 });
  });

  it('keeps a position that is only partly visible', () => {
    expect(resolveWidgetPosition({ x: 1800, y: 900 }, size, [primary], primary)).toEqual({ x: 1800, y: 900 });
  });

  it('falls back when the saved display is gone', () => {
    expect(resolveWidgetPosition({ x: 2500, y: 100 }, size, [primary], primary)).toEqual({ x: 1564, y: 16 });
  });

  it('falls back when too little of the widget would be visible', () => {
    expect(resolveWidgetPosition({ x: 1900, y: 100 }, size, [primary], primary)).toEqual({ x: 1564, y: 16 });
    expect(resolveWidgetPosition({ x: 100, y: -290 }, size, [primary], primary)).toEqual({ x: 1564, y: 16 });
  });
});

describe('clampRectToArea', () => {
  it('leaves a rect that already fits unchanged', () => {
    const rect = { x: 100, y: 100, width: 340, height: 300 };
    expect(clampRectToArea(rect, primary)).toEqual(rect);
  });

  it('moves a rect back inside the area', () => {
    expect(clampRectToArea({ x: 1800, y: 900, width: 340, height: 300 }, primary)).toEqual({
      x: 1580,
      y: 740,
      width: 340,
      height: 300,
    });
    expect(clampRectToArea({ x: -50, y: -10, width: 340, height: 300 }, primary)).toEqual({
      x: 0,
      y: 0,
      width: 340,
      height: 300,
    });
  });

  it('aligns an oversized rect with the top-left corner of the area', () => {
    expect(clampRectToArea({ x: 500, y: 500, width: 340, height: 2000 }, primary)).toEqual({
      x: 500,
      y: 0,
      width: 340,
      height: 2000,
    });
  });
});
