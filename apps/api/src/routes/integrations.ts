/**
 * The routes a customer uses to connect their own accounts — Google Search
 * Console, GA4 and Business Profile today, and whatever the registry gains
 * next.
 *
 * A separate module rather than more of `index.ts`, which is already past 1,600
 * lines. These routes also form one coherent unit — a consent handshake, a
 * picker, and an assignment — that reads better together than interleaved with
 * rank polls and Stripe webhooks.
 *
 * Two access levels, deliberately:
 *   - Connecting and disconnecting require the **owner** role. The credential is
 *     shared by the whole account, so a `member` revoking it would break every
 *     project's sync for everyone.
 *   - Listing and assigning need membership only. Pointing a project at a
 *     different property is ordinary work.
 *
 * Ported to `@engine/integrations`: the provider comes from the registry rather
 * than a Google-only union, PKCE is carried through the consent handshake, and
 * a `state` is spendable exactly once.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  listProviders,
  getProvider,
  assertConnectable,
  buildAuthorizationRequest,
  exchangeCode,
  validateApiKeySubmission,
  missingScopes,
  listResources,
  IntegrationError,
  isIntegrationError,
  type IntegrationProvider,
  type ApiKeyCredential,
} from '@engine/integrations';
import { GoogleApiError } from '@engine/connectors';
// Importing for the side effect: this registers the Google listers against the
// seam above. Without it `listResources` would report gsc/ga4/gbp as having no
// listing implemented.
import '../repositories/googleListers.js';
import { signOAuthState, verifyOAuthState } from '@engine/auth';
import { createDb, type Db } from '../db.js';
import type { AuthEnv, AuthUser } from '../middleware/auth.js';
import { getAccountRole, upsertUser, getProjectAccountId, isAccountMember } from '../repositories/accounts.js';
import { markGscConnected } from '../repositories/onboarding.js';
import { syncGsc, syncGa4, syncGbp } from '../repositories/googleSync.js';
import { startFlow, claimFlow, keyringFrom } from '../repositories/oauthFlows.js';
import {
  listConnections,
  getConnection,
  upsertConnection,
  disconnect,
  getAccessToken,
  getApiKeyCredential,
  listAssignments,
  assignResource,
  unassignResource,
  listEvents,
  recordEvent,
  clientFor,
  ConnectionUnavailableError,
} from '../repositories/integrations.js';

export interface IntegrationsEnv extends AuthEnv {
  DATABASE_URL: string;
  /** One OAuth client covers all three Google providers — they differ only by scope. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Must byte-for-byte match a redirect URI registered on the OAuth client. */
  GOOGLE_REDIRECT_URI?: string;
  /** base64 of 32 random bytes. Seals credentials at rest. */
  ENCRYPTION_KEY?: string;
  /** Keyring form: `version:key` pairs, newest first. Supersedes ENCRYPTION_KEY. */
  ENCRYPTION_KEYS?: string;
  /** Signs the OAuth `state` parameter. */
  OAUTH_STATE_SECRET?: string;
  /** Where to send the browser after a callback. Defaults to the referring dashboard origin. */
  DASHBOARD_URL?: string;
}

type Env = { Bindings: IntegrationsEnv; Variables: { user: AuthUser } };

export const integrationsRoutes = new Hono<Env>();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve the `:provider` path param to a provider that may actually be
 * connected.
 *
 * `assertConnectable` is the single gate — it rejects an unknown id and a
 * `planned` registry row alike. Migration 0017 removed the database's check
 * constraint on the provider column, so this is the replacement, and every
 * route touching a credential goes through it.
 */
function readProvider(c: Context<Env>): IntegrationProvider | null {
  const raw = c.req.param('provider');
  if (!raw) return null;
  try {
    return assertConnectable(raw);
  } catch {
    return null;
  }
}

/**
 * Map a connection problem onto a status the dashboard can act on.
 *
 * 409 for 'needs-reauth' and 'insufficient-scope' rather than 401: the caller's
 * own session is fine, it is the *stored grant* that is not. Answering 401
 * would make the dashboard's interceptor sign the user out of Engine because a
 * vendor revoked something.
 */
function connectionErrorResponse(c: Context<Env>, error: ConnectionUnavailableError) {
  const status = error.reason === 'unconfigured' ? 503 : error.reason === 'not-connected' ? 404 : 409;
  return c.json({ error: error.message, reason: error.reason }, status);
}

/**
 * Map an IntegrationError onto a status.
 *
 * `rate_limited` becomes 429 with the vendor's own Retry-After echoed, so the
 * dashboard can wait the right amount rather than guessing.
 */
function integrationErrorResponse(c: Context<Env>, error: IntegrationError) {
  const status =
    error.reason === 'not_configured'
      ? 503
      : error.reason === 'unknown_provider'
        ? 404
        : error.reason === 'rate_limited'
          ? 429
          : error.needsReauth
            ? 409
            : error.reason === 'invalid_request' || error.reason === 'invalid_credentials'
              ? 400
              : 502;
  const headers: Record<string, string> =
    error.retryAfterSeconds !== undefined ? { 'retry-after': String(error.retryAfterSeconds) } : {};
  return c.json({ error: error.message, reason: error.reason, provider: error.providerId }, status, headers);
}

/** Owner-only guard for the account-scoped mutating routes. */
async function requireOwner(
  c: Context<Env>,
  db: Db,
  accountId: string,
): Promise<{ error: Response } | { ok: true }> {
  const user = c.get('user');
  await upsertUser(db, user);
  const role = await getAccountRole(db, accountId, user.id);
  if (role === null) {
    return { error: c.json({ error: 'you are not a member of this account', accountId }, 403) };
  }
  if (role !== 'owner') {
    return {
      error: c.json(
        {
          error: 'only an account owner can connect or disconnect an integration',
          accountId,
          role,
        },
        403,
      ),
    };
  }
  return { ok: true };
}

/* ── The provider catalogue ─────────────────────────────────────────────── */

/**
 * What can be connected, and what each provider needs on the vendor side.
 *
 * Public and unauthenticated because it is a static description of the product
 * — no account data, no secrets. The UI renders the connect screen from this,
 * so the setup steps and the "needs an access request" warning stay in one
 * place instead of being retyped into the frontend.
 *
 * `?planned=1` includes the roadmap rows, which is how the UI shows what is
 * coming without a second list that drifts. They are marked, and
 * `assertConnectable` refuses them everywhere else.
 */
integrationsRoutes.get('/integrations/providers', (c) => {
  const includePlanned = c.req.query('planned') === '1';
  return c.json({
    providers: listProviders({ includePlanned }).map((p) => ({
      id: p.id,
      name: p.name,
      vendor: p.vendor,
      purpose: p.purpose,
      category: p.category,
      availability: p.availability,
      authKind: p.auth.kind,
      // The form the API-key connect screen renders. Never includes a value —
      // only the shape of what the customer must paste.
      fields:
        p.auth.kind === 'api_key'
          ? p.auth.fields.map((f) => ({
              name: f.name,
              label: f.label,
              secret: f.secret,
              help: f.help,
              pattern: f.pattern,
            }))
          : undefined,
      scopes: p.auth.kind === 'oauth2' ? p.auth.scopes : [],
      resourceNoun: p.resourceNoun,
      resourceScope: p.resourceScope,
      setupSteps: p.setupSteps ?? [],
      // Same array under the old name. A Pages build and a Worker deploy are
      // never updated in the same instant, so the previous field keeps working
      // until the dashboard has rolled forward.
      requiredApis: p.setupSteps ?? [],
      requiresAccessRequest: Boolean(p.requiresAccessRequest),
      writes: p.writes,
      logoDomain: p.logoDomain,
      docsUrl: p.docsUrl,
    })),
  });
});

/* ── Account-scoped: connect, list, disconnect ──────────────────────────── */

/** Every connection on this account, plus whether a consent flow can start. */
integrationsRoutes.get('/accounts/:accountId/integrations', async (c) => {
  const accountId = c.req.param('accountId');
  if (!UUID_RE.test(accountId)) return c.json({ error: 'accountId must be a uuid', field: 'accountId' }, 400);

  const db = createDb(c.env.DATABASE_URL);
  const user = c.get('user');
  await upsertUser(db, user);
  if (!(await isAccountMember(db, accountId, user.id))) {
    return c.json({ error: 'you are not a member of this account', accountId }, 403);
  }

  const gsc = getProvider('gsc');
  return c.json({
    connections: await listConnections(db, accountId),
    // Named for the Google client because that is what every OAuth provider
    // live today uses; `clientFor` is the one place that changes when a second
    // vendor arrives.
    oauthConfigured: Boolean(gsc && clientFor(gsc, c.env)),
  });
});

/** The integration audit trail for this account (migration 0017). */
integrationsRoutes.get('/accounts/:accountId/integrations/events', async (c) => {
  const accountId = c.req.param('accountId');
  if (!UUID_RE.test(accountId)) return c.json({ error: 'accountId must be a uuid', field: 'accountId' }, 400);

  const db = createDb(c.env.DATABASE_URL);
  // Owner-only. The trail names who connected and disconnected what, which is
  // more than a member needs and exactly what an account owner is accountable
  // for.
  const guard = await requireOwner(c, db, accountId);
  if ('error' in guard) return guard.error;

  return c.json({ events: await listEvents(db, accountId) });
});

/**
 * Step 1 of the consent handshake: mint a signed state, stash the PKCE
 * verifier, and hand back the vendor's consent URL.
 *
 * Every precondition is checked *here*, before the user is sent to a consent
 * screen. Starting a flow we cannot complete would walk them through granting
 * access and then fail — having obtained access we are unable to store.
 */
integrationsRoutes.post('/accounts/:accountId/integrations/:provider/connect-url', async (c) => {
  const accountId = c.req.param('accountId');
  if (!UUID_RE.test(accountId)) return c.json({ error: 'accountId must be a uuid', field: 'accountId' }, 400);
  const provider = readProvider(c);
  if (!provider) return c.json({ error: 'unknown provider', field: 'provider' }, 400);
  if (provider.auth.kind !== 'oauth2') {
    return c.json(
      { error: `${provider.name} is connected with an API key, not a consent flow`, field: 'provider' },
      400,
    );
  }

  const client = clientFor(provider, c.env);
  if (!client) {
    return c.json(
      { error: 'OAuth is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI)' },
      503,
    );
  }
  if (!c.env.OAUTH_STATE_SECRET) {
    return c.json({ error: 'OAUTH_STATE_SECRET is not configured — refusing to start an unsigned OAuth flow' }, 503);
  }

  let keyring;
  try {
    keyring = await keyringFrom(c.env);
  } catch {
    return c.json({ error: 'ENCRYPTION_KEY (or ENCRYPTION_KEYS) is not configured — cannot store a credential' }, 503);
  }

  const db = createDb(c.env.DATABASE_URL);
  const guard = await requireOwner(c, db, accountId);
  if ('error' in guard) return guard.error;

  const body = (await c.req.json<{ returnTo?: string }>().catch(() => ({}))) as { returnTo?: string };
  const userId = c.get('user').id;

  const request = await buildAuthorizationRequest(provider, client, 'pending');
  // The state is minted after the PKCE pair so its nonce can key the stored
  // verifier. Signed first, then read back, because the nonce is generated
  // inside the signer and the row has to reference the same one.
  const state = await signOAuthState(
    { accountId, userId, provider: provider.id, returnTo: body.returnTo },
    c.env.OAUTH_STATE_SECRET,
  );
  const verified = await verifyOAuthState(state, c.env.OAUTH_STATE_SECRET);
  /* c8 ignore next -- we just signed it with the same secret. */
  if (!verified.ok) return c.json({ error: 'could not mint a connection link' }, 500);

  await startFlow(db, keyring, {
    nonce: verified.claims.nonce,
    accountId,
    provider: provider.id,
    userId,
    codeVerifier: request.pkce.verifier,
    returnTo: body.returnTo,
  });
  await recordEvent(db, {
    accountId,
    provider: provider.id,
    type: 'connect_started',
    actor: { kind: 'user', userId },
  });

  // Rebuilt with the real state. The PKCE challenge is unchanged, so the
  // verifier stored above still matches.
  const url = new URL(request.url);
  url.searchParams.set('state', state);
  return c.json({ url: url.toString(), provider: provider.id });
});

/**
 * Connect an API-key provider.
 *
 * The second connect path, for vendors with no consent screen. The key is
 * validated against the provider's declared fields *before* anything is
 * stored, so a bad paste costs a form error rather than a stored credential
 * that fails silently on the next sync.
 */
integrationsRoutes.post('/accounts/:accountId/integrations/:provider/api-key', async (c) => {
  const accountId = c.req.param('accountId');
  if (!UUID_RE.test(accountId)) return c.json({ error: 'accountId must be a uuid', field: 'accountId' }, 400);
  const provider = readProvider(c);
  if (!provider) return c.json({ error: 'unknown provider', field: 'provider' }, 400);
  if (provider.auth.kind !== 'api_key') {
    return c.json({ error: `${provider.name} is connected with a consent flow, not an API key` }, 400);
  }

  let keyring;
  try {
    keyring = await keyringFrom(c.env);
  } catch {
    return c.json({ error: 'ENCRYPTION_KEY (or ENCRYPTION_KEYS) is not configured — cannot store a credential' }, 503);
  }

  const db = createDb(c.env.DATABASE_URL);
  const guard = await requireOwner(c, db, accountId);
  if ('error' in guard) return guard.error;

  const raw = await c.req.json<unknown>().catch(() => null);
  if (raw === null || typeof raw !== 'object') return c.json({ error: 'body is not valid JSON' }, 400);
  const submission: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'string') return c.json({ error: `${k} must be a string`, field: k }, 400);
    submission[k] = v;
  }

  let credential;
  try {
    credential = validateApiKeySubmission(provider, submission);
  } catch (err) {
    if (isIntegrationError(err)) return integrationErrorResponse(c, err);
    throw err;
  }

  const userId = c.get('user').id;
  const connection = await upsertConnection(db, keyring, {
    accountId,
    provider: provider.id,
    credential,
    connectedBy: userId,
    // The first non-secret field doubles as the display label — a site URL or
    // an account id is what tells two connections of the same vendor apart.
    externalLabel: Object.values(credential.public)[0],
  });
  return c.json({ connection });
});

/**
 * Step 2: the vendor's redirect target.
 *
 * Deliberately **not** behind `requireAuth` — a browser arriving from a consent
 * screen carries no Authorization header, and it cannot. The signed `state` is
 * what authenticates this request: it names the account and the user, and we
 * minted it minutes ago. That is the whole reason `oauthState.ts` exists.
 *
 * Responds with HTML rather than JSON, since a human's browser lands here.
 */
integrationsRoutes.get('/oauth/google/callback', async (c) => {
  const error = c.req.query('error');
  if (error) {
    // The user clicked Cancel, or the vendor refused. Not our failure to report as one.
    return callbackPage(c, 'cancelled', `The provider returned "${error}". Nothing was connected.`);
  }

  const code = c.req.query('code');
  const state = c.req.query('state');
  if (!code || !state) return callbackPage(c, 'error', 'The redirect was missing its code or state.');

  const verified = await verifyOAuthState(state, c.env.OAUTH_STATE_SECRET);
  if (!verified.ok) {
    const message =
      verified.reason === 'expired'
        ? 'This connection link expired. Start again from the Integrations screen.'
        : verified.reason === 'unconfigured'
          ? 'OAuth state signing is not configured on this deployment.'
          : 'This connection link was not valid.';
    return callbackPage(c, verified.reason === 'expired' ? 'expired' : 'error', message);
  }

  const { accountId, userId, provider: providerId, nonce } = verified.claims;
  // `assertConnectable`, not `getProvider`: a signed state is unforgeable but
  // not trustworthy about what it names. It could have been minted before a
  // provider was withdrawn, and the whole point of a single gate is that the
  // callback cannot be the one route that skips it.
  let provider: IntegrationProvider;
  try {
    provider = assertConnectable(providerId);
  } catch {
    return callbackPage(c, 'error', 'Unknown provider in the connection link.');
  }
  if (provider.auth.kind !== 'oauth2') {
    return callbackPage(c, 'error', 'Unknown provider in the connection link.');
  }

  const client = clientFor(provider, c.env);
  if (!client) return callbackPage(c, 'error', 'OAuth is not configured on this deployment.');

  let keyring;
  try {
    keyring = await keyringFrom(c.env);
  } catch {
    return callbackPage(c, 'error', 'ENCRYPTION_KEY is not configured — the credential cannot be stored.');
  }

  const db = createDb(c.env.DATABASE_URL);

  // Claim the flow before the exchange. This is what makes a state single-use:
  // a replayed callback finds the row already consumed and stops here, rather
  // than after spending the authorization code.
  const claim = await claimFlow(db, keyring, nonce, accountId, providerId);
  if (!claim.ok) {
    const message =
      claim.reason === 'already-used'
        ? 'This connection link was already used. Start again from the Integrations screen.'
        : claim.reason === 'expired'
          ? 'This connection link expired. Start again from the Integrations screen.'
          : 'This connection link was not valid.';
    await recordEvent(db, {
      accountId,
      provider: providerId,
      type: 'connect_failed',
      actor: { kind: 'user', userId },
      reason: claim.reason,
    });
    return callbackPage(c, claim.reason === 'expired' ? 'expired' : 'error', message);
  }

  let tokens;
  try {
    tokens = await exchangeCode(provider, client, code, claim.codeVerifier);
  } catch (err) {
    await recordEvent(db, {
      accountId,
      provider: providerId,
      type: 'connect_failed',
      actor: { kind: 'user', userId },
      reason: isIntegrationError(err) ? err.reason : 'unknown',
      detail: err instanceof Error ? err.message : String(err),
    });
    return callbackPage(c, 'error', err instanceof Error ? err.message : 'Token exchange failed.');
  }

  if (!tokens.refreshToken) {
    // Without a refresh token the connection works for an hour and then dies.
    // Storing it would be worse than refusing: the UI would show a healthy
    // integration that stops producing data overnight.
    return callbackPage(
      c,
      'error',
      'The provider did not return a refresh token. Remove Engine’s access in your account settings, then connect again.',
    );
  }

  const missing = missingScopes(provider, tokens.grantedScopes);

  try {
    await upsertConnection(db, keyring, {
      accountId,
      provider: providerId,
      credential: { kind: 'oauth2', refreshToken: tokens.refreshToken },
      grantedScopes: tokens.grantedScopes,
      externalSubject: tokens.externalSubject,
      externalLabel: tokens.externalLabel,
      connectedBy: userId,
    });
  } catch (err) {
    return callbackPage(c, 'error', err instanceof Error ? err.message : 'Could not store the credential.');
  }

  const target = safeReturnTo(claim.returnTo, c.env.DASHBOARD_URL);
  // Stored either way — a partially-scoped connection is real and reconnecting
  // is the fix — but said plainly here rather than discovered as a 403 later.
  if (missing.length > 0) {
    return callbackPage(
      c,
      'error',
      `${provider.name} was connected without the access it needs. Reconnect and accept all requested permissions.`,
      target,
    );
  }
  return callbackPage(
    c,
    'connected',
    `${provider.name} is connected${tokens.externalLabel ? ` as ${tokens.externalLabel}` : ''}.`,
    target,
  );
});

/**
 * Only allow a same-origin-ish return target.
 *
 * `returnTo` comes from the connect request and rides through Google inside the
 * signed state, so it cannot be tampered with in flight — but it was still
 * supplied by a caller, and echoing it into a redirect unchecked is an open
 * redirect. Anything that is not a path under the configured dashboard is
 * dropped.
 */
function safeReturnTo(returnTo: string | undefined, dashboardUrl: string | undefined): string | undefined {
  if (!returnTo) return dashboardUrl;
  if (returnTo.startsWith('/') && !returnTo.startsWith('//')) {
    return dashboardUrl ? `${dashboardUrl.replace(/\/$/, '')}${returnTo}` : undefined;
  }
  if (dashboardUrl && returnTo.startsWith(dashboardUrl)) return returnTo;
  return dashboardUrl;
}

/**
 * The page the browser lands on after consent.
 *
 * Self-closing when it was opened as a popup, which is how the dashboard opens
 * it: `window.opener` gets a message so the Integrations screen refreshes
 * without a full reload, then the popup closes itself. Falls back to a link
 * when it was opened in a normal tab.
 */
function callbackPage(
  c: Context<Env>,
  status: 'connected' | 'cancelled' | 'expired' | 'error',
  message: string,
  returnTo?: string,
): Response {
  const ok = status === 'connected';
  const escaped = message.replace(/[<>&"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${ok ? 'Connected' : 'Not connected'}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, -apple-system, sans-serif; margin: 0; min-height: 100vh;
         display: grid; place-items: center; background: Canvas; color: CanvasText; }
  .card { max-width: 32rem; padding: 2rem; text-align: center; }
  .dot { width: .6rem; height: .6rem; border-radius: 50%; display: inline-block; margin-right: .5rem;
         background: ${ok ? '#1a7f37' : '#bc4c00'}; }
  h1 { font-size: 1.05rem; font-weight: 600; margin: 0 0 .5rem; }
  p { margin: 0 0 1.25rem; opacity: .85; }
  a { color: inherit; }
</style></head>
<body><div class="card">
  <h1><span class="dot"></span>${ok ? 'Connected' : 'Not connected'}</h1>
  <p>${escaped}</p>
  ${returnTo ? `<p><a href="${returnTo}">Return to Engine</a></p>` : ''}
  <script>
    try {
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage({ source: 'engine-oauth', status: ${JSON.stringify(status)} }, '*');
        window.close();
      } else if (${JSON.stringify(Boolean(returnTo))}) {
        setTimeout(function () { location.href = ${JSON.stringify(returnTo ?? '')}; }, 1200);
      }
    } catch (e) { /* a blocked opener is not worth failing over */ }
  </script>
</div></body></html>`;
  return c.body(html, ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
}

/**
 * The assignable resources on a connected provider — the picker's data source.
 *
 * Live-fetched rather than cached: a customer who just created a GA4 property
 * expects it to appear, and a stale list is the kind of thing people retry three
 * times before reporting.
 */
integrationsRoutes.get('/accounts/:accountId/integrations/:provider/resources', async (c) => {
  const accountId = c.req.param('accountId');
  if (!UUID_RE.test(accountId)) return c.json({ error: 'accountId must be a uuid', field: 'accountId' }, 400);
  const provider = readProvider(c);
  if (!provider) return c.json({ error: 'unknown provider', field: 'provider' }, 400);

  const db = createDb(c.env.DATABASE_URL);
  const user = c.get('user');
  await upsertUser(db, user);
  if (!(await isAccountMember(db, accountId, user.id))) {
    return c.json({ error: 'you are not a member of this account', accountId }, 403);
  }

  // Credential first, and its kind decides which one the lister gets. An
  // API-key provider has no access token to mint — there is no exchange step —
  // so asking for one would fail before the vendor was ever called.
  const ctx: { accessToken?: string; apiKey?: ApiKeyCredential } = {};
  try {
    if (provider.auth.kind === 'oauth2') {
      ctx.accessToken = await getAccessToken(db, accountId, provider.id, await keyringFrom(c.env), c.env);
    } else {
      ctx.apiKey = await getApiKeyCredential(db, accountId, provider.id, await keyringFrom(c.env));
    }
  } catch (err) {
    if (err instanceof ConnectionUnavailableError) return connectionErrorResponse(c, err);
    if (isIntegrationError(err)) return integrationErrorResponse(c, err);
    throw err;
  }

  try {
    const { resources, truncated } = await listResources({ provider, ...ctx });
    return c.json({ resources, truncated });
  } catch (err) {
    if (err instanceof GoogleApiError) {
      // These are the actionable ones — an unenabled API or a pending access
      // request is our configuration to fix, not the customer's.
      return c.json({ error: err.message, failure: err.failure, provider: provider.id }, err.needsReauth ? 409 : 502);
    }
    if (isIntegrationError(err)) return integrationErrorResponse(c, err);
    throw err;
  }
});

/** Disconnect a provider: revoke at the vendor, clear the stored secret, keep the audit row. */
integrationsRoutes.delete('/accounts/:accountId/integrations/:provider', async (c) => {
  const accountId = c.req.param('accountId');
  if (!UUID_RE.test(accountId)) return c.json({ error: 'accountId must be a uuid', field: 'accountId' }, 400);
  const provider = readProvider(c);
  if (!provider) return c.json({ error: 'unknown provider', field: 'provider' }, 400);

  const db = createDb(c.env.DATABASE_URL);
  const guard = await requireOwner(c, db, accountId);
  if ('error' in guard) return guard.error;

  const existing = await getConnection(db, accountId, provider.id);
  if (!existing) return c.json({ error: `${provider.name} is not connected`, provider: provider.id }, 404);

  const { revokedAtVendor, revocationSupported } = await disconnect(
    db,
    await keyringFrom(c.env),
    accountId,
    provider.id,
    c.env,
    { kind: 'user', userId: c.get('user').id },
  );
  // `revokedAtGoogle` is kept as an alias so a dashboard build older than this
  // deploy keeps rendering the right sentence. Both halves of a Pages/Worker
  // pair are never updated in the same instant.
  return c.json({
    disconnected: true,
    provider: provider.id,
    revokedAtVendor,
    revocationSupported,
    revokedAtGoogle: revokedAtVendor,
  });
});

/* ── Project-scoped: assignments ────────────────────────────────────────── */

async function projectMemberError(c: Context<Env>, db: Db, projectId: string) {
  const user = c.get('user');
  await upsertUser(db, user);
  const accountId = await getProjectAccountId(db, projectId);
  if (!accountId) return { error: c.json({ error: 'project not found', projectId }, 404) };
  if (!(await isAccountMember(db, accountId, user.id))) {
    return { error: c.json({ error: 'you are not a member of this project', projectId }, 403) };
  }
  return { accountId };
}

/** Which provider resources this project is pointed at. */
integrationsRoutes.get('/projects/:projectId/integrations', async (c) => {
  const projectId = c.req.param('projectId');
  if (!UUID_RE.test(projectId)) return c.json({ error: 'projectId must be a uuid', field: 'projectId' }, 400);

  const db = createDb(c.env.DATABASE_URL);
  const access = await projectMemberError(c, db, projectId);
  if ('error' in access) return access.error;

  const [assignments, connections] = await Promise.all([
    listAssignments(db, projectId),
    listConnections(db, access.accountId),
  ]);
  return c.json({ assignments, connections });
});

/**
 * Point this project at a provider resource.
 *
 * `PUT` because for GSC and GA4 it is idempotent — the project has one property
 * and this sets it. GBP is additive (many locations per project), so repeating
 * it with a different location adds rather than replaces; the DB's unique
 * constraint on (connection, project, resource) makes a repeat of the *same*
 * location an update, not a duplicate.
 */
integrationsRoutes.put('/projects/:projectId/integrations/:provider', async (c) => {
  const projectId = c.req.param('projectId');
  if (!UUID_RE.test(projectId)) return c.json({ error: 'projectId must be a uuid', field: 'projectId' }, 400);
  const provider = readProvider(c);
  if (!provider) return c.json({ error: 'unknown provider', field: 'provider' }, 400);

  const raw = await c.req.json<unknown>().catch(() => null);
  if (raw === null || typeof raw !== 'object') return c.json({ error: 'body is not valid JSON' }, 400);
  const body = raw as { resourceId?: unknown; resourceLabel?: unknown; entityId?: unknown };

  if (typeof body.resourceId !== 'string' || body.resourceId.trim() === '') {
    return c.json({ error: 'resourceId is required', field: 'resourceId' }, 400);
  }
  if (body.resourceLabel !== undefined && typeof body.resourceLabel !== 'string') {
    return c.json({ error: 'resourceLabel must be a string', field: 'resourceLabel' }, 400);
  }
  // Read from the registry rather than a provider id, which is what let
  // migration 0017 drop the hardcoded check constraint. The DB enforces the
  // same rule against `resource_scope`, but a 400 naming the field beats a
  // constraint violation surfacing as a 500.
  const needsEntity = provider.resourceScope === 'entity';
  if (needsEntity) {
    if (typeof body.entityId !== 'string' || !UUID_RE.test(body.entityId)) {
      return c.json(
        { error: `entityId (the ${provider.resourceNoun} entity) is required for ${provider.id}`, field: 'entityId' },
        400,
      );
    }
  } else if (body.entityId !== undefined) {
    return c.json({ error: `entityId does not apply to ${provider.id}`, field: 'entityId' }, 400);
  }

  const db = createDb(c.env.DATABASE_URL);
  const access = await projectMemberError(c, db, projectId);
  if ('error' in access) return access.error;

  const result = await assignResource(
    db,
    access.accountId,
    {
      projectId,
      provider: provider.id,
      resourceId: body.resourceId,
      resourceLabel: typeof body.resourceLabel === 'string' ? body.resourceLabel : undefined,
      entityId: needsEntity ? (body.entityId as string) : undefined,
    },
    { kind: 'user', userId: c.get('user').id },
  );
  if ('error' in result) {
    return c.json({ error: `${provider.name} is not connected for this account`, reason: result.error }, 409);
  }

  // E1's "GSC connected" milestone. It moved here from the old
  // `/oauth/gsc/callback`, which stamped it on token exchange — i.e. as soon as
  // a user granted consent, even though no property had been chosen and the
  // token was discarded. The milestone feeds the roadmap's time-to-first-insight
  // KPI, so it should mark the point a project can actually read search data:
  // a property assigned to it.
  if (provider.id === 'gsc') await markGscConnected(db, projectId);

  return c.json({ assignment: result });
});

/**
 * Pull fresh data for one provider now.
 *
 * The same functions the nightly cron runs — one implementation, so the path a
 * user triggers and the path nobody watches cannot drift apart.
 *
 * `from`/`to` are accepted for a backfill. Omitted, the provider's default
 * window applies: for GSC that ends three days back, because Search Console
 * data lags about two days and is revised for several more, so a window ending
 * today stores rows Google then changes.
 */
integrationsRoutes.post('/projects/:projectId/integrations/:provider/sync', async (c) => {
  const projectId = c.req.param('projectId');
  if (!UUID_RE.test(projectId)) return c.json({ error: 'projectId must be a uuid', field: 'projectId' }, 400);
  const provider = readProvider(c);
  if (!provider) return c.json({ error: 'unknown provider', field: 'provider' }, 400);

  const body = (await c.req.json<{ from?: unknown; to?: unknown }>().catch(() => ({}))) as {
    from?: unknown;
    to?: unknown;
  };
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const hasRange = body.from !== undefined || body.to !== undefined;
  if (hasRange) {
    if (typeof body.from !== 'string' || !DATE_RE.test(body.from)) {
      return c.json({ error: 'from must be YYYY-MM-DD', field: 'from' }, 400);
    }
    if (typeof body.to !== 'string' || !DATE_RE.test(body.to)) {
      return c.json({ error: 'to must be YYYY-MM-DD', field: 'to' }, 400);
    }
    if (body.from > body.to) return c.json({ error: 'from must not be after to', field: 'from' }, 400);
  }
  if (hasRange && provider.id === 'gbp') {
    // GBP has no time dimension to backfill — a location's profile is current
    // state, not a daily series. Accepting the range and ignoring it would be
    // the confusing option.
    return c.json({ error: 'gbp has no date range to sync — it reads current profile state', field: 'from' }, 400);
  }

  // A registry provider with no sync implementation yet must say so, rather
  // than falling through to the GA4 branch and reading the wrong API.
  if (provider.id !== 'gsc' && provider.id !== 'ga4' && provider.id !== 'gbp') {
    return c.json({ error: `${provider.name} has no sync implementation yet`, provider: provider.id }, 501);
  }

  const db = createDb(c.env.DATABASE_URL);
  const access = await projectMemberError(c, db, projectId);
  if ('error' in access) return access.error;

  const window = hasRange ? { from: body.from as string, to: body.to as string } : undefined;

  try {
    if (provider.id === 'gbp') {
      const result = await syncGbp(db, access.accountId, projectId, c.env);
      if ('error' in result) {
        return c.json({ error: 'no GBP location is assigned to this project', reason: result.error }, 409);
      }
      return c.json({ synced: result });
    }

    const result =
      provider.id === 'gsc'
        ? await syncGsc(db, access.accountId, projectId, c.env, window)
        : await syncGa4(db, access.accountId, projectId, c.env, window);

    if ('error' in result) {
      return c.json(
        { error: `no ${provider.name} ${provider.resourceNoun} is assigned to this project`, reason: result.error },
        409,
      );
    }
    return c.json({ synced: result });
  } catch (err) {
    if (err instanceof ConnectionUnavailableError) return connectionErrorResponse(c, err);
    if (err instanceof GoogleApiError) {
      return c.json({ error: err.message, failure: err.failure, provider: provider.id }, err.needsReauth ? 409 : 502);
    }
    if (isIntegrationError(err)) return integrationErrorResponse(c, err);
    throw err;
  }
});

/** Remove one assignment. */
integrationsRoutes.delete('/projects/:projectId/integrations/assignments/:assignmentId', async (c) => {
  const projectId = c.req.param('projectId');
  const assignmentId = c.req.param('assignmentId');
  if (!UUID_RE.test(projectId)) return c.json({ error: 'projectId must be a uuid', field: 'projectId' }, 400);
  if (!UUID_RE.test(assignmentId)) return c.json({ error: 'assignmentId must be a uuid', field: 'assignmentId' }, 400);

  const db = createDb(c.env.DATABASE_URL);
  const access = await projectMemberError(c, db, projectId);
  if ('error' in access) return access.error;

  const removed = await unassignResource(db, projectId, assignmentId);
  if (!removed) return c.json({ error: 'assignment not found on this project', assignmentId }, 404);
  return c.json({ removed: true, assignmentId });
});
