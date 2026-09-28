import type { UsageLimit, UsageSnapshot } from '../shared/types';

/** Thrown when claude.ai answers with data this app does not understand. */
export class InvalidResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidResponseError';
  }
}

export interface AccountInfo {
  uuid: string | null;
  email: string;
}

export interface Organization {
  uuid: string;
  name: string | null;
  capabilities: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Parses `resets_at`. claude.ai sends ISO 8601 strings, currently with
 * microseconds and an offset ("2026-07-03T00:30:00.440902+00:00"). Epoch
 * numbers (seconds or milliseconds) are accepted as well.
 */
export function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return value < 1e11 ? value * 1000 : value;
  }
  const text = nonEmptyString(value);
  if (text === null) return null;
  // Trim fractional seconds to milliseconds, the precision Date.parse is specified for.
  const normalized = text.replace(/(\.\d{3})\d+/, '$1');
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? null : parsed;
}

function parseLimit(value: unknown): UsageLimit | null {
  if (!isRecord(value)) return null;
  const utilization = toNumber(value.utilization ?? value.percent);
  if (utilization === null) return null;
  return {
    utilization: Math.min(100, Math.max(0, utilization)),
    resetsAt: parseTimestamp(value.resets_at),
  };
}

function findLimit(limits: unknown, kind: string): unknown {
  if (!Array.isArray(limits)) return undefined;
  return limits.find((entry) => isRecord(entry) && entry.kind === kind);
}

/**
 * Parses `GET /api/organizations/{uuid}/usage`. The session and weekly limits
 * are read from `five_hour` / `seven_day` (utilization in percent), falling
 * back to the newer `limits` array (`kind` "session" / "weekly_all").
 */
export function parseUsage(json: unknown, fetchedAt: number): UsageSnapshot {
  if (!isRecord(json)) throw new InvalidResponseError('Usage response is not an object.');
  return {
    session: parseLimit(json.five_hour) ?? parseLimit(findLimit(json.limits, 'session')),
    weekly: parseLimit(json.seven_day) ?? parseLimit(findLimit(json.limits, 'weekly_all')),
    fetchedAt,
  };
}

/** Parses `GET /api/account`. */
export function parseAccount(json: unknown): AccountInfo {
  if (!isRecord(json)) throw new InvalidResponseError('Account response is not an object.');
  const email = nonEmptyString(json.email_address) ?? nonEmptyString(json.email);
  if (email === null) throw new InvalidResponseError('Account response contains no email address.');
  return { uuid: nonEmptyString(json.uuid), email };
}

/** Parses `GET /api/bootstrap`, which wraps the account in an `account` field. */
export function parseBootstrapAccount(json: unknown): AccountInfo {
  if (!isRecord(json) || !isRecord(json.account)) {
    throw new InvalidResponseError('Bootstrap response contains no account.');
  }
  return parseAccount(json.account);
}

/** Parses `GET /api/organizations`. Entries without a uuid are skipped. */
export function parseOrganizations(json: unknown): Organization[] {
  if (!Array.isArray(json)) throw new InvalidResponseError('Organizations response is not a list.');
  const organizations: Organization[] = [];
  for (const entry of json) {
    if (!isRecord(entry)) continue;
    const uuid = nonEmptyString(entry.uuid);
    if (uuid === null) continue;
    organizations.push({
      uuid,
      name: nonEmptyString(entry.name),
      capabilities: Array.isArray(entry.capabilities)
        ? entry.capabilities.filter((capability): capability is string => typeof capability === 'string')
        : [],
    });
  }
  return organizations;
}

/**
 * Chooses the organization whose chat usage should be shown: the preferred one
 * (last active in the browser, or the one used before) if present, otherwise
 * the first chat organization, then the first that is not API-only. API-only
 * organizations (Console accounts) have no claude.ai usage limits.
 */
export function pickOrganization(organizations: readonly Organization[], preferredId: string | null): Organization | null {
  const isApiOnly = (organization: Organization) =>
    organization.capabilities.length > 0 && organization.capabilities.every((capability) => capability === 'api');
  if (preferredId !== null) {
    const preferred = organizations.find((organization) => organization.uuid === preferredId);
    if (preferred && !isApiOnly(preferred)) return preferred;
  }
  return (
    organizations.find((organization) => organization.capabilities.includes('chat')) ??
    organizations.find((organization) => !isApiOnly(organization)) ??
    null
  );
}
