import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AccountStore,
  PARTITION_PREFIX,
  createPartitionName,
  isAccountPartition,
  isSameIdentity,
  normalizeLabel,
  type AccountIdentity,
} from './accountStore';

const alice: AccountIdentity = {
  accountUuid: 'acc-alice',
  email: 'alice@example.com',
  organizationId: 'org-1',
  organizationName: 'Alice personal',
};

const bob: AccountIdentity = {
  accountUuid: 'acc-bob',
  email: 'bob@example.com',
  organizationId: 'org-2',
  organizationName: null,
};

const partitionA = `${PARTITION_PREFIX}a`;
const partitionB = `${PARTITION_PREFIX}b`;

let dir: string;
let filePath: string;
let nextId: number;

function createStore(): AccountStore {
  return new AccountStore(filePath, () => `id-${++nextId}`, () => 1_700_000_000_000);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuw-accounts-'));
  filePath = path.join(dir, 'nested', 'accounts.json');
  nextId = 0;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('AccountStore', () => {
  it('starts empty when no file exists', () => {
    const store = createStore();
    expect(store.load()).toBe('missing');
    expect(store.list()).toEqual([]);
  });

  it('reports a file with an unexpected structure as corrupt', () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ version: 2, accounts: 'none' }));
    const store = createStore();
    expect(store.load()).toBe('corrupt');
    expect(store.list()).toEqual([]);
  });

  it('adds accounts and persists them', () => {
    const store = createStore();
    store.load();
    const added = store.add(alice, partitionA);
    expect(added).toEqual({
      id: 'id-1',
      partition: partitionA,
      accountUuid: 'acc-alice',
      email: 'alice@example.com',
      organizationId: 'org-1',
      organizationName: 'Alice personal',
      customLabel: null,
      addedAt: 1_700_000_000_000,
    });
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8')).version).toBe(2);

    const reloaded = createStore();
    expect(reloaded.load()).toBe('ok');
    expect(reloaded.list()).toEqual([added]);
    expect(fs.existsSync(`${filePath}.tmp`)).toBe(false);
  });

  it('rejects partitions that do not belong to an account', () => {
    const store = createStore();
    store.load();
    expect(() => store.add(alice, 'persist:other')).toThrow(/Invalid partition/);
    expect(() => store.add(alice, PARTITION_PREFIX)).toThrow(/Invalid partition/);
  });

  it('moves an account to a new session and refreshes its details', () => {
    const store = createStore();
    store.load();
    store.add(alice, partitionA);
    const updated = store.updateSession('id-1', { ...alice, email: 'alice@new.example', organizationName: 'Renamed' }, partitionB);
    expect(updated).toMatchObject({ partition: partitionB, email: 'alice@new.example', organizationName: 'Renamed' });
  });

  it('updates identity details without touching the partition', () => {
    const store = createStore();
    store.load();
    store.add(alice, partitionA);
    const updated = store.updateIdentity('id-1', { ...alice, accountUuid: null, organizationName: 'Team' });
    expect(updated).toMatchObject({ partition: partitionA, accountUuid: 'acc-alice', organizationName: 'Team' });
  });

  it('sets and clears custom labels', () => {
    const store = createStore();
    store.load();
    store.add(alice, partitionA);
    expect(store.setCustomLabel('id-1', '  Work   account ').customLabel).toBe('Work account');
    expect(store.setCustomLabel('id-1', '   ').customLabel).toBeNull();
  });

  it('removes accounts and returns the removed entry', () => {
    const store = createStore();
    store.load();
    store.add(alice, partitionA);
    store.add(bob, partitionB);
    expect(store.remove('id-1')?.partition).toBe(partitionA);
    expect(store.remove('id-1')).toBeUndefined();
    expect(store.list().map((account) => account.email)).toEqual(['bob@example.com']);
  });

  it('finds accounts by identity', () => {
    const store = createStore();
    store.load();
    store.add(alice, partitionA);
    expect(store.findByIdentity({ ...alice, organizationName: 'other' })?.id).toBe('id-1');
    expect(store.findByIdentity(bob)).toBeUndefined();
  });

  it('throws for unknown ids', () => {
    const store = createStore();
    store.load();
    expect(() => store.setCustomLabel('missing', 'x')).toThrow(/Unknown account/);
    expect(() => store.updateSession('missing', alice, partitionA)).toThrow(/Unknown account/);
  });

  it('returns copies so callers cannot change the stored state', () => {
    const store = createStore();
    store.load();
    store.add(alice, partitionA);
    store.list()[0]!.email = 'changed@example.com';
    store.get('id-1')!.email = 'changed@example.com';
    expect(store.get('id-1')?.email).toBe('alice@example.com');
  });

  it('skips invalid and duplicate entries when loading', () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const valid = { id: 'a', partition: partitionA, email: 'a@example.com', organizationId: 'org', addedAt: 5 };
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 2,
        accounts: [
          valid,
          { ...valid, email: 'duplicate-id@example.com' },
          { ...valid, id: 'c', email: 'duplicate-partition@example.com' },
          { ...valid, id: 'd', partition: 'persist:foreign' },
          { id: 'b' },
          null,
          'x',
        ],
      }),
    );
    const store = createStore();
    store.load();
    expect(store.list()).toEqual([
      {
        id: 'a',
        partition: partitionA,
        accountUuid: null,
        email: 'a@example.com',
        organizationId: 'org',
        organizationName: null,
        customLabel: null,
        addedAt: 5,
      },
    ]);
  });

  it('moves a corrupt file aside instead of overwriting it', () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{ not json');
    const store = createStore();
    expect(store.load()).toBe('corrupt');
    expect(store.list()).toEqual([]);
    expect(fs.readFileSync(`${filePath}.corrupt`, 'utf8')).toBe('{ not json');
  });

  it('keeps the previous state when writing fails', () => {
    const store = createStore();
    store.load();
    store.add(alice, partitionA);
    // Replace the target file with a directory so the next write fails.
    fs.rmSync(filePath);
    fs.mkdirSync(filePath);
    expect(() => store.add(bob, partitionB)).toThrow();
    expect(store.list().map((account) => account.email)).toEqual(['alice@example.com']);
  });
});

describe('partition names', () => {
  it('creates prefixed partition names', () => {
    expect(createPartitionName(() => 'xyz')).toBe(`${PARTITION_PREFIX}xyz`);
    expect(isAccountPartition(createPartitionName())).toBe(true);
  });

  it('recognizes only account partitions', () => {
    expect(isAccountPartition(partitionA)).toBe(true);
    expect(isAccountPartition(PARTITION_PREFIX)).toBe(false);
    expect(isAccountPartition('persist:other')).toBe(false);
    expect(isAccountPartition('acct-a')).toBe(false);
  });
});

describe('normalizeLabel', () => {
  it('collapses whitespace, trims and limits the length', () => {
    expect(normalizeLabel(null)).toBeNull();
    expect(normalizeLabel('')).toBeNull();
    expect(normalizeLabel(' a \n b ')).toBe('a b');
    expect(normalizeLabel('x'.repeat(100))).toHaveLength(60);
  });
});

describe('isSameIdentity', () => {
  it('compares account uuids when both are known', () => {
    expect(isSameIdentity(alice, { ...alice, email: 'renamed@example.com' })).toBe(true);
    expect(isSameIdentity(alice, { ...alice, accountUuid: 'acc-other' })).toBe(false);
  });

  it('falls back to a case-insensitive email comparison', () => {
    expect(isSameIdentity({ ...alice, accountUuid: null }, { ...alice, email: 'ALICE@example.com' })).toBe(true);
  });

  it('treats different organizations as different accounts', () => {
    expect(isSameIdentity(alice, { ...alice, organizationId: 'org-9' })).toBe(false);
  });
});
