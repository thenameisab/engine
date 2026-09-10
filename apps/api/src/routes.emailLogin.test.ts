import { describe, expect, it } from 'vitest';
import { app } from './index.js';
import { signLocalSession } from '@engine/auth';

/**
 * The email-code, password and invitation routes at the boundary: what they
 * refuse before any database or mail provider is touched. The dead loopback
 * `DATABASE_URL` proves the order, as in routes.auth.test.ts. The lifecycle
 * that needs a database — codes stored, verified, consumed; invitations
 * accepted — is in the repositories' *.db.test.ts files.
 */
const SECRET = 'test-local-auth-secret';
const env = {
  DATABASE_URL: 'postgres://127.0.0.1:1/db',
  LOCAL_AUTH_SECRET: SECRET,
  RESEND_API_KEY: 're_test',
  EMAIL_FROM: 'Engine <login@example.com>',
} as const;

function post(path: string, body: unknown, over: Record<string, string | undefined> = {}, headers: Record<string, string> = {}): Promise<Response> {
  return app.request(
    path,
    { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) },
    { ...env, ...over },
  );
}

describe('POST /auth/code/request', () => {
  it('answers 503 when the session secret is unset, naming what is missing', async () => {
    const res = await post('/auth/code/request', { email: 'ada@example.com' }, { LOCAL_AUTH_SECRET: undefined });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain('LOCAL_AUTH_SECRET');
  });

  it('answers 503 when the mail transport is unconfigured, before reading the body', async () => {
    const res = await post('/auth/code/request', 'not even json', { RESEND_API_KEY: undefined });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain('RESEND_API_KEY');
  });

  it('rejects an address that is not one', async () => {
    const res = await post('/auth/code/request', { email: 'nobody' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid email: expected an email address', field: 'email' });
  });
});

describe('POST /auth/code/verify', () => {
  it('rejects a code that is not six digits without touching the store', async () => {
    const res = await post('/auth/code/verify', { email: 'ada@example.com', code: '12ab' });
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe('code');
  });

  it('answers 503 when unconfigured', async () => {
    const res = await post('/auth/code/verify', { email: 'ada@example.com', code: '123456' }, { LOCAL_AUTH_SECRET: undefined });
    expect(res.status).toBe(503);
  });
});

describe('POST /auth/password', () => {
  it('requires a session', async () => {
    const res = await post('/auth/password', { password: 'a-long-enough-password' });
    expect(res.status).toBe(401);
  });

  it('refuses a short password before hashing anything', async () => {
    const token = await signLocalSession({ id: 'local:ada@example.com', email: 'ada@example.com', name: 'Ada' }, SECRET);
    const res = await post('/auth/password', { password: 'short' }, {}, { authorization: `Bearer ${token}` });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('at least 12 characters');
  });

  it('applies to email sign-in principals only', async () => {
    // A service token is a machine; it has no password to set.
    const res = await post('/auth/password', { password: 'a-long-enough-password' }, { INTERNAL_API_TOKEN: 'svc' }, { authorization: 'Bearer svc' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('email sign-in accounts only');
  });
});

describe('invitations', () => {
  it('needs the mail transport before it will take a body', async () => {
    const token = await signLocalSession({ id: 'local:ada@example.com', email: 'ada@example.com', name: 'Ada' }, SECRET);
    const res = await post(
      '/accounts/11111111-1111-4111-8111-111111111111/invitations',
      { email: 'grace@example.com' },
      { EMAIL_FROM: undefined },
      { authorization: `Bearer ${token}` },
    );
    expect(res.status).toBe(503);
  });

  it('rejects a role outside owner/member', async () => {
    const token = await signLocalSession({ id: 'local:ada@example.com', email: 'ada@example.com', name: 'Ada' }, SECRET);
    const res = await post(
      '/accounts/11111111-1111-4111-8111-111111111111/invitations',
      { email: 'grace@example.com', role: 'admin' },
      {},
      { authorization: `Bearer ${token}` },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe('role');
  });
});
