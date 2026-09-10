import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.js';
import { updateAccountBranding, getAccount } from './accounts.js';

/**
 * Branding is a `PATCH`, so a field the caller did not send has to survive the
 * write. It used to assign the whole `branding` object, so the Settings form —
 * which held three blank inputs and no prefill — wiped two fields every time
 * someone filled in one. Runs only when `TEST_DATABASE_URL` points at a
 * database migrated through 0034.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('account branding (Postgres)', () => {
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
});
