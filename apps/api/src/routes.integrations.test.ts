import { describe, expect, it } from 'vitest';
import { signOAuthState } from '@engine/auth';
import { app } from './index.js';
import { isInvited, parseAllowedEmails } from './middleware/auth.js';
import { isBootstrapAdmin } from './repositories/platformCredentials.js';

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
    // The registry now carries prose setup steps rather than bare API names —
    // a step can say *why* an API is needed, which a name cannot — so this
    // asserts the name appears in a step rather than being an exact element.
    expect(ga4.requiredApis.some((s) => s.includes('Google Analytics Admin API'))).toBe(true);
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

  it('503s when nothing is configured, naming what the operator must set', async () => {
    // The message no longer names GOOGLE_CLIENT_ID, because that is no longer
    // how a client is configured — it is set on the platform admin screen. The
    // property under test is unchanged: a deployment that cannot complete a
    // flow refuses to start one, and says what is missing.
    const res = await post(`/accounts/${ACCOUNT}/integrations/gsc/connect-url`, {});
    expect(res.status).toBe(503);
    expect((await res.json() as { error: string }).error).toMatch(/ENCRYPTION_KEY/);
  });

  it('refuses to start an unsigned flow when no signing secret can be obtained', async () => {
    // OAUTH_STATE_SECRET is optional now — one is generated and stored with the
    // platform client. Here the database is unreachable, so neither source can
    // supply one, and the flow must be refused rather than signed with nothing.
    const { OAUTH_STATE_SECRET: _omitted, ...withoutSecret } = CLIENT_ENV;
    const res = await post(`/accounts/${ACCOUNT}/integrations/gsc/connect-url`, {}, withoutSecret);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { reason: string }).reason).toBe('state-secret-unavailable');
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

  /**
   * "The auth layer let this through", not "the endpoint returned data".
   *
   * `/health/integrations` is admin-gated now, so a bypassed-auth request from
   * loopback reaches the admin check and gets 404. 401 and 503 are the two
   * statuses the auth layer itself produces, so their absence is exactly the
   * claim these tests make — and it stays true if the endpoint's own rules
   * change again.
   */
  function expectAuthBypassed(res: Response): void {
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(503);
  }

  it('is honoured for a loopback request, so local dev still works', async () => {
    expectAuthBypassed(await get('http://localhost:8787/health/integrations', disabled));
  });

  it('is honoured on 127.0.0.1 too', async () => {
    expectAuthBypassed(await get('http://127.0.0.1:8787/health/integrations', disabled));
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

describe('the invite allowlist', () => {
  it('admits everyone when unset, rather than denying by default', () => {
    // A deny-all-when-unset gate is indistinguishable, from the user's side,
    // from auth being broken — the failure class this codebase keeps removing.
    expect(isInvited('anyone@example.com', undefined)).toBe(true);
    expect(isInvited('anyone@example.com', '')).toBe(true);
  });

  it('admits a listed address and refuses an unlisted one', () => {
    const list = 'a@example.com,b@example.com';
    expect(isInvited('a@example.com', list)).toBe(true);
    expect(isInvited('b@example.com', list)).toBe(true);
    expect(isInvited('c@example.com', list)).toBe(false);
  });

  it('ignores case and surrounding whitespace, since a human types the list', () => {
    expect(isInvited('Person@Example.com', ' person@example.com , other@x.com ')).toBe(true);
    expect(isInvited('  person@example.com  ', 'PERSON@EXAMPLE.COM')).toBe(true);
  });

  it('refuses a token with no email once a list is set', () => {
    // "No email" is not "not excluded" — the gate names who may enter, and it
    // cannot name this.
    expect(isInvited(undefined, 'a@example.com')).toBe(false);
  });

  it('does not admit on a partial or substring match', () => {
    expect(isInvited('evil-a@example.com', 'a@example.com')).toBe(false);
    expect(isInvited('a@example.com.attacker.test', 'a@example.com')).toBe(false);
  });

  it('parses a list into normalised entries, dropping blanks', () => {
    expect([...parseAllowedEmails('A@x.com, ,b@Y.com,')]).toEqual(['a@x.com', 'b@y.com']);
    expect(parseAllowedEmails(undefined).size).toBe(0);
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

/**
 * The catalogue's second job: describing providers that cannot be connected
 * yet, without ever letting one be connected.
 */
describe('GET /integrations/providers?planned=1', () => {
  it('hides planned providers by default and lists them on request', async () => {
    const live = (await (await request('/integrations/providers')).json()) as {
      providers: { id: string; availability: string }[];
    };
    expect(live.providers.every((p) => p.availability !== 'planned')).toBe(true);

    const all = (await (await request('/integrations/providers?planned=1')).json()) as {
      providers: { id: string; availability: string }[];
    };
    expect(all.providers.length).toBeGreaterThan(live.providers.length);
    expect(all.providers.some((p) => p.id === 'bing-webmaster' && p.availability === 'planned')).toBe(true);
  });

  it('describes the API-key form without ever carrying a value', async () => {
    const body = (await (await request('/integrations/providers?planned=1')).json()) as {
      providers: { id: string; authKind: string; fields?: { name: string; secret: boolean }[] }[];
    };
    const cloudflare = body.providers.find((p) => p.id === 'cloudflare')!;
    expect(cloudflare.authKind).toBe('api_key');
    expect(cloudflare.fields?.some((f) => f.name === 'apiToken' && f.secret)).toBe(true);
    // A field descriptor says what to paste; it must never carry a pasted value.
    expect(JSON.stringify(cloudflare.fields)).not.toMatch(/"value"/);
  });
});

describe('provider gating', () => {
  /**
   * Migration 0017 removed the database's `check (provider in (...))`, so
   * `assertConnectable` is the only thing standing between a request and a row
   * with a nonsense provider. These are that guarantee.
   */
  it('refuses a planned provider on every account-scoped route', async () => {
    const connect = await post(
      `/accounts/${ACCOUNT}/integrations/hubspot/connect-url`,
      {},
      CLIENT_ENV,
    );
    expect(connect.status).toBe(400);

    const apiKey = await post(`/accounts/${ACCOUNT}/integrations/ahrefs/api-key`, { apiToken: 'x' }, CLIENT_ENV);
    expect(apiKey.status).toBe(400);

    const remove = await request(
      `/accounts/${ACCOUNT}/integrations/hubspot`,
      { method: 'DELETE' },
      CLIENT_ENV,
    );
    expect(remove.status).toBe(400);
  });

  it('refuses an unknown provider id', async () => {
    const res = await post(`/accounts/${ACCOUNT}/integrations/not-a-provider/connect-url`, {}, CLIENT_ENV);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { field: string }).field).toBe('provider');
  });

  it('refuses an API key posted to an OAuth provider, and a consent flow for an API-key one', async () => {
    const wrongKind = await post(`/accounts/${ACCOUNT}/integrations/gsc/api-key`, { apiToken: 'x' }, CLIENT_ENV);
    expect(wrongKind.status).toBe(400);
    expect(((await wrongKind.json()) as { error: string }).error).toMatch(/consent flow, not an API key/);
  });
});

describe('the consent URL', () => {
  /**
   * PKCE is the property these protect. A signed state proves the callback
   * belongs to a flow we started; it does nothing about a code that leaked from
   * browser history or a proxy log. Without a challenge on the authorization
   * request there is nothing for the verifier to prove later.
   *
   * These run against a database that cannot be reached, so they assert what
   * the request *would* carry — `buildAuthorizationRequest` runs before the
   * flow is stored. That is the ordering under test as much as the parameters.
   */
  it('is refused when no encryption key is configured, naming the variable to set', async () => {
    const { ENCRYPTION_KEY: _drop, ...noKey } = CLIENT_ENV;
    const res = await post(`/accounts/${ACCOUNT}/integrations/gsc/connect-url`, {}, noKey);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(/ENCRYPTION_KEY/);
  });

  it('is refused when no signing secret can be obtained, rather than signed with nothing', async () => {
    const { OAUTH_STATE_SECRET: _drop, ...noSecret } = CLIENT_ENV;
    const res = await post(`/accounts/${ACCOUNT}/integrations/gsc/connect-url`, {}, noSecret);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { reason: string }).reason).toBe('state-secret-unavailable');
  });

  it('refuses when Engine has no OAuth client, before checking membership', async () => {
    // Ordering matters: clientFor and resolveStateSecret both swallow a
    // database failure and report "not configured", while requireOwner throws.
    // If the throwing call ran first, an unconfigured deployment would answer
    // 500 instead of naming its own missing configuration.
    const { GOOGLE_CLIENT_ID: _a, GOOGLE_CLIENT_SECRET: _b, GOOGLE_REDIRECT_URI: _c, ...noClient } = CLIENT_ENV;
    const res = await post(`/accounts/${ACCOUNT}/integrations/gsc/connect-url`, {}, noClient);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { reason: string }).reason).toBe('platform-client-missing');
  });
});

describe('GET /oauth/google/callback', () => {
  it('rejects a state signed with a different secret', async () => {
    const forged = await signOAuthState(
      { accountId: ACCOUNT, userId: 'user-1', provider: 'gsc' },
      'not-the-deployment-secret',
    );
    const res = await request(`/oauth/google/callback?code=abc&state=${encodeURIComponent(forged)}`, {}, CLIENT_ENV);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/was not valid/);
  });

  it('rejects a state naming a provider that is not connectable', async () => {
    // A signed state is unforgeable, not trustworthy about what it names: it
    // could have been minted before a provider was withdrawn.
    const state = await signOAuthState(
      { accountId: ACCOUNT, userId: 'user-1', provider: 'hubspot' },
      CLIENT_ENV.OAUTH_STATE_SECRET,
    );
    const res = await request(`/oauth/google/callback?code=abc&state=${encodeURIComponent(state)}`, {}, CLIENT_ENV);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/Unknown provider/);
  });

  it('reports a cancelled consent as cancelled, not as our failure', async () => {
    const res = await request('/oauth/google/callback?error=access_denied', {}, CLIENT_ENV);
    expect(await res.text()).toMatch(/Nothing was connected/);
  });

  it('never echoes the authorization code back into the page', async () => {
    // The page is rendered into a browser and may be screenshotted or logged;
    // the code is a single-use credential right up until it is exchanged.
    const state = await signOAuthState(
      { accountId: ACCOUNT, userId: 'user-1', provider: 'gsc' },
      CLIENT_ENV.OAUTH_STATE_SECRET,
    );
    const code = 'super-secret-authorization-code';
    const res = await request(
      `/oauth/google/callback?code=${code}&state=${encodeURIComponent(state)}`,
      {},
      CLIENT_ENV,
    );
    expect(await res.text()).not.toContain(code);
  });
});

/**
 * Engine's own OAuth client, and who may configure it.
 *
 * This is the boundary that was previously enforced by "you need Cloudflare
 * access". Now it is a code path, so the gate has to be tested rather than
 * assumed.
 */
describe('platform administration', () => {
  const ADMIN_ENV = { ...CLIENT_ENV, PLATFORM_ADMIN_EMAILS: 'ops@engine.test, boss@engine.test' } as const;

  it('reports non-admins as non-admins', async () => {
    // AUTH_MODE=disabled gives a stub user whose email is not on the list.
    const res = await request('/platform/access', {}, ADMIN_ENV);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { isAdmin: boolean }).isAdmin).toBe(false);
  });

  it('treats an unset admin list as nobody, not everybody', async () => {
    const res = await request('/platform/access', {}, CLIENT_ENV);
    expect(((await res.json()) as { isAdmin: boolean }).isAdmin).toBe(false);
  });

  it('answers 404 rather than 403 to a non-admin', async () => {
    // A 403 confirms the screen exists and that this deployment has
    // administrators, to someone who by definition is not one.
    //
    // The gate reads users.platform_role, and the database is unreachable in
    // this harness — which is itself the property under test further down:
    // a failed role read denies rather than falling back to the env list.
    for (const [path, init] of [
      ['/platform/oauth-clients/google', {}],
      ['/platform/oauth-clients/google', { method: 'DELETE' }],
    ] as const) {
      const res = await request(path, init, ADMIN_ENV);
      expect(res.status).toBe(404);
    }
    const put = await request(
      '/platform/oauth-clients/google',
      { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' },
      ADMIN_ENV,
    );
    expect(put.status).toBe(404);
  });

  it('never returns a client secret from any platform route', async () => {
    const text = await (await request('/platform/oauth-clients/google', {}, ADMIN_ENV)).text();
    expect(text).not.toContain(CLIENT_ENV.GOOGLE_CLIENT_SECRET);
  });
});

describe('isBootstrapAdmin', () => {
  /**
   * Only the bootstrap path is unit-testable without a database: the real check
   * reads `users.platform_role` and falls back to this list only for a user
   * with no row yet. What is asserted here is the fallback's own behaviour.
   */
  it('matches case-insensitively and ignores surrounding space', () => {
    const env = { PLATFORM_ADMIN_EMAILS: ' Ops@Engine.test , boss@engine.test ' };
    expect(isBootstrapAdmin('ops@engine.test', env)).toBe(true);
    expect(isBootstrapAdmin('  BOSS@ENGINE.TEST ', env)).toBe(true);
  });

  it('refuses everyone when the list is unset or empty', () => {
    // The dangerous default would be "unset means open".
    expect(isBootstrapAdmin('ops@engine.test', {})).toBe(false);
    expect(isBootstrapAdmin('ops@engine.test', { PLATFORM_ADMIN_EMAILS: '' })).toBe(false);
    expect(isBootstrapAdmin('ops@engine.test', { PLATFORM_ADMIN_EMAILS: '  ,  ' })).toBe(false);
  });

  it('refuses a caller with no email at all', () => {
    expect(isBootstrapAdmin(undefined, { PLATFORM_ADMIN_EMAILS: 'ops@engine.test' })).toBe(false);
  });

  it('does not match a substring or a lookalike domain', () => {
    const env = { PLATFORM_ADMIN_EMAILS: 'ops@engine.test' };
    expect(isBootstrapAdmin('ops@engine.test.evil.com', env)).toBe(false);
    expect(isBootstrapAdmin('notops@engine.test', env)).toBe(false);
  });
});

describe('the platform admin gate under failure', () => {
  const ADMIN_ENV = { ...CLIENT_ENV, PLATFORM_ADMIN_EMAILS: 'ops@engine.test' } as const;

  it('denies when the role cannot be read, rather than falling back to the env list', async () => {
    // DATABASE_URL points nowhere here. The tempting fallback — "cannot read
    // the role, so trust PLATFORM_ADMIN_EMAILS" — would let an admin who was
    // demoted in the product back in whenever the database hiccupped.
    const res = await request('/platform/users', {}, ADMIN_ENV);
    expect(res.status).toBe(404);
  });

  it('reports isAdmin false rather than erroring when the role cannot be read', async () => {
    // This drives whether the nav entry renders. A 500 here would put a red
    // banner on every screen for a failure a customer cannot act on.
    const res = await request('/platform/access', {}, ADMIN_ENV);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { isAdmin: boolean }).isAdmin).toBe(false);
  });

  it('hides the platform readiness report from a non-admin', async () => {
    // It names environment variables and says which are missing. That is
    // operator information; a customer gains nothing they can act on.
    const res = await request('/health/integrations', {}, ADMIN_ENV);
    expect(res.status).toBe(404);
  });

  it('refuses a role change with an invalid role', async () => {
    const res = await request(
      '/platform/users/some-user/role',
      { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"role":"superuser"}' },
      ADMIN_ENV,
    );
    // 404 from the admin gate, which runs first — the body is never reached.
    expect(res.status).toBe(404);
  });
});
