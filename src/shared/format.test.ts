import { describe, expect, it } from 'vitest';
import {
  clampPercent,
  describeLimit,
  effectiveLimit,
  formatClockTime,
  formatDuration,
  formatPercent,
  formatResetTime,
} from './format';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// Monday, 28 September 2026, 12:00 UTC
const NOW = Date.UTC(2026, 8, 28, 12, 0, 0);
const UTC = { timeZone: 'UTC' };

describe('clampPercent / formatPercent', () => {
  it('clamps to 0-100 and treats non-finite values as 0', () => {
    expect(clampPercent(-5)).toBe(0);
    expect(clampPercent(150)).toBe(100);
    expect(clampPercent(Number.NaN)).toBe(0);
    expect(clampPercent(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampPercent(42.5)).toBe(42.5);
  });

  it('rounds to whole percent', () => {
    expect(formatPercent(33.6)).toBe('34%');
    expect(formatPercent(33.4)).toBe('33%');
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(120)).toBe('100%');
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0m'],
    [-5_000, '0m'],
    [Number.NaN, '0m'],
    [1, '1m'],
    [59_000, '1m'],
    [MINUTE, '1m'],
    [MINUTE + 1_000, '2m'],
    [59 * MINUTE, '59m'],
    [59 * MINUTE + 30_000, '1h'],
    [2 * HOUR + 14 * MINUTE, '2h 14m'],
    [2 * HOUR + 13 * MINUTE + 1_000, '2h 14m'],
    [3 * HOUR, '3h'],
    [DAY - 30_000, '1d'],
    [DAY, '1d'],
    [3 * DAY + 4 * HOUR, '3d 4h'],
    [3 * DAY + 3 * HOUR + MINUTE, '3d 4h'],
    [2 * DAY, '2d'],
  ])('formats %d ms as %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});

describe('formatResetTime', () => {
  it('shows only the time when the reset is less than a day away', () => {
    expect(formatResetTime(NOW + 4 * HOUR + 40 * MINUTE, NOW, UTC)).toBe('16:40');
    expect(formatResetTime(NOW + 21 * HOUR + 5 * MINUTE, NOW, UTC)).toBe('09:05');
  });

  it('adds the weekday when the reset is a day or more away', () => {
    // Thursday, 1 October 2026, 09:00 UTC
    expect(formatResetTime(Date.UTC(2026, 9, 1, 9, 0), NOW, UTC)).toBe('Thu 09:00');
  });

  it('respects the time zone', () => {
    expect(formatResetTime(NOW + HOUR, NOW, { timeZone: 'Europe/Berlin' })).toBe('15:00');
  });
});

describe('formatClockTime', () => {
  it('uses a 24-hour clock', () => {
    expect(formatClockTime(Date.UTC(2026, 8, 28, 21, 7), UTC)).toBe('21:07');
  });
});

describe('effectiveLimit', () => {
  it('keeps an active window and clamps its utilization', () => {
    expect(effectiveLimit({ utilization: 104, resetsAt: NOW + HOUR }, NOW)).toEqual({
      utilization: 100,
      resetsAt: NOW + HOUR,
    });
  });

  it('keeps a window that has not started', () => {
    expect(effectiveLimit({ utilization: 0, resetsAt: null }, NOW)).toEqual({ utilization: 0, resetsAt: null });
  });

  it('resets usage once the reset time has passed', () => {
    expect(effectiveLimit({ utilization: 80, resetsAt: NOW - 1 }, NOW)).toEqual({ utilization: 0, resetsAt: null });
    expect(effectiveLimit({ utilization: 80, resetsAt: NOW }, NOW)).toEqual({ utilization: 0, resetsAt: null });
  });
});

describe('describeLimit', () => {
  it('describes an active window', () => {
    expect(describeLimit({ utilization: 34.2, resetsAt: NOW + 2 * HOUR + 14 * MINUTE }, NOW, UTC)).toEqual({
      percent: 34.2,
      percentText: '34%',
      remainingText: '66% left',
      resetText: 'Resets in 2h 14m',
      resetTimeText: '14:14',
    });
  });

  it('describes a window that has not started', () => {
    expect(describeLimit({ utilization: 0, resetsAt: null }, NOW, UTC)).toEqual({
      percent: 0,
      percentText: '0%',
      remainingText: '100% left',
      resetText: 'Not started',
      resetTimeText: null,
    });
  });

  it('treats an elapsed window as not started', () => {
    const display = describeLimit({ utilization: 91, resetsAt: NOW - MINUTE }, NOW, UTC);
    expect(display.percent).toBe(0);
    expect(display.resetText).toBe('Not started');
  });

  it('describes a missing limit', () => {
    expect(describeLimit(null, NOW, UTC)).toEqual({
      percent: 0,
      percentText: '-',
      remainingText: '',
      resetText: 'Not available',
      resetTimeText: null,
    });
  });

  it('keeps used and remaining consistent after rounding', () => {
    const display = describeLimit({ utilization: 99.6, resetsAt: NOW + HOUR }, NOW, UTC);
    expect(display.percentText).toBe('100%');
    expect(display.remainingText).toBe('0% left');
  });
});
