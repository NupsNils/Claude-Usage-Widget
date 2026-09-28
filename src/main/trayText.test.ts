import { describe, expect, it } from 'vitest';
import type { AccountView, AppState } from '../shared/types';
import { MAX_TOOLTIP_LENGTH, trayTooltip } from './trayText';

const NOW = 1_000_000;

function account(overrides: Partial<AccountView>): AccountView {
  return {
    id: 'a',
    label: 'alice@example.com',
    email: 'alice@example.com',
    customLabel: null,
    organizationName: null,
    status: 'ok',
    errorMessage: null,
    usage: {
      session: { utilization: 34.4, resetsAt: NOW + 1_000 },
      weekly: { utilization: 12, resetsAt: null },
      fetchedAt: NOW,
    },
    ...overrides,
  };
}

function state(accounts: AccountView[]): AppState {
  return { accounts, refreshing: false };
}

describe('trayTooltip', () => {
  it('shows a hint without accounts', () => {
    expect(trayTooltip(state([]), NOW)).toBe('Claude Usage (session / weekly)\nNo accounts');
  });

  it('lists session and weekly usage per account', () => {
    expect(trayTooltip(state([account({})]), NOW)).toBe('Claude Usage (session / weekly)\nalice@example.com: 34% / 12%');
  });

  it('shows 0% once a session window has elapsed', () => {
    expect(trayTooltip(state([account({})]), NOW + 5_000)).toContain(': 0% / 12%');
  });

  it('marks signed-out and loading accounts and missing limits', () => {
    const text = trayTooltip(
      state([
        account({ id: 'b', label: 'Work', status: 'auth_error' }),
        account({ id: 'c', label: 'New', status: 'loading', usage: null }),
        account({ id: 'd', label: 'Team', usage: { session: null, weekly: { utilization: 3, resetsAt: null }, fetchedAt: NOW } }),
      ]),
      NOW,
    );
    expect(text.split('\n').slice(1)).toEqual(['Work: signed out', 'New: loading', 'Team: - / 3%']);
  });

  it('never exceeds the Windows tooltip limit', () => {
    const many = Array.from({ length: 10 }, (_, index) => account({ id: String(index), label: `account-${index}@example.com` }));
    const text = trayTooltip(state(many), NOW);
    expect(text.length).toBe(MAX_TOOLTIP_LENGTH);
    expect(text.endsWith('...')).toBe(true);
  });
});
