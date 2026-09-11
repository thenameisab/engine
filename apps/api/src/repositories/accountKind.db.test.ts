import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.js';
import {
  upsertUser,
  createAccount,
  getAccount,
  getAccountRole,
  setAccountKind,
  countAccountsForUser,
} from './accounts.js';

/**
 * What `accounts.kind` does once it is writable. The route's guard is assembled
 * from these three reads, so they are tested against real SQL rather than the
 * route being tested against a mock that would agree with whatever it returned.
 *
 * Runs only when `TEST_DATABASE_URL` points at a database migrated through
 * 0035, which is the migration that adds the column.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('account kind (Postgres)', () => {
  let db: Db;
  const suffix = Math.random().toString(36).slice(2, 8);
  const ownerId = `local:owner+${suffix}@example.com`;
  const memberId = `local:member+${suffix}@example.com`;
  let accountId: string;

  beforeAll(async () => {
    db = createDb(url!);
    await upsertUser(db, { id: ownerId, email: `owner+${suffix}@example.com` });
    await upsertUser(db, { id: memberId, email: `member+${suffix}@example.com` });
    const account = await createAccount(db, `kind-${suffix}`, ownerId);
    accountId = account.id;
    await db`
      insert into account_members (account_id, user_id, role)
      values (${accountId}, ${memberId}, 'member')
    `;
  });

  afterAll(async () => {
    await db`delete from accounts where name like ${'kind-' + suffix + '%'}`;
    await db`delete from users where id like ${'local:%' + suffix + '%'}`;
    await db.end();
  });

  it('defaults a new account to company', async () => {
    expect((await getAccount(db, accountId))!.kind).toBe('company');
  });

  it('distinguishes the owner from a member, which is what the guard turns on', async () => {
    expect(await getAccountRole(db, accountId, ownerId)).toBe('owner');
    expect(await getAccountRole(db, accountId, memberId)).toBe('member');
    expect(await getAccountRole(db, accountId, 'local:stranger@example.com')).toBeNull();
  });

  it('writes the kind and returns the stored row, not the requested value', async () => {
    const updated = await setAccountKind(db, accountId, 'agency');
    expect(updated!.kind).toBe('agency');
    expect((await getAccount(db, accountId))!.kind).toBe('agency');
  });

  it('rejects a kind the check constraint does not allow', async () => {
    // The validator refuses this at the boundary; 0035's constraint is the
    // backstop, and a silent write here would mean the column trusts the route.
    await expect(setAccountKind(db, accountId, 'reseller' as 'agency')).rejects.toThrow();
  });

  it('returns null for an account that does not exist, rather than inventing one', async () => {
    expect(await setAccountKind(db, '11111111-1111-4111-8111-111111111111', 'company')).toBeNull();
  });

  it('counts memberships, which is how the downgrade guard reads "still has clients"', async () => {
    expect(await countAccountsForUser(db, ownerId)).toBe(1);
    const second = await createAccount(db, `kind-${suffix}-two`, ownerId);
    expect(await countAccountsForUser(db, ownerId)).toBe(2);
    // Membership, not ownership: a member of one account counts one.
    expect(await countAccountsForUser(db, memberId)).toBe(1);
    await db`delete from accounts where id = ${second.id}`;
  });

  it('counts zero for a user who belongs to nothing', async () => {
    expect(await countAccountsForUser(db, 'local:nobody@example.com')).toBe(0);
  });
});
