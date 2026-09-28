import { randomUUID } from 'node:crypto';
import { readJsonFile, writeJsonFileAtomic } from './jsonFile';

/** Prefix of the persistent Chromium partitions that hold each account's claude.ai cookies. */
export const PARTITION_PREFIX = 'persist:acct-';

export interface AccountIdentity {
  /** Stable claude.ai account id, when the API reported one. */
  accountUuid: string | null;
  email: string;
  organizationId: string;
  organizationName: string | null;
}

/**
 * An account as stored on disk. It contains no secrets: the claude.ai session
 * cookie lives in the account's own Chromium partition (cookie store).
 */
export interface StoredAccount extends AccountIdentity {
  id: string;
  partition: string;
  customLabel: string | null;
  addedAt: number;
}

interface AccountsFile {
  version: 2;
  accounts: StoredAccount[];
}

const MAX_LABEL_LENGTH = 60;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function createPartitionName(createId: () => string = randomUUID): string {
  return `${PARTITION_PREFIX}${createId()}`;
}

export function isAccountPartition(partition: string): boolean {
  return partition.startsWith(PARTITION_PREFIX) && partition.length > PARTITION_PREFIX.length;
}

function parseStoredAccount(value: unknown): StoredAccount | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (
    !isNonEmptyString(raw.id) ||
    !isNonEmptyString(raw.partition) ||
    !isAccountPartition(raw.partition) ||
    !isNonEmptyString(raw.email) ||
    !isNonEmptyString(raw.organizationId)
  ) {
    return null;
  }
  return {
    id: raw.id,
    partition: raw.partition,
    accountUuid: isNonEmptyString(raw.accountUuid) ? raw.accountUuid : null,
    email: raw.email,
    organizationId: raw.organizationId,
    organizationName: isNonEmptyString(raw.organizationName) ? raw.organizationName : null,
    customLabel: isNonEmptyString(raw.customLabel) ? raw.customLabel : null,
    addedAt: typeof raw.addedAt === 'number' && Number.isFinite(raw.addedAt) ? raw.addedAt : 0,
  };
}

/** Trims a user-entered label; an empty label means "use the email address". */
export function normalizeLabel(label: string | null): string | null {
  if (label === null) return null;
  const trimmed = label.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL_LENGTH);
  return trimmed === '' ? null : trimmed;
}

/** Two identities belong to the same claude.ai user (the organization may differ). */
export function isSameUser(a: AccountIdentity, b: AccountIdentity): boolean {
  return a.accountUuid !== null && b.accountUuid !== null
    ? a.accountUuid === b.accountUuid
    : a.email.toLowerCase() === b.email.toLowerCase();
}

/** Two identities belong to the same claude.ai user and organization. */
export function isSameIdentity(a: AccountIdentity, b: AccountIdentity): boolean {
  return isSameUser(a, b) && a.organizationId === b.organizationId;
}

/**
 * Persists the account list. Every change is written to disk before it becomes
 * visible in memory, so a failed write leaves both in the previous state.
 */
export class AccountStore {
  private accounts: readonly StoredAccount[] = [];

  constructor(
    private readonly filePath: string,
    private readonly createId: () => string = randomUUID,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Loads the accounts from disk. Returns 'corrupt' when the file existed but
   * could not be read, so callers can avoid deleting data that belongs to it.
   */
  load(): 'ok' | 'missing' | 'corrupt' {
    const result = readJsonFile(this.filePath);
    if (result.status !== 'ok') {
      this.accounts = [];
      return result.status;
    }
    const data = result.value;
    if (typeof data !== 'object' || data === null || !Array.isArray((data as Partial<AccountsFile>).accounts)) {
      this.accounts = [];
      return 'corrupt';
    }
    const list = (data as AccountsFile).accounts as unknown[];
    const seenIds = new Set<string>();
    const seenPartitions = new Set<string>();
    const accounts: StoredAccount[] = [];
    for (const entry of list) {
      const account = parseStoredAccount(entry);
      if (account && !seenIds.has(account.id) && !seenPartitions.has(account.partition)) {
        seenIds.add(account.id);
        seenPartitions.add(account.partition);
        accounts.push(account);
      }
    }
    this.accounts = accounts;
    return 'ok';
  }

  list(): StoredAccount[] {
    return this.accounts.map((account) => ({ ...account }));
  }

  get(id: string): StoredAccount | undefined {
    const account = this.accounts.find((entry) => entry.id === id);
    return account ? { ...account } : undefined;
  }

  findByIdentity(identity: AccountIdentity): StoredAccount | undefined {
    const account = this.accounts.find((entry) => isSameIdentity(entry, identity));
    return account ? { ...account } : undefined;
  }

  add(identity: AccountIdentity, partition: string): StoredAccount {
    if (!isAccountPartition(partition)) throw new Error(`Invalid partition: ${partition}`);
    const account: StoredAccount = {
      id: this.createId(),
      partition,
      accountUuid: identity.accountUuid,
      email: identity.email,
      organizationId: identity.organizationId,
      organizationName: identity.organizationName,
      customLabel: null,
      addedAt: this.now(),
    };
    this.commit([...this.accounts, account]);
    return { ...account };
  }

  /** Points an existing account at a new partition (after signing in again) and refreshes its details. */
  updateSession(id: string, identity: AccountIdentity, partition: string): StoredAccount {
    if (!isAccountPartition(partition)) throw new Error(`Invalid partition: ${partition}`);
    const current = this.require(id);
    return this.replace({
      ...current,
      partition,
      accountUuid: identity.accountUuid ?? current.accountUuid,
      email: identity.email,
      organizationId: identity.organizationId,
      organizationName: identity.organizationName,
    });
  }

  /** Updates details reported by the API (e.g. a renamed organization) without touching the session. */
  updateIdentity(id: string, identity: AccountIdentity): StoredAccount {
    const current = this.require(id);
    return this.replace({
      ...current,
      accountUuid: identity.accountUuid ?? current.accountUuid,
      email: identity.email,
      organizationId: identity.organizationId,
      organizationName: identity.organizationName,
    });
  }

  setCustomLabel(id: string, label: string | null): StoredAccount {
    return this.replace({ ...this.require(id), customLabel: normalizeLabel(label) });
  }

  remove(id: string): StoredAccount | undefined {
    const removed = this.accounts.find((entry) => entry.id === id);
    if (!removed) return undefined;
    this.commit(this.accounts.filter((entry) => entry.id !== id));
    return { ...removed };
  }

  private require(id: string): StoredAccount {
    const account = this.accounts.find((entry) => entry.id === id);
    if (!account) throw new Error(`Unknown account: ${id}`);
    return account;
  }

  private replace(updated: StoredAccount): StoredAccount {
    this.commit(this.accounts.map((entry) => (entry.id === updated.id ? updated : entry)));
    return { ...updated };
  }

  private commit(next: readonly StoredAccount[]): void {
    const file: AccountsFile = { version: 2, accounts: [...next] };
    writeJsonFileAtomic(this.filePath, file);
    this.accounts = next;
  }
}
