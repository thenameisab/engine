import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.js';
import { updateAccountBranding, getAccount, createAccount, listAccountsForUser } from './accounts.js';

/**
 * The two account facts a screen reads and a screen writes.
 *
 * Branding is a `PATCH`, so a field the caller did not send has to survive the
 * write. It used to assign the whole `branding` object, so the Settings form —
 * which held three blank inputs and no prefill — wiped two fields every time
 * someone filled in one.
 *
 * `kind` is 0035: onboarding asked which of company, agency or individual owns
 * the site and never sent the answer, so no screen could branch on it.
 *
 * Runs only when `TEST_DATABASE_URL` points at a database migrated through 0035.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('accounts (Postgres)', () => {
  let db: Db;
  let accountId: string;
  const suffix = Math.random().toString(36).slice(2, 8);

  beforeAll(async () => {
    db = createDb(url!);
    const [row] = await db<{ id: string }[]>`
      insert into accounts (name, branding) values (${'brand-' + suffix}, '{}'::jsonb) returning id
    `;
    accountId = row!.id;
  });
  afterAll(async () => {
    await db`delete from accounts where name like ${'brand-' + suffix + '%'}`;
    await db`delete from users where id = ${'local:brand-' + suffix}`;
    await db.end();
  });

  const branding = async () => (await getAccount(db, accountId))!.branding;

  it('keeps the fields a patch does not mention', async () => {
    await updateAccountBranding(db, accountId, {
      set: { companyName: 'Acme Agency', logoUrl: 'https://acme.example/logo.png', primaryColor: '#4f46e5' },
      clear: [],
    });
    // The bug: this patch names only the colour, so the other two must survive.
    await updateAccountBranding(db, accountId, { set: { primaryColor: '#111827' }, clear: [] });

    expect(await branding()).toEqual({
      companyName: 'Acme Agency',
      logoUrl: 'https://acme.example/logo.png',
      primaryColor: '#111827',
    });
  });

  it('removes a cleared key rather than storing an empty string', async () => {
    // Every reader falls back with `branding.logoUrl ?? …`, which an empty
    // string would defeat — it has to be absent, not blank.
    await updateAccountBranding(db, accountId, { set: {}, clear: ['logoUrl'] });
    const after = await branding();
    expect('logoUrl' in after).toBe(false);
    expect(after.companyName).toBe('Acme Agency');
  });

  it('sets and clears in one write', async () => {
    await updateAccountBranding(db, accountId, {
      set: { logoUrl: 'https://acme.example/new.png' },
      clear: ['companyName'],
    });
    expect(await branding()).toEqual({ logoUrl: 'https://acme.example/new.png', primaryColor: '#111827' });
  });

  /**
   * 0035. Onboarding asked "This site belongs to" and dropped the answer, so
   * nothing downstream could tell an agency from a company.
   */
  describe('kind', () => {
    const userId = `local:brand-${suffix}`;

    beforeAll(async () => {
      await db`insert into users (id, email) values (${userId}, ${`brand+${suffix}@example.com`})`;
    });

    it('stores the kind the caller chose and reads it back', async () => {
      const agency = await createAccount(db, `brand-${suffix}-agency`, userId, 'agency');
      expect(agency.kind).toBe('agency');
      expect((await getAccount(db, agency.id))!.kind).toBe('agency');
      expect((await listAccountsForUser(db, userId)).find((a) => a.id === agency.id)?.kind).toBe('agency');
    });

    it('defaults to company, which is what every row before 0035 was', async () => {
      const account = await createAccount(db, `brand-${suffix}-default`, userId);
      expect(account.kind).toBe('company');
      expect((await getAccount(db, accountId))!.kind).toBe('company');
    });

    it('refuses a kind outside the three', async () => {
      await expect(
        db`insert into accounts (name, kind) values (${`brand-${suffix}-bad`}, 'enterprise')`,
      ).rejects.toThrow(/accounts_kind_check/);
    });
  });
});
