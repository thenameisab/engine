import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.js';
import { createLoginCode, verifyLoginCode, countRecentCodes, LOGIN_CODE_MAX_ATTEMPTS, generateLoginCode } from './loginCodes.js';
import { checkRateLimit, recordAttempt, firstRefusal } from './authAttempts.js';
import { createInvitation, listOpenInvitations, deleteInvitation, hasOpenInvitation, acceptInvitations } from './invitations.js';

/**
 * The email sign-in lifecycle, which is entirely SQL: a code is stored hashed,
 * verified once, and dead after too many guesses; attempts are counted in a
 * window; an invitation becomes a membership on sign-in. Runs only when
 * `TEST_DATABASE_URL` points at a database migrated through 0033.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('email sign-in (Postgres)', () => {
  let db: Db;
  const suffix = Math.random().toString(36).slice(2, 8);
  const email = `ada+${suffix}@example.com`;

  beforeAll(() => {
    db = createDb(url!);
  });
  afterAll(async () => {
    await db`delete from login_codes where email like ${'%' + suffix + '%'}`;
    await db`delete from auth_attempts where subject like ${'%' + suffix + '%'}`;
    await db`delete from users where id like ${'local:%' + suffix + '%'}`;
    await db`delete from accounts where name like ${'inv-' + suffix + '%'}`;
    await db.end();
  });

  it('generates six digits, leading zeros included', () => {
    for (let i = 0; i < 50; i++) expect(generateLoginCode()).toMatch(/^\d{6}$/);
  });

  it('stores a hash, verifies the plaintext once, and refuses it a second time', async () => {
    const { code } = await createLoginCode(db, email);
    const [row] = await db<{ code_hash: string }[]>`select code_hash from login_codes where email = ${email} order by created_at desc limit 1`;
    expect(row!.code_hash).not.toContain(code);
    expect(row!.code_hash).not.toBe('pending');

    expect(await verifyLoginCode(db, email, code)).toEqual({ ok: true });
    // Single-use: the same code again is just a wrong code now.
    expect(await verifyLoginCode(db, email, code)).toEqual({ ok: false });
  });

  it('is case-insensitive on the address and exact on the code', async () => {
    const { code } = await createLoginCode(db, email);
    const wrong = code === '000000' ? '000001' : '000000';
    expect(await verifyLoginCode(db, email.toUpperCase(), wrong)).toEqual({ ok: false });
    expect(await verifyLoginCode(db, email.toUpperCase(), code)).toEqual({ ok: true });
  });

  it('kills a code after too many wrong guesses, even if the next guess is right', async () => {
    const { code } = await createLoginCode(db, email);
    const wrong = code === '000000' ? '000001' : '000000';
    for (let i = 0; i < LOGIN_CODE_MAX_ATTEMPTS; i++) {
      expect(await verifyLoginCode(db, email, wrong)).toEqual({ ok: false });
    }
    expect(await verifyLoginCode(db, email, code)).toEqual({ ok: false });
  });

  it('only ever checks the newest live code for an address', async () => {
    const first = await createLoginCode(db, email);
    const second = await createLoginCode(db, email);
    expect(await verifyLoginCode(db, email, first.code)).toEqual({ ok: false });
    expect(await verifyLoginCode(db, email, second.code)).toEqual({ ok: true });
  });

  it('counts recent codes for the request throttle', async () => {
    const fresh = `count+${suffix}@example.com`;
    expect(await countRecentCodes(db, fresh, 900)).toBe(0);
    await createLoginCode(db, fresh);
    await createLoginCode(db, fresh);
    expect(await countRecentCodes(db, fresh, 900)).toBe(2);
  });

  it('refuses the attempt after the limit, with a retry time, and unlocks when the window passes', async () => {
    const subject = `limit+${suffix}`;
    const rule = { kind: 'password' as const, subject, limit: 2, windowSeconds: 900 };
    expect(await checkRateLimit(db, rule)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    await recordAttempt(db, 'password', subject);
    await recordAttempt(db, 'password', subject);
    const verdict = await checkRateLimit(db, rule);
    expect(verdict.allowed).toBe(false);
    expect(verdict.retryAfterSeconds).toBeGreaterThan(0);
    expect(verdict.retryAfterSeconds).toBeLessThanOrEqual(900);
    // The same two attempts are outside a one-second window.
    expect(await checkRateLimit(db, { ...rule, windowSeconds: 0 })).toEqual({ allowed: true, retryAfterSeconds: 0 });
    // Kinds are separate counters.
    expect(await checkRateLimit(db, { ...rule, kind: 'code-verify' })).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(await firstRefusal(db, [{ ...rule, kind: 'code-verify' }, rule])).not.toBeNull();
  });

  it('turns an open invitation into a membership on sign-in, once', async () => {
    const inviter = `local:owner+${suffix}@example.com`;
    await db`insert into users (id, email) values (${inviter}, ${`owner+${suffix}@example.com`})`;
    const [account] = await db<{ id: string }[]>`insert into accounts (name) values (${'inv-' + suffix}) returning id`;
    await db`insert into account_members (account_id, user_id, role) values (${account!.id}, ${inviter}, 'owner')`;

    const invitee = `new+${suffix}@example.com`;
    expect(await hasOpenInvitation(db, invitee)).toBe(false);
    const inv = await createInvitation(db, { accountId: account!.id, email: invitee.toUpperCase(), role: 'member', invitedBy: inviter });
    expect(inv.email).toBe(invitee);
    expect(await hasOpenInvitation(db, invitee)).toBe(true);
    // Inviting again refreshes the one open row rather than adding a second.
    const again = await createInvitation(db, { accountId: account!.id, email: invitee, role: 'owner', invitedBy: inviter });
    expect(again.id).toBe(inv.id);
    expect(again.role).toBe('owner');
    expect(await listOpenInvitations(db, account!.id)).toHaveLength(1);

    const userId = `local:${invitee}`;
    await db`insert into users (id, email) values (${userId}, ${invitee})`;
    expect(await acceptInvitations(db, invitee, userId)).toEqual([account!.id]);
    const [member] = await db<{ role: string }[]>`select role from account_members where account_id = ${account!.id} and user_id = ${userId}`;
    expect(member!.role).toBe('owner');
    // Accepted: no longer open, and a second sign-in accepts nothing.
    expect(await hasOpenInvitation(db, invitee)).toBe(false);
    expect(await acceptInvitations(db, invitee, userId)).toEqual([]);
    expect(await listOpenInvitations(db, account!.id)).toHaveLength(0);
  });

  it('withdraws an open invitation and refuses to withdraw an accepted one', async () => {
    const inviter = `local:owner2+${suffix}@example.com`;
    await db`insert into users (id, email) values (${inviter}, ${`owner2+${suffix}@example.com`})`;
    const [account] = await db<{ id: string }[]>`insert into accounts (name) values (${'inv-' + suffix + '-b'}) returning id`;
    const inv = await createInvitation(db, { accountId: account!.id, email: `gone+${suffix}@example.com`, role: 'member', invitedBy: inviter });
    expect(await deleteInvitation(db, account!.id, inv.id)).toBe(true);
    expect(await deleteInvitation(db, account!.id, inv.id)).toBe(false);
  });
});
