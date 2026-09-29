import type { AccountStatus, AccountView, ActionResult, AppState, UsageSnapshot } from '../shared/types';
import { createPartitionName, isSameUser, type AccountIdentity, type AccountStore } from './accountStore';
import { ClaudeApiError, type ClaudeApi } from './claudeApi';
import { InvalidResponseError } from './claudeParse';
import { normalizeSessionKey } from './sessionKey';

/** Access to the per-account Chromium sessions (cookie stores). */
export interface SessionProvider {
  api(partition: string): ClaudeApi;
  /** The organization claude.ai last showed in this session (`lastActiveOrg` cookie). */
  lastActiveOrganization(partition: string): Promise<string | null>;
  setSessionKey(partition: string, sessionKey: string): Promise<void>;
  /** Deletes all cookies and cached data of the partition. */
  clear(partition: string): Promise<void>;
}

export type VerifyResult = 'ok' | 'retry' | 'fail';
export type LoginOutcome = 'ok' | 'cancelled' | 'failed';

/**
 * Shows the claude.ai sign-in page in the given partition. `verify` is called
 * whenever a session cookie appears; the window closes once it returns 'ok'
 * (outcome 'ok') or 'fail' (outcome 'failed').
 */
export type LoginRunner = (partition: string, verify: () => Promise<VerifyResult>) => Promise<LoginOutcome>;

export interface UsageServiceOptions {
  store: AccountStore;
  sessions: SessionProvider;
  login: LoginRunner;
  onChange: (state: AppState) => void;
  createPartition?: () => string;
  sleep?: (ms: number) => Promise<void>;
}

interface RuntimeState {
  status: AccountStatus;
  errorMessage: string | null;
  usage: UsageSnapshot | null;
}

const INITIAL_RUNTIME: Readonly<RuntimeState> = Object.freeze({ status: 'loading', errorMessage: null, usage: null });
/** A brand-new session key is sometimes rejected for a few seconds. */
const IDENTITY_ATTEMPTS = 3;
const IDENTITY_RETRY_DELAY_MS = 1_500;

export function describeError(
  error: unknown,
  context: 'refresh' | 'action',
): { status: 'auth_error' | 'error'; message: string } {
  const retry = context === 'refresh' ? ' Retrying automatically.' : ' Please try again later.';
  if (error instanceof ClaudeApiError) {
    switch (error.kind) {
      case 'auth':
        return {
          status: 'auth_error',
          message: context === 'refresh' ? 'The claude.ai session has expired.' : 'claude.ai did not accept this session.',
        };
      case 'blocked':
        return { status: 'error', message: `claude.ai blocked the request (Cloudflare).${retry}` };
      case 'rate_limited':
        return { status: 'error', message: `claude.ai is limiting requests.${retry}` };
      case 'network':
        return { status: 'error', message: `No connection to claude.ai.${retry}` };
      case 'http':
      case 'invalid_response':
        return { status: 'error', message: `${error.message}${retry}` };
    }
  }
  if (error instanceof InvalidResponseError) return { status: 'error', message: error.message };
  return { status: 'error', message: error instanceof Error ? error.message : String(error) };
}

export class UsageService {
  private readonly store: AccountStore;
  private readonly sessions: SessionProvider;
  private readonly login: LoginRunner;
  private readonly onChange: (state: AppState) => void;
  private readonly createPartition: () => string;
  private readonly sleep: (ms: number) => Promise<void>;

  private readonly runtime = new Map<string, RuntimeState>();
  private readonly inflight = new Map<string, Promise<void>>();
  private refreshAllPromise: Promise<void> | null = null;
  private loginActive = false;

  constructor(options: UsageServiceOptions) {
    this.store = options.store;
    this.sessions = options.sessions;
    this.login = options.login;
    this.onChange = options.onChange;
    this.createPartition = options.createPartition ?? (() => createPartitionName());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  getState(): AppState {
    const accounts: AccountView[] = this.store.list().map((account) => {
      const runtime = this.runtime.get(account.id) ?? INITIAL_RUNTIME;
      return {
        id: account.id,
        label: account.customLabel ?? account.email,
        email: account.email,
        customLabel: account.customLabel,
        organizationName: account.organizationName,
        collapsed: account.collapsed,
        status: runtime.status,
        errorMessage: runtime.errorMessage,
        usage: runtime.usage,
      };
    });
    return { accounts, refreshing: this.refreshAllPromise !== null };
  }

  /** All known reset times, used to refresh right after a limit resets. */
  resetTimes(): Array<number | null> {
    return [...this.runtime.values()].flatMap((runtime) =>
      runtime.usage ? [runtime.usage.session?.resetsAt ?? null, runtime.usage.weekly?.resetsAt ?? null] : [],
    );
  }

  refreshAll(): Promise<void> {
    if (this.refreshAllPromise) return this.refreshAllPromise;
    const promise = Promise.all(this.store.list().map((account) => this.refreshAccount(account.id)))
      .then(() => undefined)
      .finally(() => {
        this.refreshAllPromise = null;
        this.emit();
      });
    this.refreshAllPromise = promise;
    this.emit();
    return promise;
  }

  /** Fetches the usage of one account. Never rejects; failures end up in the account state. */
  refreshAccount(id: string): Promise<void> {
    const running = this.inflight.get(id);
    if (running) return running;
    const account = this.store.get(id);
    if (!account) return Promise.resolve();

    const promise = (async () => {
      let next: RuntimeState;
      try {
        const usage = await this.sessions.api(account.partition).getUsage(account.organizationId);
        next = { status: 'ok', errorMessage: null, usage };
      } catch (error) {
        const { status, message } = describeError(error, 'refresh');
        next = { status, errorMessage: message, usage: this.runtime.get(id)?.usage ?? null };
      }
      // Ignore the result if the account was removed or signed in again meanwhile.
      if (this.store.get(id)?.partition === account.partition) this.runtime.set(id, next);
    })().finally(() => {
      this.inflight.delete(id);
      this.emit();
    });
    this.inflight.set(id, promise);
    return promise;
  }

  addViaLogin(): Promise<ActionResult> {
    return this.runLogin(null);
  }

  relogin(id: string): Promise<ActionResult> {
    if (!this.store.get(id)) return Promise.resolve({ status: 'error', error: 'This account no longer exists.' });
    return this.runLogin(id);
  }

  async addWithSessionKey(input: string): Promise<ActionResult> {
    const sessionKey = normalizeSessionKey(input);
    if (!sessionKey) {
      return { status: 'error', error: 'This does not look like a claude.ai session key (it starts with "sk-ant-").' };
    }
    const partition = this.createPartition();
    try {
      await this.sessions.setSessionKey(partition, sessionKey);
      const identity = await this.fetchIdentity(partition, null);
      return await this.saveSession(identity, partition, null);
    } catch (error) {
      await this.sessions.clear(partition).catch(() => undefined);
      return { status: 'error', error: describeError(error, 'action').message };
    }
  }

  rename(id: string, label: string): void {
    this.store.setCustomLabel(id, label);
    this.emit();
  }

  setCollapsed(id: string, collapsed: boolean): void {
    this.store.setCollapsed(id, collapsed);
    this.emit();
  }

  async remove(id: string): Promise<void> {
    const removed = this.store.remove(id);
    if (!removed) return;
    this.runtime.delete(id);
    this.emit();
    await this.sessions.clear(removed.partition).catch(() => undefined);
  }

  private async runLogin(targetId: string | null): Promise<ActionResult> {
    if (this.loginActive) {
      return { status: 'error', error: 'A sign-in window is already open. Finish or close it first.' };
    }
    this.loginActive = true;
    const partition = this.createPartition();
    const attempt: { identity: AccountIdentity | null; error: unknown } = { identity: null, error: null };
    const preferredOrganization = targetId ? (this.store.get(targetId)?.organizationId ?? null) : null;

    const verify = async (): Promise<VerifyResult> => {
      try {
        attempt.identity = await this.fetchIdentity(partition, preferredOrganization);
        return 'ok';
      } catch (error) {
        attempt.error = error;
        return error instanceof InvalidResponseError ? 'fail' : 'retry';
      }
    };

    let outcome: LoginOutcome;
    try {
      outcome = await this.login(partition, verify);
    } catch (error) {
      await this.sessions.clear(partition).catch(() => undefined);
      return { status: 'error', error: describeError(error, 'action').message };
    } finally {
      // The sign-in window is closed at this point, so another sign-in may start.
      this.loginActive = false;
    }

    if (outcome === 'ok' && attempt.identity) {
      return this.saveSession(attempt.identity, partition, targetId);
    }
    await this.sessions.clear(partition).catch(() => undefined);
    if (attempt.error !== null) return { status: 'error', error: describeError(attempt.error, 'action').message };
    return { status: 'cancelled' };
  }

  private async fetchIdentity(partition: string, preferredOrganization: string | null): Promise<AccountIdentity> {
    const api = this.sessions.api(partition);
    const preferred = preferredOrganization ?? (await this.sessions.lastActiveOrganization(partition));
    for (let attempt = 1; ; attempt++) {
      try {
        return await api.getIdentity(preferred);
      } catch (error) {
        if (!(error instanceof ClaudeApiError && error.kind === 'auth') || attempt >= IDENTITY_ATTEMPTS) throw error;
        await this.sleep(IDENTITY_RETRY_DELAY_MS * attempt);
      }
    }
  }

  /** Stores a verified session: re-login of `targetId`, update of a known account, or a new account. */
  private async saveSession(identity: AccountIdentity, partition: string, targetId: string | null): Promise<ActionResult> {
    try {
      const existing = targetId ? this.store.get(targetId) : this.store.findByIdentity(identity);
      if (targetId && !existing) {
        await this.sessions.clear(partition);
        return { status: 'error', error: 'This account no longer exists.' };
      }
      if (targetId && existing && !isSameUser(existing, identity)) {
        await this.sessions.clear(partition);
        return {
          status: 'error',
          error: `You signed in as ${identity.email}, but this entry belongs to ${existing.email}. Use "Add account" to add another account.`,
        };
      }

      let id: string;
      if (existing) {
        await this.inflight.get(existing.id);
        this.store.updateSession(existing.id, identity, partition);
        if (existing.partition !== partition) await this.sessions.clear(existing.partition).catch(() => undefined);
        id = existing.id;
      } else {
        id = this.store.add(identity, partition).id;
      }
      const previous = this.runtime.get(id);
      this.runtime.set(id, { status: 'loading', errorMessage: null, usage: previous?.usage ?? null });
      this.emit();
      await this.refreshAccount(id);
      return { status: 'ok' };
    } catch (error) {
      await this.sessions.clear(partition).catch(() => undefined);
      return { status: 'error', error: describeError(error, 'action').message };
    }
  }

  private emit(): void {
    try {
      this.onChange(this.getState());
    } catch (error) {
      // A listener failure (e.g. a window that is closing) must not break the service.
      console.error('Failed to publish the usage state:', error);
    }
  }
}
