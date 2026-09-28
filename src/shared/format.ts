import type { UsageLimit } from './types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Locale for dates and times: English words with a 24-hour clock. */
export const DISPLAY_LOCALE = 'en-GB';

export interface FormatOptions {
  /** IANA time zone. Defaults to the system time zone. */
  timeZone?: string;
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

export function formatPercent(value: number): string {
  return `${Math.round(clampPercent(value))}%`;
}

/**
 * Formats a remaining duration for a countdown, rounding up to whole minutes:
 * "45m", "2h 14m", "3h", "3d 4h", "2d".
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0m';
  const totalMinutes = Math.ceil(ms / MINUTE);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  if (totalMinutes < 24 * 60) {
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  }
  const totalHours = Math.ceil(ms / HOUR);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
}

/** "16:40" when the reset is within the next 24 hours, otherwise "Thu 09:00". */
export function formatResetTime(resetsAt: number, now: number, options: FormatOptions = {}): string {
  const date = new Date(resetsAt);
  const time = new Intl.DateTimeFormat(DISPLAY_LOCALE, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: options.timeZone,
  }).format(date);
  if (resetsAt - now < DAY) return time;
  const weekday = new Intl.DateTimeFormat(DISPLAY_LOCALE, {
    weekday: 'short',
    timeZone: options.timeZone,
  }).format(date);
  return `${weekday} ${time}`;
}

/**
 * Returns the limit as it applies right now. Once the reset time has passed,
 * the window is over: usage is back to zero and no new window has started yet.
 */
export function effectiveLimit(limit: UsageLimit, now: number): UsageLimit {
  if (limit.resetsAt !== null && limit.resetsAt <= now) {
    return { utilization: 0, resetsAt: null };
  }
  return { utilization: clampPercent(limit.utilization), resetsAt: limit.resetsAt };
}

export interface LimitDisplay {
  /** Used share, 0-100, for the bar width. */
  percent: number;
  /** "34%" */
  percentText: string;
  /** "66% left" */
  remainingText: string;
  /** "Resets in 2h 14m", "Not started" or "Not available" */
  resetText: string;
  /** "16:40" / "Thu 09:00", or null when there is no reset time. */
  resetTimeText: string | null;
}

export function describeLimit(limit: UsageLimit | null, now: number, options: FormatOptions = {}): LimitDisplay {
  if (limit === null) {
    return { percent: 0, percentText: '-', remainingText: '', resetText: 'Not available', resetTimeText: null };
  }
  const current = effectiveLimit(limit, now);
  const percent = current.utilization;
  const remaining = 100 - Math.round(percent);
  const base = {
    percent,
    percentText: formatPercent(percent),
    remainingText: `${remaining}% left`,
  };
  if (current.resetsAt === null) {
    return { ...base, resetText: 'Not started', resetTimeText: null };
  }
  return {
    ...base,
    resetText: `Resets in ${formatDuration(current.resetsAt - now)}`,
    resetTimeText: formatResetTime(current.resetsAt, now, options),
  };
}

/** "Updated 14:32" style clock time. */
export function formatClockTime(timestamp: number, options: FormatOptions = {}): string {
  return new Intl.DateTimeFormat(DISPLAY_LOCALE, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: options.timeZone,
  }).format(new Date(timestamp));
}
