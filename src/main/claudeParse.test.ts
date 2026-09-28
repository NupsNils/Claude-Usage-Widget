import { describe, expect, it } from 'vitest';
import {
  InvalidResponseError,
  parseAccount,
  parseBootstrapAccount,
  parseOrganizations,
  parseTimestamp,
  parseUsage,
  pickOrganization,
  type Organization,
} from './claudeParse';

const FETCHED_AT = 1_780_000_000_000;

describe('parseTimestamp', () => {
  it('parses ISO strings with microseconds and an offset', () => {
    expect(parseTimestamp('2026-07-03T00:30:00.440902+00:00')).toBe(Date.UTC(2026, 6, 3, 0, 30, 0, 440));
  });

  it('parses ISO strings with milliseconds or without fractions', () => {
    expect(parseTimestamp('2026-07-08T09:00:00.000Z')).toBe(Date.UTC(2026, 6, 8, 9));
    expect(parseTimestamp('2026-07-08T09:00:00Z')).toBe(Date.UTC(2026, 6, 8, 9));
    expect(parseTimestamp('2026-07-08T11:00:00+02:00')).toBe(Date.UTC(2026, 6, 8, 9));
  });

  it('accepts epoch seconds and milliseconds', () => {
    expect(parseTimestamp(1_780_000_000)).toBe(1_780_000_000_000);
    expect(parseTimestamp(1_780_000_000_000)).toBe(1_780_000_000_000);
  });

  it.each([null, undefined, '', '   ', 'soon', 0, -5, Number.NaN, {}, []])('returns null for %j', (value) => {
    expect(parseTimestamp(value)).toBeNull();
  });
});

describe('parseUsage', () => {
  it('parses a real response with the legacy buckets and the limits array', () => {
    // Captured from claude.ai on 2026-07-03 (published in the CodexBar test suite).
    const json = {
      five_hour: { utilization: 16, resets_at: '2026-07-03T00:30:00.440902+00:00' },
      seven_day: { utilization: 10, resets_at: '2026-07-08T09:00:00.440924+00:00' },
      seven_day_opus: null,
      seven_day_sonnet: null,
      seven_day_oauth_apps: null,
      extra_usage: null,
      limits: [
        { kind: 'session', group: 'session', percent: 16, resets_at: '2026-07-03T00:30:00.440902+00:00', scope: null, is_active: true },
        { kind: 'weekly_all', group: 'weekly', percent: 10, resets_at: '2026-07-08T09:00:00.440924+00:00', scope: null, is_active: true },
        { kind: 'weekly_scoped', group: 'weekly', percent: 5, resets_at: '2026-07-08T09:00:00.440924+00:00', scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: true },
      ],
    };
    expect(parseUsage(json, FETCHED_AT)).toEqual({
      session: { utilization: 16, resetsAt: Date.UTC(2026, 6, 3, 0, 30, 0, 440) },
      weekly: { utilization: 10, resetsAt: Date.UTC(2026, 6, 8, 9, 0, 0, 440) },
      fetchedAt: FETCHED_AT,
    });
  });

  it('keeps fractional utilization and clamps it to 0-100', () => {
    const result = parseUsage(
      { five_hour: { utilization: 41.6, resets_at: null }, seven_day: { utilization: 130, resets_at: null } },
      FETCHED_AT,
    );
    expect(result.session).toEqual({ utilization: 41.6, resetsAt: null });
    expect(result.weekly).toEqual({ utilization: 100, resetsAt: null });
  });

  it('reports a window that has not started', () => {
    expect(parseUsage({ five_hour: { utilization: 0.0, resets_at: null } }, FETCHED_AT).session).toEqual({
      utilization: 0,
      resetsAt: null,
    });
  });

  it('falls back to the limits array when the legacy buckets are missing', () => {
    const result = parseUsage(
      {
        five_hour: null,
        limits: [
          { kind: 'weekly_scoped', percent: 90, resets_at: null },
          { kind: 'session', percent: '22.5', resets_at: '2026-07-03T00:30:00Z' },
          { kind: 'weekly_all', percent: 7, resets_at: null },
        ],
      },
      FETCHED_AT,
    );
    expect(result.session).toEqual({ utilization: 22.5, resetsAt: Date.UTC(2026, 6, 3, 0, 30) });
    expect(result.weekly).toEqual({ utilization: 7, resetsAt: null });
  });

  it('returns null limits when nothing usable is reported (e.g. enterprise accounts)', () => {
    expect(parseUsage({ five_hour: null, seven_day: { resets_at: null }, limits: 'x' }, FETCHED_AT)).toEqual({
      session: null,
      weekly: null,
      fetchedAt: FETCHED_AT,
    });
  });

  it('rejects responses that are not objects', () => {
    expect(() => parseUsage(null, FETCHED_AT)).toThrow(InvalidResponseError);
    expect(() => parseUsage([], FETCHED_AT)).toThrow(InvalidResponseError);
    expect(() => parseUsage('<html>', FETCHED_AT)).toThrow(InvalidResponseError);
  });
});

describe('parseAccount / parseBootstrapAccount', () => {
  it('reads the email address and the account uuid', () => {
    expect(parseAccount({ uuid: 'u-1', email_address: 'alice@example.com', full_name: 'Alice' })).toEqual({
      uuid: 'u-1',
      email: 'alice@example.com',
    });
  });

  it('works without a uuid and with an `email` field', () => {
    expect(parseAccount({ email: ' bob@example.com ' })).toEqual({ uuid: null, email: 'bob@example.com' });
  });

  it('rejects accounts without an email address', () => {
    expect(() => parseAccount({ uuid: 'u-1' })).toThrow(/no email/);
    expect(() => parseAccount(null)).toThrow(InvalidResponseError);
  });

  it('unwraps the bootstrap response', () => {
    expect(parseBootstrapAccount({ account: { uuid: 'u-2', email_address: 'carol@example.com' } })).toEqual({
      uuid: 'u-2',
      email: 'carol@example.com',
    });
    expect(() => parseBootstrapAccount({})).toThrow(InvalidResponseError);
  });
});

describe('parseOrganizations', () => {
  it('reads uuid, name and capabilities and skips invalid entries', () => {
    expect(
      parseOrganizations([
        { uuid: 'org-1', id: 123, name: 'Personal', capabilities: ['chat', 'claude_pro', 7], rate_limit_tier: 'x' },
        { uuid: '', name: 'No uuid' },
        { name: 'Missing uuid' },
        'text',
        { uuid: 'org-2' },
      ]),
    ).toEqual([
      { uuid: 'org-1', name: 'Personal', capabilities: ['chat', 'claude_pro'] },
      { uuid: 'org-2', name: null, capabilities: [] },
    ]);
  });

  it('rejects responses that are not lists', () => {
    expect(() => parseOrganizations({ uuid: 'org-1' })).toThrow(InvalidResponseError);
  });
});

describe('pickOrganization', () => {
  const api: Organization = { uuid: 'api', name: 'Console', capabilities: ['api'] };
  const team: Organization = { uuid: 'team', name: 'Team', capabilities: ['chat', 'raven'] };
  const personal: Organization = { uuid: 'personal', name: 'Personal', capabilities: ['chat', 'claude_max'] };
  const unknown: Organization = { uuid: 'unknown', name: null, capabilities: [] };

  it('prefers the given organization', () => {
    expect(pickOrganization([team, personal], 'personal')).toBe(personal);
  });

  it('ignores a preferred organization that is missing or API-only', () => {
    expect(pickOrganization([api, team], 'gone')).toBe(team);
    expect(pickOrganization([api, team], 'api')).toBe(team);
  });

  it('picks the first chat organization', () => {
    expect(pickOrganization([api, unknown, personal, team], null)).toBe(personal);
  });

  it('falls back to the first organization that is not API-only', () => {
    expect(pickOrganization([api, unknown], null)).toBe(unknown);
  });

  it('returns null when there is no usable organization', () => {
    expect(pickOrganization([api], null)).toBeNull();
    expect(pickOrganization([], null)).toBeNull();
  });
});
