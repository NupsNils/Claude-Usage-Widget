/** Extra time after a reset before refreshing, so the server has rolled over. */
export const RESET_GRACE_MS = 5_000;
const MIN_DELAY_MS = 1_000;

/**
 * Delay until the next automatic refresh: the regular interval, or shortly after
 * the next known reset time if that comes first.
 */
export function nextRefreshDelay(now: number, intervalMs: number, resetTimes: ReadonlyArray<number | null>): number {
  let delay = intervalMs;
  for (const resetsAt of resetTimes) {
    if (resetsAt !== null && resetsAt > now) {
      delay = Math.min(delay, resetsAt - now + RESET_GRACE_MS);
    }
  }
  return Math.max(MIN_DELAY_MS, Math.round(delay));
}
