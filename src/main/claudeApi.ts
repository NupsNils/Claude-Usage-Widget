import type { UsageSnapshot } from '../shared/types';
import {
  InvalidResponseError,
  parseAccount,
  parseBootstrapAccount,
  parseOrganizations,
  parseUsage,
  pickOrganization,
  type AccountInfo,
  type Organization,
} from './claudeParse';
import type { AccountIdentity } from './accountStore';

export const CLAUDE_BASE_URL = 'https://claude.ai';

export type ApiErrorKind = 'auth' | 'blocked' | 'rate_limited' | 'http' | 'network' | 'invalid_response';

export class ClaudeApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'ClaudeApiError';
  }
}

export interface ResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/** A fetch function bound to one account's cookie store. It must honor `signal`. */
export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<ResponseLike>;

/** A request that takes longer is aborted, so a dead connection cannot block refreshing forever. */
export const REQUEST_TIMEOUT_MS = 20_000;

/** Headers the claude.ai web app sends with its own API requests. */
const REQUEST_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  accept: 'application/json',
  'anthropic-client-platform': 'web_claude_ai',
  referer: `${CLAUDE_BASE_URL}/`,
});

function looksLikeHtml(body: string): boolean {
  return /^\s*<(?:!doctype|html)/i.test(body);
}

/**
 * Maps a non-2xx response to an error. A Cloudflare challenge (403 with
 * `cf-mitigated: challenge` or an HTML page) is not an authentication problem.
 */
export function classifyErrorResponse(status: number, cfMitigated: string | null, body: string): ClaudeApiError {
  if (status === 403 && (cfMitigated !== null || looksLikeHtml(body))) {
    return new ClaudeApiError('blocked', 'The request was blocked by claude.ai (Cloudflare).', status);
  }
  if (status === 401 || status === 403) {
    return new ClaudeApiError('auth', 'The claude.ai session is no longer valid.', status);
  }
  if (status === 429) {
    return new ClaudeApiError('rate_limited', 'claude.ai is rate limiting requests.', status);
  }
  return new ClaudeApiError('http', `claude.ai returned HTTP ${status}.`, status);
}

export class ClaudeApi {
  constructor(
    private readonly fetchFn: FetchLike,
    private readonly now: () => number = Date.now,
    private readonly timeoutMs: number = REQUEST_TIMEOUT_MS,
  ) {}

  async getAccount(): Promise<AccountInfo> {
    try {
      return parseAccount(await this.getJson('/api/account'));
    } catch (error) {
      const recoverable =
        error instanceof InvalidResponseError ||
        (error instanceof ClaudeApiError && error.kind === 'http' && error.status === 404);
      if (!recoverable) throw error;
      return parseBootstrapAccount(await this.getJson('/api/bootstrap'));
    }
  }

  async getOrganizations(): Promise<Organization[]> {
    return parseOrganizations(await this.getJson('/api/organizations'));
  }

  async getUsage(organizationId: string): Promise<UsageSnapshot> {
    const json = await this.getJson(`/api/organizations/${encodeURIComponent(organizationId)}/usage`);
    return parseUsage(json, this.now());
  }

  /** Loads the email address and the organization whose usage should be shown. */
  async getIdentity(preferredOrganizationId: string | null): Promise<AccountIdentity> {
    const [account, organizations] = await Promise.all([this.getAccount(), this.getOrganizations()]);
    const organization = pickOrganization(organizations, preferredOrganizationId);
    if (!organization) {
      throw new InvalidResponseError('This account has no Claude.ai chat organization.');
    }
    return {
      accountUuid: account.uuid,
      email: account.email,
      organizationId: organization.uuid,
      organizationName: organization.name,
    };
  }

  private async getJson(path: string): Promise<unknown> {
    let status: number;
    let cfMitigated: string | null;
    let body: string;
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      const response = await this.fetchFn(`${CLAUDE_BASE_URL}${path}`, { headers: { ...REQUEST_HEADERS }, signal });
      status = response.status;
      cfMitigated = response.headers.get('cf-mitigated');
      body = await response.text();
    } catch (error) {
      if (signal.aborted) {
        throw new ClaudeApiError('network', `claude.ai did not respond within ${Math.round(this.timeoutMs / 1000)} seconds.`);
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new ClaudeApiError('network', `Could not reach claude.ai (${reason}).`);
    }
    if (status < 200 || status >= 300) throw classifyErrorResponse(status, cfMitigated, body);
    try {
      return JSON.parse(body) as unknown;
    } catch {
      if (looksLikeHtml(body)) {
        throw new ClaudeApiError('blocked', 'claude.ai answered with a web page instead of data.', status);
      }
      throw new InvalidResponseError('claude.ai answered with invalid JSON.');
    }
  }
}
