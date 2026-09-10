import { describe, expect, it } from 'vitest';
import { app } from './index.js';
import { signLocalSession, signOAuthState } from '@engine/auth';

/**
 * Credential sign-in (`POST /auth/login`) and the session token it mints,
 * driven through the real Hono stack.
 *
 * No database: `AUTH_MODE` is *not* disabled here — that would short-circuit
 * the very gate under test — and `DATABASE_URL` points nowhere on purpose.
 * Every assertion below is about a decision made before any query runs, which
 * a connection that could never succeed proves.
 */
const SECRET = 'test-local-auth-secret';
const ROSTER = 'ada@engine.dev:pw-one:Ada Lovelace,grace@engine.dev:pw-two';

const env = {
  // A dead loopback port. Refused at once, with no name to look up: the old
  // `never.connected.invalid` host relied on DNS failing quickly, and on CI it
  // did not — three role reads against it timed out a 5-second test.
  DATABASE_URL: 'postgres://127.0.0.1:1/db',
  LOCAL_AUTH_USERS: ROSTER,
  LOCAL_AUTH_SECRET: SECRET,
} as const;

function login(body: unknown, over: Record<string, string> = {}): Promise<Response> {
  return app.request(
    '/auth/login',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
    { ...env, ...over },
  );
}

/**
 * That `requireAuth` let the request through, whatever the handler then did.
 *
 * These tests are about the gate, not the endpoint. Asserting 200 tied them to
 * one route's business outcome, so admin-gating that route broke tests about
 * token verification — which had not changed. 401 is the only status the gate
 * itself produces on rejection, so "not 401" is exactly the claim.
 */
function expectAdmitted(res: Response): void {
  expect(res.status).not.toBe(401);
}

/**
 * Any authenticated route will do. `/health/integrations` is still the cheapest
 * one to reach, but it is admin-gated now, so an admitted non-admin gets 404
 * rather than 200 — see `expectAdmitted`.
 */
function callGated(authorization: string | undefined, over: Record<string, string> = {}): Promise<Response> {
  return app.request(
    '/health/integrations',
    { method: 'GET', headers: authorization ? { authorization } : {} },
    { ...env, ...over },
  );
}

describe('POST /auth/login', () => {
  it('signs a roster user in and returns a token plus their identity', async () => {
    const res = await login({ email: 'ada@engine.dev', password: 'pw-one' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; user: { id: string; email: string; name: string } };
    expect(body.token).toMatch(/^[\w-]+\.[\w-]+$/);
    expect(body.user).toEqual({ id: 'local:ada@engine.dev', email: 'ada@engine.dev', name: 'Ada Lovelace' });
  });

  it('accepts a differently-cased address', async () => {
    const res = await login({ email: 'ADA@Engine.dev', password: 'pw-one' });
    expect(res.status).toBe(200);
  });

  it('rejects a wrong password with 401', async () => {
    const res = await login({ email: 'ada@engine.dev', password: 'pw-two' });
    expect(res.status).toBe(401);
  });

  /**
   * The roster is three people's email addresses. A login form that answers
   * differently for "no such user" and "wrong password" is a way to enumerate
   * them, so both answers must be identical — not merely both failures.
   */
  it('answers an unknown address exactly as it answers a wrong password', async () => {
    const unknown = await login({ email: 'stranger@engine.dev', password: 'pw-one' });
    const wrong = await login({ email: 'ada@engine.dev', password: 'nope' });
    expect(unknown.status).toBe(wrong.status);
    expect(await unknown.text()).toBe(await wrong.text());
  });

  it('answers 503, not 401, when credential sign-in is not configured', async () => {
    const res = await login({ email: 'ada@engine.dev', password: 'pw-one' }, { LOCAL_AUTH_USERS: '' });
    expect(res.status).toBe(503);
  });

  it('answers 503 when the roster is set but the signing secret is not', async () => {
    const res = await login({ email: 'ada@engine.dev', password: 'pw-one' }, { LOCAL_AUTH_SECRET: '' });
    expect(res.status).toBe(503);
  });

  it('rejects a malformed body with 400 and names the field', async () => {
    const res = await login({ email: 'ada@engine.dev' });
    expect(res.status).toBe(400);
    expect((await res.json()) as { field: string }).toMatchObject({ field: 'password' });
  });

  it('rejects a body that is not JSON at all with 400', async () => {
    const res = await login('not json');
    expect(res.status).toBe(400);
  });
});

describe('requireAuth with a local session token', () => {
  it('admits a valid session token', async () => {
    const token = await signLocalSession(
      { id: 'local:ada@engine.dev', email: 'ada@engine.dev', name: 'Ada Lovelace' },
      SECRET,
    );
    expectAdmitted(await callGated(`Bearer ${token}`));
  });

  it('admits the token the login route just minted', async () => {
    const { token } = (await (await login({ email: 'ada@engine.dev', password: 'pw-one' })).json()) as {
      token: string;
    };
    expectAdmitted(await callGated(`Bearer ${token}`));
  });

  it('refuses a token signed with a different secret', async () => {
    const token = await signLocalSession({ id: 'local:e@x.com', email: 'e@x.com', name: 'E' }, 'other-secret');
    expect((await callGated(`Bearer ${token}`)).status).toBe(503);
  });

  it('refuses an expired session with 401 so the client knows to sign in again', async () => {
    const token = await signLocalSession(
      { id: 'local:ada@engine.dev', email: 'ada@engine.dev', name: 'Ada Lovelace' },
      SECRET,
      { ttlSeconds: 1, nowSeconds: 1_000 },
    );
    const res = await callGated(`Bearer ${token}`);
    expect(res.status).toBe(401);
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'expired' });
  });

  /**
   * A signed OAuth state shares this token's wire format and is handed to the
   * browser by every consent flow, with a `userId` the caller influences.
   * Replaying one as a session must not authenticate anybody, even on a
   * deployment careless enough to use one secret for both.
   */
  it('refuses a signed OAuth state replayed as a session token', async () => {
    const state = await signOAuthState({ accountId: 'a', userId: 'local:evil@x.com', provider: 'gsc' }, SECRET);
    expect((await callGated(`Bearer ${state}`)).status).toBe(503);
  });

  it('still refuses a request with no token at all', async () => {
    expect((await callGated(undefined)).status).toBe(401);
  });

  /**
   * With credential sign-in unconfigured the gate must behave exactly as it
   * did before this feature existed: a Neon Auth JWT path, and 503 when even
   * that is unconfigured.
   */
  it('is inert when LOCAL_AUTH_SECRET is unset', async () => {
    const token = await signLocalSession({ id: 'local:e@x.com', email: 'e@x.com', name: 'E' }, SECRET);
    expect((await callGated(`Bearer ${token}`, { LOCAL_AUTH_SECRET: '' })).status).toBe(503);
  });
});
