import { describe, expect, it } from 'vitest';
import { signOAuthState } from '@engine/auth';
import { app } from './index.js';

/**
 * The integration routes' contract at the boundary, driven through the real
 * Hono stack — same approach as ./routes.validation.test.ts.
 *
 * `DATABASE_URL` deliberately points nowhere. Every assertion here is about a
 * check that must happen *before* `createDb`, so a connection that would fail
 * proves the ordering: a caller with a malformed id, an unknown provider, or a
 * deployment missing its signing secrets must be turned away without a database
 * round-trip — and, for the OAuth routes, without walking a user through
 * Google's consent screen for a flow that cannot complete.
 */
const env = {
  AUTH_MODE: 'disabled',
  DATABASE_URL: 'postgres://never.connected.invalid/db',
} as const;

const CLIENT_ENV = {
  ...env,
  GOOGLE_CLIENT_ID: 'test.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'GOCSPX-test',
  GOOGLE_REDIRECT_URI: 'https://api.example/oauth/google/callback',
  OAUTH_STATE_SECRET: 'test-state-secret',
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
} as const;

const ACCOUNT = '11111111-1111-4111-8111-111111111111';

function request(path: string, init: RequestInit = {}, e: Record<string, string> = env): Promise<Response> {
  return app.request(path, init, e);
}

function post(path: string, body: unknown, e: Record<string, string> = env): Promise<Response> {
  return request(
    path,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    e,
  );
}

describe('GET /integrations/providers', () => {
  it('describes all three providers without auth or a database', async () => {
    const res = await request('/integrations/providers');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { providers: { id: string; requiresAccessRequest: boolean; writes: boolean }[] };
    expect(body.providers.map((p) => p.id).sort()).toEqual(['ga4', 'gbp', 'gsc']);
  });

  it('flags that GBP needs an approved access request, so the UI can say so up front', async () => {
    const body = (await (await request('/integrations/providers')).json()) as {
      providers: { id: string; requiresAccessRequest: boolean; requiredApis: string[]; writes: boolean }[];
    };
    const gbp = body.providers.find((p) => p.id === 'gbp')!;
    expect(gbp.requiresAccessRequest).toBe(true);
    expect(gbp.writes).toBe(true);

    const ga4 = body.providers.find((p) => p.id === 'ga4')!;
    // The Admin API is the one people forget; it must be named in the catalogue.
    expect(ga4.requiredApis).toContain('Google Analytics Admin API');
    expect(ga4.writes).toBe(false);
  });

  it('never returns a client id or secret', async () => {
    const text = await (await request('/integrations/providers', {}, CLIENT_ENV)).text();
    expect(text).not.toContain('GOCSPX');
    expect(text).not.toContain('apps.googleusercontent.com');
  });
});

describe('POST /accounts/:accountId/integrations/:provider/connect-url', () => {
  it('rejects a non-uuid accountId before touching the database', async () => {
    const res = await post('/accounts/not-a-uuid/integrations/gsc/connect-url', {}, CLIENT_ENV);
    expect(res.status).toBe(400);
    expect((await res.json() as { field: string }).field).toBe('accountId');
  });

  it('rejects an unknown provider', async () => {
    const res = await post(`/accounts/${ACCOUNT}/integrations/bing/connect-url`, {}, CLIENT_ENV);
    expect(res.status).toBe(400);
    expect((await res.json() as { field: string }).field).toBe('provider');
  });

  it('503s when no OAuth client is configured, naming the missing vars', async () => {
    const res = await post(`/accounts/${ACCOUNT}/integrations/gsc/connect-url`, {});
    expect(res.status).toBe(503);
    expect((await res.json() as { error: string }).error).toMatch(/GOOGLE_CLIENT_ID/);
  });

  it('refuses to start an unsigned flow when OAUTH_STATE_SECRET is missing', async () => {
    const { OAUTH_STATE_SECRET: _omitted, ...withoutSecret } = CLIENT_ENV;
    const res = await post(`/accounts/${ACCOUNT}/integrations/gsc/connect-url`, {}, withoutSecret);
    expect(res.status).toBe(503);
    expect((await res.json() as { error: string }).error).toMatch(/OAUTH_STATE_SECRET/);
  });

  it('refuses to start a flow it could not store the result of', async () => {
    // The important ordering: without ENCRYPTION_KEY this must fail *here*, not
    // after the user has granted Google access we then cannot persist.
    const { ENCRYPTION_KEY: _omitted, ...withoutKey } = CLIENT_ENV;
    const res = await post(`/accounts/${ACCOUNT}/integrations/gsc/connect-url`, {}, withoutKey);
    expect(res.status).toBe(503);
    expect((await res.json() as { error: string }).error).toMatch(/ENCRYPTION_KEY/);
  });
});

describe('GET /oauth/google/callback', () => {
  it('is not behind the auth gate — a browser from Google carries no bearer token', async () => {
    const res = await request('/oauth/google/callback');
    // Reaches the handler (400 for a missing code) rather than 401/403/503.
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
  });

  it('reports a cancelled consent as cancelled, not as a failure of ours', async () => {
    const res = await request('/oauth/google/callback?error=access_denied');
    const html = await res.text();
    expect(html).toContain('Nothing was connected');
    expect(html).toContain('access_denied');
  });

  it('rejects a missing code or state', async () => {
    expect((await request('/oauth/google/callback?state=x')).status).toBe(400);
    expect((await request('/oauth/google/callback?code=x')).status).toBe(400);
  });

  it('rejects a forged state — the attack an unsigned state parameter allowed', async () => {
    const forged = btoa(JSON.stringify({ accountId: ACCOUNT, userId: 'attacker', provider: 'gsc', exp: 9e9 }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const res = await request(`/oauth/google/callback?code=c&state=${forged}.notarealsignature`, {}, CLIENT_ENV);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('was not valid');
  });

  it('rejects a state signed with a different secret', async () => {
    const state = await signOAuthState(
      { accountId: ACCOUNT, userId: 'u1', provider: 'gsc' },
      'a-different-deployments-secret',
    );
    const res = await request(`/oauth/google/callback?code=c&state=${state}`, {}, CLIENT_ENV);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('was not valid');
  });

  it('tells the user to start again when the state expired, rather than calling it invalid', async () => {
    const state = await signOAuthState(
      { accountId: ACCOUNT, userId: 'u1', provider: 'gsc' },
      CLIENT_ENV.OAUTH_STATE_SECRET,
      { nowSeconds: 1_000_000, ttlSeconds: 60 },
    );
    const res = await request(`/oauth/google/callback?code=c&state=${state}`, {}, CLIENT_ENV);
    expect(await res.text()).toContain('expired');
  });

  it('fails closed when state signing is unconfigured, rather than trusting the state', async () => {
    const state = await signOAuthState({ accountId: ACCOUNT, userId: 'u1', provider: 'gsc' }, 'some-secret');
    const res = await request(`/oauth/google/callback?code=c&state=${state}`, {}, env);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('not configured');
  });

  it('escapes the message it echoes back, so a Google error cannot inject markup', async () => {
    const res = await request('/oauth/google/callback?error=%3Cimg+src%3Dx+onerror%3Dalert(1)%3E');
    const html = await res.text();
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&#60;img');
  });
});

describe('PUT /projects/:projectId/integrations/:provider', () => {
  const PROJECT = '22222222-2222-4222-8222-222222222222';

  function put(path: string, body: unknown): Promise<Response> {
    return request(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }

  it('requires a resourceId', async () => {
    const res = await put(`/projects/${PROJECT}/integrations/gsc`, {});
    expect(res.status).toBe(400);
    expect((await res.json() as { field: string }).field).toBe('resourceId');
  });

  it('rejects a blank resourceId rather than storing an empty assignment', async () => {
    const res = await put(`/projects/${PROJECT}/integrations/gsc`, { resourceId: '   ' });
    expect(res.status).toBe(400);
  });

  it('requires an entityId for gbp, since a location is an entity', async () => {
    const res = await put(`/projects/${PROJECT}/integrations/gbp`, { resourceId: 'locations/1' });
    expect(res.status).toBe(400);
    expect((await res.json() as { field: string }).field).toBe('entityId');
  });

  it('rejects a non-uuid entityId for gbp', async () => {
    const res = await put(`/projects/${PROJECT}/integrations/gbp`, { resourceId: 'locations/1', entityId: 'nope' });
    expect(res.status).toBe(400);
    expect((await res.json() as { field: string }).field).toBe('entityId');
  });

  it('rejects an entityId on gsc/ga4, which describe the whole site', async () => {
    const res = await put(`/projects/${PROJECT}/integrations/ga4`, {
      resourceId: 'properties/1',
      entityId: '33333333-3333-4333-8333-333333333333',
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { field: string }).field).toBe('entityId');
  });

  it('rejects a malformed body', async () => {
    const res = await request(`/projects/${PROJECT}/integrations/gsc`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });

  it('rejects a non-uuid projectId and an unknown provider', async () => {
    expect((await put('/projects/nope/integrations/gsc', { resourceId: 'x' })).status).toBe(400);
    expect((await put(`/projects/${PROJECT}/integrations/bing`, { resourceId: 'x' })).status).toBe(400);
  });
});

describe('POST /projects/:projectId/integrations/:provider/sync', () => {
  const PROJECT = '22222222-2222-4222-8222-222222222222';

  function sync(path: string, body: unknown = {}): Promise<Response> {
    return request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('rejects a malformed date range before any Google call', async () => {
    const res = await sync(`/projects/${PROJECT}/integrations/gsc/sync`, { from: '24-08-2026', to: '2026-08-24' });
    expect(res.status).toBe(400);
    expect((await res.json() as { field: string }).field).toBe('from');
  });

  it('requires both ends of a range, not just one', async () => {
    const res = await sync(`/projects/${PROJECT}/integrations/gsc/sync`, { from: '2026-08-01' });
    expect(res.status).toBe(400);
    expect((await res.json() as { field: string }).field).toBe('to');
  });

  it('rejects an inverted range', async () => {
    const res = await sync(`/projects/${PROJECT}/integrations/gsc/sync`, { from: '2026-08-24', to: '2026-08-01' });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/must not be after/);
  });

  it('refuses a date range on gbp rather than accepting and ignoring it', async () => {
    // A GBP profile is current state, not a daily series. Silently ignoring the
    // range would be the confusing option.
    const res = await sync(`/projects/${PROJECT}/integrations/gbp/sync`, { from: '2026-08-01', to: '2026-08-24' });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/no date range/);
  });

  it('rejects a non-uuid projectId and an unknown provider', async () => {
    expect((await sync('/projects/nope/integrations/gsc/sync')).status).toBe(400);
    expect((await sync(`/projects/${PROJECT}/integrations/bing/sync`)).status).toBe(400);
  });
});

describe('AUTH_MODE=disabled', () => {
  // The docs always said "local development only, never on a deployed Worker".
  // Nothing enforced it, so one stray `wrangler secret put` left every project
  // route, the database URL and live SERP/LLM credit open with no signal.
  const disabled = { ...env, AUTH_MODE: 'disabled' } as Record<string, string>;

  function get(url: string, e: Record<string, string>): Promise<Response> {
    return app.request(new Request(url), {}, e);
  }

  it('is honoured for a loopback request, so local dev still works', async () => {
    const res = await get('http://localhost:8787/health/integrations', disabled);
    expect(res.status).toBe(200);
  });

  it('is honoured on 127.0.0.1 too', async () => {
    const res = await get('http://127.0.0.1:8787/health/integrations', disabled);
    expect(res.status).toBe(200);
  });

  it('is refused on a deployed hostname rather than opening the API', async () => {
    const res = await get('https://engine-api.workers.dev/health/integrations', disabled);
    expect(res.status).toBe(503);
    expect((await res.json() as { error: string }).error).toMatch(/refused outside local development/);
  });

  it('cannot be re-enabled by a forged Host header', async () => {
    // The guard reads the request URL, not Host/X-Forwarded-Host, both of which
    // the caller controls.
    const res = await app.request(
      new Request('https://engine-api.workers.dev/health/integrations', {
        headers: { host: 'localhost', 'x-forwarded-host': 'localhost' },
      }),
      {},
      disabled,
    );
    expect(res.status).toBe(503);
  });
});

describe('CORS', () => {
  it('allows the methods the integration routes actually use', async () => {
    const res = await request('/accounts/x/integrations', {
      method: 'OPTIONS',
      headers: { origin: 'https://dash.example', 'access-control-request-method': 'DELETE' },
    });
    const allowed = res.headers.get('access-control-allow-methods') ?? '';
    // A successful preflight that omits DELETE/PUT is the trap the branding
    // route already hit once with PATCH.
    expect(allowed).toContain('DELETE');
    expect(allowed).toContain('PUT');
  });
});
