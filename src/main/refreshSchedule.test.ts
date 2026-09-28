import { describe, expect, it } from 'vitest';
import { RESET_GRACE_MS, nextRefreshDelay } from './refreshSchedule';

const NOW = 1_000_000;

describe('nextRefreshDelay', () => {
  it('uses the interval when no reset is known', () => {
    expect(nextRefreshDelay(NOW, 60_000, [])).toBe(60_000);
    expect(nextRefreshDelay(NOW, 60_000, [null, null])).toBe(60_000);
  });

  it('refreshes shortly after a reset that comes before the interval ends', () => {
    expect(nextRefreshDelay(NOW, 60_000, [NOW + 10_000, null])).toBe(10_000 + RESET_GRACE_MS);
  });

  it('uses the earliest upcoming reset', () => {
    expect(nextRefreshDelay(NOW, 600_000, [NOW + 50_000, NOW + 20_000])).toBe(20_000 + RESET_GRACE_MS);
  });

  it('ignores resets that are later than the interval or already passed', () => {
    expect(nextRefreshDelay(NOW, 60_000, [NOW + 3_600_000, NOW - 5_000, NOW])).toBe(60_000);
  });

  it('never returns less than one second', () => {
    expect(nextRefreshDelay(NOW, 10, [])).toBe(1_000);
  });
});
