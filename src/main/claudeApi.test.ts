import { describe, expect, it } from 'vitest';
import { CLAUDE_BASE_URL, ClaudeApi, ClaudeApiError, classifyErrorResponse, type FetchLike, type ResponseLike } from './claudeApi';
import { InvalidResponseError } from './claudeParse';

interface FakeReply {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

function response({ status = 200, body, headers = {} }: FakeReply): ResponseLike {
  const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    status,
    headers: { get: (name) => lower[name.toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

/** Fake fetch that answers by path and records every request. */
function fakeFetch(routes: Record<string, FakeReply | Error>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const path = url.slice(CLAUDE_BASE_URL.length);
    const route = routes[path];
    if (route === undefined) return response({ status: 404, body: { type: 'error' } });
    if (route instanceof Error) throw route;
    return response(route);
  };
  return { fetchFn, calls };
}

const NOW = 1_780_000_000_000;

describe('classifyErrorResponse', () => {
  it('treats a Cloudflare challenge as blocked, not as signed out', () => {
    expect(classifyErrorResponse(403, 'challenge', '').kind).toBe('blocked');
    expect(classifyErrorResponse(403, null, '<!DOCTYPE html><title>Just a moment...</title>').kind).toBe('blocked');
  });

  it('treats 401 and JSON 403 responses as authentication errors', () => {
    const body = JSON.stringify({
      type: 'error',
      error: { type: 'permission_error', message: 'Invalid authorization', details: { error_code: 'account_session_invalid' } },
    });
    expect(classifyErrorResponse(403, null, body).kind).toBe('auth');
    expect(classifyErrorResponse(401, null, '').kind).toBe('auth');
  });

  it('recognizes rate limiting and other HTTP errors', () => {
    expect(classifyErrorResponse(429, null, '').kind).toBe('rate_limited');
    const error = classifyErrorResponse(500, null, '');
    expect(error.kind).toBe('http');
    expect(error.status).toBe(500);
    expect(error.message).toBe('claude.ai returned HTTP 500.');
  });
});

describe('ClaudeApi', () => {
  it('requests usage for the organization with JSON headers', async () => {
    const { fetchFn, calls } = fakeFetch({
      '/api/organizations/org%2F1/usage': {
        body: { five_hour: { utilization: 34, resets_at: '2026-07-03T00:30:00Z' }, seven_day: { utilization: 12, resets_at: null } },
      },
    });
    const usage = await new ClaudeApi(fetchFn, () => NOW).getUsage('org/1');
    expect(usage).toEqual({
      session: { utilization: 34, resetsAt: Date.UTC(2026, 6, 3, 0, 30) },
      weekly: { utilization: 12, resetsAt: null },
      fetchedAt: NOW,
    });
    expect(calls[0]).toEqual({
      url: 'https://claude.ai/api/organizations/org%2F1/usage',
      headers: { accept: 'application/json', 'anthropic-client-platform': 'web_claude_ai', referer: 'https://claude.ai/' },
    });
  });

  it('loads the identity from the account and organization endpoints', async () => {
    const { fetchFn } = fakeFetch({
      '/api/account': { body: { uuid: 'u-1', email_address: 'alice@example.com' } },
      '/api/organizations': {
        body: [
          { uuid: 'org-api', name: 'Console', capabilities: ['api'] },
          { uuid: 'org-chat', name: 'Personal', capabilities: ['chat'] },
        ],
      },
    });
    await expect(new ClaudeApi(fetchFn).getIdentity(null)).resolves.toEqual({
      accountUuid: 'u-1',
      email: 'alice@example.com',
      organizationId: 'org-chat',
      organizationName: 'Personal',
    });
  });

  it('uses the preferred organization when it exists', async () => {
    const { fetchFn } = fakeFetch({
      '/api/account': { body: { email_address: 'alice@example.com' } },
      '/api/organizations': {
        body: [
          { uuid: 'org-a', name: 'A', capabilities: ['chat'] },
          { uuid: 'org-b', name: 'B', capabilities: ['chat'] },
        ],
      },
    });
    expect((await new ClaudeApi(fetchFn).getIdentity('org-b')).organizationId).toBe('org-b');
  });

  it('fails when the account has no chat organization', async () => {
    const { fetchFn } = fakeFetch({
      '/api/account': { body: { email_address: 'alice@example.com' } },
      '/api/organizations': { body: [{ uuid: 'org-api', capabilities: ['api'] }] },
    });
    await expect(new ClaudeApi(fetchFn).getIdentity(null)).rejects.toThrow(/no Claude.ai chat organization/);
  });

  it('falls back to the bootstrap endpoint for the email address', async () => {
    const { fetchFn, calls } = fakeFetch({
      '/api/account': { body: { uuid: 'u-1' } },
      '/api/bootstrap': { body: { account: { uuid: 'u-1', email_address: 'alice@example.com' } } },
    });
    await expect(new ClaudeApi(fetchFn).getAccount()).resolves.toEqual({ uuid: 'u-1', email: 'alice@example.com' });
    expect(calls.map((call) => call.url)).toEqual(['https://claude.ai/api/account', 'https://claude.ai/api/bootstrap']);
  });

  it('also falls back when the account endpoint does not exist', async () => {
    const { fetchFn } = fakeFetch({
      '/api/bootstrap': { body: { account: { email_address: 'alice@example.com' } } },
    });
    await expect(new ClaudeApi(fetchFn).getAccount()).resolves.toEqual({ uuid: null, email: 'alice@example.com' });
  });

  it('does not fall back on authentication errors', async () => {
    const { fetchFn, calls } = fakeFetch({ '/api/account': { status: 401, body: '' } });
    await expect(new ClaudeApi(fetchFn).getAccount()).rejects.toMatchObject({ kind: 'auth', status: 401 });
    expect(calls).toHaveLength(1);
  });

  it('reports network failures', async () => {
    const { fetchFn } = fakeFetch({ '/api/organizations': new Error('net::ERR_INTERNET_DISCONNECTED') });
    const error = await new ClaudeApi(fetchFn).getOrganizations().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ClaudeApiError);
    expect(error).toMatchObject({ kind: 'network', status: null });
    expect((error as Error).message).toContain('ERR_INTERNET_DISCONNECTED');
  });

  it('aborts a request that does not answer in time', async () => {
    let receivedSignal: AbortSignal | undefined;
    const hangingFetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        receivedSignal = init.signal;
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      });
    const api = new ClaudeApi(hangingFetch, Date.now, 30);
    await expect(api.getOrganizations()).rejects.toMatchObject({
      kind: 'network',
      message: 'claude.ai did not respond within 0 seconds.',
    });
    expect(receivedSignal?.aborted).toBe(true);
  });

  it('passes an abort signal with every request', async () => {
    const signals: AbortSignal[] = [];
    const api = new ClaudeApi(async (_url, init) => {
      signals.push(init.signal);
      return response({ body: [] });
    });
    await api.getOrganizations();
    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]?.aborted).toBe(false);
  });

  it('reports a Cloudflare challenge', async () => {
    const { fetchFn } = fakeFetch({
      '/api/organizations': { status: 403, body: '<html>Just a moment...</html>', headers: { 'CF-Mitigated': 'challenge' } },
    });
    await expect(new ClaudeApi(fetchFn).getOrganizations()).rejects.toMatchObject({ kind: 'blocked' });
  });

  it('reports an HTML page with status 200 as blocked', async () => {
    const { fetchFn } = fakeFetch({ '/api/organizations': { body: '<!doctype html><p>challenge</p>' } });
    await expect(new ClaudeApi(fetchFn).getOrganizations()).rejects.toMatchObject({ kind: 'blocked' });
  });

  it('reports invalid JSON', async () => {
    const { fetchFn } = fakeFetch({ '/api/organizations': { body: '{"broken"' } });
    await expect(new ClaudeApi(fetchFn).getOrganizations()).rejects.toBeInstanceOf(InvalidResponseError);
  });
});
