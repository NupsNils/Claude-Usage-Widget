import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppState } from '../shared/types';
import { AccountStore, PARTITION_PREFIX } from './accountStore';
import { CLAUDE_BASE_URL, ClaudeApi, ClaudeApiError, type ResponseLike } from './claudeApi';
import { InvalidResponseError } from './claudeParse';
import { UsageService, describeError, type LoginRunner, type SessionProvider } from './usageService';

type Reply = { status?: number; body: unknown } | Error;
type Routes = Record<string, Reply>;

const sessionKey = ['sk', 'ant', 'sid02', 'Q'.repeat(40)].join('-');
const RESET_AT = '2026-10-01T09:00:00Z';

function identityRoutes(email: string, uuid: string, usage = 25): Routes {
  return {
    '/api/account': { body: { uuid, email_address: email } },
    '/api/organizations': { body: [{ uuid: `org-${uuid}`, name: `${email} org`, capabilities: ['chat'] }] },
    [`/api/organizations/org-${uuid}/usage`]: {
      body: { five_hour: { utilization: usage, resets_at: RESET_AT }, seven_day: { utilization: 5, resets_at: null } },
    },
  };
}

/** Fake claude.ai: every partition answers with its own routes. */
class FakeSessions implements SessionProvider {
  readonly routes = new Map<string, Routes>();
  readonly keys = new Map<string, string>();
  readonly cleared: string[] = [];
  readonly requests: string[] = [];
  /** Usage requests of a partition wait for its gate, to create overlapping operations on purpose. */
  readonly usageGates = new Map<string, Promise<void>>();
  /** Routes a partition gets as soon as a session key is set or a login happens. */
  nextRoutes: Routes = {};

  api(partition: string): ClaudeApi {
    return new ClaudeApi(async (url) => {
      const path = url.slice(CLAUDE_BASE_URL.length);
      if (path.endsWith('/usage')) await this.usageGates.get(partition);
      const route = this.routes.get(partition)?.[path];
      this.requests.push(`${partition} ${path}`);
      if (route instanceof Error) throw route;
      const reply = route ?? { status: 404, body: {} };
      const response: ResponseLike = {
        status: reply.status ?? 200,
        headers: { get: () => null },
        text: async () => JSON.stringify(reply.body),
      };
      return response;
    }, () => 1_000);
  }

  async lastActiveOrganization(): Promise<string | null> {
    return null;
  }

  async setSessionKey(partition: string, key: string): Promise<void> {
    this.keys.set(partition, key);
    this.routes.set(partition, this.nextRoutes);
  }

  async clear(partition: string): Promise<void> {
    this.cleared.push(partition);
    this.routes.delete(partition);
  }
}

let dir: string;
let store: AccountStore;
let sessions: FakeSessions;
let states: AppState[];
let sleeps: number[];
let partitionCounter: number;
let loginBehaviour: 'sign-in' | 'cancel';

const login: LoginRunner = async (partition, verify) => {
  if (loginBehaviour === 'cancel') return 'cancelled';
  sessions.routes.set(partition, sessions.nextRoutes);
  const result = await verify();
  return result === 'ok' ? 'ok' : result === 'fail' ? 'failed' : 'cancelled';
};

function createService(): UsageService {
  return new UsageService({
    store,
    sessions,
    login,
    onChange: (state) => states.push(state),
    createPartition: () => `${PARTITION_PREFIX}${++partitionCounter}`,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuw-service-'));
  let idCounter = 0;
  store = new AccountStore(path.join(dir, 'accounts.json'), () => `id-${++idCounter}`, () => 42);
  store.load();
  sessions = new FakeSessions();
  states = [];
  sleeps = [];
  partitionCounter = 0;
  loginBehaviour = 'sign-in';
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('UsageService.addWithSessionKey', () => {
  it('rejects input that is not a session key without touching any session', async () => {
    const result = await createService().addWithSessionKey('hello');
    expect(result).toEqual({ status: 'error', error: expect.stringContaining('sk-ant-') });
    expect(sessions.keys.size).toBe(0);
    expect(store.list()).toEqual([]);
  });

  it('adds the account, loads its usage and publishes the state', async () => {
    sessions.nextRoutes = identityRoutes('alice@example.com', 'a', 34);
    const service = createService();
    await expect(service.addWithSessionKey(`sessionKey=${sessionKey};`)).resolves.toEqual({ status: 'ok' });

    expect(sessions.keys.get(`${PARTITION_PREFIX}1`)).toBe(sessionKey);
    expect(store.list()).toMatchObject([
      { id: 'id-1', email: 'alice@example.com', organizationId: 'org-a', partition: `${PARTITION_PREFIX}1` },
    ]);
    const account = service.getState().accounts[0];
    expect(account).toMatchObject({ label: 'alice@example.com', status: 'ok', errorMessage: null });
    expect(account?.usage).toEqual({
      session: { utilization: 34, resetsAt: Date.parse(RESET_AT) },
      weekly: { utilization: 5, resetsAt: null },
      fetchedAt: 1_000,
    });
    expect(states.at(-1)).toEqual(service.getState());
  });

  it('retries a rejected new key and gives up after three attempts', async () => {
    sessions.nextRoutes = { '/api/account': { status: 401, body: {} }, '/api/organizations': { status: 401, body: {} } };
    const result = await createService().addWithSessionKey(sessionKey);
    expect(result).toEqual({ status: 'error', error: 'claude.ai did not accept this session.' });
    expect(sleeps).toEqual([1_500, 3_000]);
    expect(sessions.cleared).toEqual([`${PARTITION_PREFIX}1`]);
    expect(store.list()).toEqual([]);
  });

  it('updates an account that already exists instead of adding a duplicate', async () => {
    sessions.nextRoutes = identityRoutes('alice@example.com', 'a');
    const service = createService();
    await service.addWithSessionKey(sessionKey);
    await service.addWithSessionKey(sessionKey);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.partition).toBe(`${PARTITION_PREFIX}2`);
    expect(sessions.cleared).toEqual([`${PARTITION_PREFIX}1`]);
  });
});

describe('UsageService login', () => {
  it('adds an account after signing in', async () => {
    sessions.nextRoutes = identityRoutes('bob@example.com', 'b');
    const service = createService();
    await expect(service.addViaLogin()).resolves.toEqual({ status: 'ok' });
    expect(service.getState().accounts.map((account) => account.email)).toEqual(['bob@example.com']);
  });

  it('cleans up when the sign-in window is closed', async () => {
    loginBehaviour = 'cancel';
    await expect(createService().addViaLogin()).resolves.toEqual({ status: 'cancelled' });
    expect(sessions.cleared).toEqual([`${PARTITION_PREFIX}1`]);
    expect(store.list()).toEqual([]);
  });

  it('reports accounts without a chat organization', async () => {
    sessions.nextRoutes = {
      '/api/account': { body: { email_address: 'dev@example.com' } },
      '/api/organizations': { body: [{ uuid: 'console', capabilities: ['api'] }] },
    };
    const result = await createService().addViaLogin();
    expect(result).toEqual({ status: 'error', error: 'This account has no Claude.ai chat organization.' });
    expect(sessions.cleared).toEqual([`${PARTITION_PREFIX}1`]);
  });

  it('allows only one sign-in window at a time', async () => {
    let release: () => void = () => undefined;
    const service = new UsageService({
      store,
      sessions,
      login: () => new Promise((resolve) => (release = () => resolve('cancelled'))),
      onChange: () => undefined,
      createPartition: () => `${PARTITION_PREFIX}${++partitionCounter}`,
    });
    const first = service.addViaLogin();
    await expect(service.addViaLogin()).resolves.toMatchObject({ status: 'error' });
    release();
    await expect(first).resolves.toEqual({ status: 'cancelled' });
  });

  it('signs an existing account in again and drops the old session', async () => {
    sessions.nextRoutes = identityRoutes('alice@example.com', 'a');
    const service = createService();
    await service.addWithSessionKey(sessionKey);
    await expect(service.relogin('id-1')).resolves.toEqual({ status: 'ok' });
    expect(store.get('id-1')?.partition).toBe(`${PARTITION_PREFIX}2`);
    expect(sessions.cleared).toEqual([`${PARTITION_PREFIX}1`]);
  });

  it('refuses a re-login with a different user', async () => {
    sessions.nextRoutes = identityRoutes('alice@example.com', 'a');
    const service = createService();
    await service.addWithSessionKey(sessionKey);
    sessions.nextRoutes = identityRoutes('mallory@example.com', 'm');
    const result = await service.relogin('id-1');
    expect(result).toEqual({ status: 'error', error: expect.stringContaining('You signed in as mallory@example.com') });
    expect(store.get('id-1')).toMatchObject({ email: 'alice@example.com', partition: `${PARTITION_PREFIX}1` });
    expect(sessions.cleared).toEqual([`${PARTITION_PREFIX}2`]);
  });

  it('reports a re-login for an unknown account', async () => {
    await expect(createService().relogin('missing')).resolves.toMatchObject({ status: 'error' });
  });
});

describe('UsageService refresh', () => {
  async function serviceWithAccount(): Promise<UsageService> {
    sessions.nextRoutes = identityRoutes('alice@example.com', 'a', 60);
    const service = createService();
    await service.addWithSessionKey(sessionKey);
    return service;
  }

  it('marks an expired session and keeps the last known usage', async () => {
    const service = await serviceWithAccount();
    sessions.routes.get(`${PARTITION_PREFIX}1`)!['/api/organizations/org-a/usage'] = { status: 403, body: { type: 'error' } };
    await service.refreshAll();
    const account = service.getState().accounts[0];
    expect(account?.status).toBe('auth_error');
    expect(account?.errorMessage).toBe('The claude.ai session has expired.');
    expect(account?.usage?.session?.utilization).toBe(60);
  });

  it('reports network errors and recovers on the next refresh', async () => {
    const service = await serviceWithAccount();
    const routes = sessions.routes.get(`${PARTITION_PREFIX}1`)!;
    const usageRoute = routes['/api/organizations/org-a/usage']!;
    routes['/api/organizations/org-a/usage'] = new Error('offline');
    await service.refreshAll();
    expect(service.getState().accounts[0]).toMatchObject({
      status: 'error',
      errorMessage: 'No connection to claude.ai. Retrying automatically.',
    });
    routes['/api/organizations/org-a/usage'] = usageRoute;
    await service.refreshAll();
    expect(service.getState().accounts[0]).toMatchObject({ status: 'ok', errorMessage: null });
  });

  it('runs only one refresh at a time and reports it in the state', async () => {
    const service = await serviceWithAccount();
    const first = service.refreshAll();
    const second = service.refreshAll();
    expect(second).toBe(first);
    expect(service.getState().refreshing).toBe(true);
    await first;
    expect(service.getState().refreshing).toBe(false);
    expect(sessions.requests.filter((request) => request.endsWith('/usage'))).toHaveLength(2);
  });

  it('shows new accounts as loading until the first refresh', () => {
    store.add({ accountUuid: null, email: 'x@example.com', organizationId: 'o', organizationName: null }, `${PARTITION_PREFIX}x`);
    expect(createService().getState().accounts[0]).toMatchObject({ status: 'loading', usage: null });
  });

  it('lists the known reset times', async () => {
    const service = await serviceWithAccount();
    expect(service.resetTimes()).toEqual([Date.parse(RESET_AT), null]);
  });
});

function gate(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('UsageService overlapping operations', () => {
  it('drops the result of a refresh for an account that was removed meanwhile', async () => {
    sessions.nextRoutes = identityRoutes('alice@example.com', 'a');
    const service = createService();
    await service.addWithSessionKey(sessionKey);
    const hold = gate();
    sessions.usageGates.set(`${PARTITION_PREFIX}1`, hold.promise);

    const refresh = service.refreshAll();
    await service.remove('id-1');
    hold.open();
    await refresh;

    expect(service.getState().accounts).toEqual([]);
    expect(service.resetTimes()).toEqual([]);
  });

  it('waits for a running refresh before switching an account to its new session', async () => {
    sessions.nextRoutes = identityRoutes('alice@example.com', 'a', 60);
    const service = createService();
    await service.addWithSessionKey(sessionKey);

    // The old session has expired, but its refresh is still on the way.
    const oldRoutes = { ...identityRoutes('alice@example.com', 'a', 60) };
    oldRoutes['/api/organizations/org-a/usage'] = { status: 403, body: { type: 'error' } };
    sessions.routes.set(`${PARTITION_PREFIX}1`, oldRoutes);
    const hold = gate();
    sessions.usageGates.set(`${PARTITION_PREFIX}1`, hold.promise);
    const refresh = service.refreshAll();

    sessions.nextRoutes = identityRoutes('alice@example.com', 'a', 10);
    const relogin = service.relogin('id-1');
    await tick();
    hold.open();
    await expect(relogin).resolves.toEqual({ status: 'ok' });
    await refresh;

    expect(store.get('id-1')?.partition).toBe(`${PARTITION_PREFIX}2`);
    expect(service.getState().accounts[0]).toMatchObject({ status: 'ok', errorMessage: null });
    expect(service.getState().accounts[0]?.usage?.session?.utilization).toBe(10);
  });

  it('allows a new sign-in as soon as the sign-in window is closed', async () => {
    sessions.nextRoutes = identityRoutes('alice@example.com', 'a');
    const service = createService();
    const hold = gate();
    sessions.usageGates.set(`${PARTITION_PREFIX}1`, hold.promise);

    const first = service.addViaLogin();
    await tick();
    // The first sign-in is still loading the usage, but its window is already closed.
    loginBehaviour = 'cancel';
    await expect(service.addViaLogin()).resolves.toEqual({ status: 'cancelled' });
    hold.open();
    await expect(first).resolves.toEqual({ status: 'ok' });
  });
});

describe('UsageService rename and remove', () => {
  it('renames an account and falls back to the email for an empty label', async () => {
    sessions.nextRoutes = identityRoutes('alice@example.com', 'a');
    const service = createService();
    await service.addWithSessionKey(sessionKey);
    service.rename('id-1', 'Work');
    expect(states.at(-1)?.accounts[0]?.label).toBe('Work');
    service.rename('id-1', '');
    expect(states.at(-1)?.accounts[0]?.label).toBe('alice@example.com');
  });

  it('collapses and expands an account', async () => {
    sessions.nextRoutes = identityRoutes('alice@example.com', 'a');
    const service = createService();
    await service.addWithSessionKey(sessionKey);
    expect(service.getState().accounts[0]?.collapsed).toBe(false);
    service.setCollapsed('id-1', true);
    expect(states.at(-1)?.accounts[0]?.collapsed).toBe(true);
    service.setCollapsed('id-1', false);
    expect(states.at(-1)?.accounts[0]?.collapsed).toBe(false);
  });

  it('removes an account together with its session', async () => {
    sessions.nextRoutes = identityRoutes('alice@example.com', 'a');
    const service = createService();
    await service.addWithSessionKey(sessionKey);
    await service.remove('id-1');
    expect(service.getState().accounts).toEqual([]);
    expect(sessions.cleared).toEqual([`${PARTITION_PREFIX}1`]);
    await service.remove('id-1');
    expect(sessions.cleared).toHaveLength(1);
  });
});

describe('describeError', () => {
  it('maps API errors to account states and messages', () => {
    expect(describeError(new ClaudeApiError('auth', 'x', 401), 'refresh')).toEqual({
      status: 'auth_error',
      message: 'The claude.ai session has expired.',
    });
    expect(describeError(new ClaudeApiError('blocked', 'x', 403), 'action')).toEqual({
      status: 'error',
      message: 'claude.ai blocked the request (Cloudflare). Please try again later.',
    });
    expect(describeError(new ClaudeApiError('http', 'claude.ai returned HTTP 502.', 502), 'refresh').message).toBe(
      'claude.ai returned HTTP 502. Retrying automatically.',
    );
    expect(describeError(new InvalidResponseError('Broken.'), 'refresh')).toEqual({ status: 'error', message: 'Broken.' });
    expect(describeError('odd', 'action')).toEqual({ status: 'error', message: 'odd' });
  });
});
