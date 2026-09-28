import { effectiveLimit, formatPercent } from '../shared/format';
import type { AppState, UsageLimit } from '../shared/types';

/** Windows cuts tray tooltips off after 127 characters. */
export const MAX_TOOLTIP_LENGTH = 127;

function percent(limit: UsageLimit | null, now: number): string {
  return limit ? formatPercent(effectiveLimit(limit, now).utilization) : '-';
}

/** One line per account, e.g. "alice@example.com: 34% / 12%". */
export function trayTooltip(state: AppState, now: number): string {
  const lines = ['Claude Usage (session / weekly)'];
  if (state.accounts.length === 0) lines.push('No accounts');
  for (const account of state.accounts) {
    if (account.status === 'auth_error') {
      lines.push(`${account.label}: signed out`);
    } else if (!account.usage) {
      lines.push(`${account.label}: loading`);
    } else {
      lines.push(`${account.label}: ${percent(account.usage.session, now)} / ${percent(account.usage.weekly, now)}`);
    }
  }
  const text = lines.join('\n');
  return text.length <= MAX_TOOLTIP_LENGTH ? text : `${text.slice(0, MAX_TOOLTIP_LENGTH - 3)}...`;
}
