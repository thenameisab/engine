/**
 * The routes a customer uses to connect Google Search Console, GA4 and Google
 * Business Profile themselves.
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
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  GOOGLE_PROVIDERS,
  isGoogleProvider,
  buildConsentUrl,
  exchangeCode,
  listGscProperties,
  canReadGscProperty,
  listGa4Properties,
  listGbpAccounts,
  listGbpLocations,
  GoogleApiError,
  type GoogleProvider,
} from '@engine/connectors';
import { signOAuthState, verifyOAuthState } from '@engine/auth';
import { createDb, type Db } from '../db.js';
import type { AuthEnv, AuthUser } from '../middleware/auth.js';
import { getAccountRole, upsertUser, getProjectAccountId, isAccountMember } from '../repositories/accounts.js';
import { markGscConnected } from '../repositories/onboarding.js';
import { syncGsc, syncGa4, syncGbp } from '../repositories/googleSync.js';
import {
  listConnections,
  getConnection,
  upsertConnection,
  disconnect,
  getAccessToken,
  listAssignments,
  assignResource,
  unassignResource,
  ConnectionUnavailableError,
} from '../repositories/integrations.js';

export interface IntegrationsEnv extends AuthEnv {
  DATABASE_URL: string;
  /** One OAuth client covers all three providers — they differ only by scope. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Must byte-for-byte match a redirect URI registered on the OAuth client. */
  GOOGLE_REDIRECT_URI?: string;
  /** base64 of 32 random bytes. Seals refresh tokens at rest. */
  ENCRYPTION_KEY?: string;
  /** Signs the OAuth `state` parameter. */
  OAUTH_STATE_SECRET?: string;
  /** Where to send the browser after a callback. Defaults to the referring dashboard origin. */
  DASHBOARD_URL?: string;
}

type Env = { Bindings: IntegrationsEnv; Variables: { user: AuthUser } };

export const integrationsRoutes = new Hono<Env>();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve and validate the `:provider` path param. */
function readProvider(c: Context<Env>): GoogleProvider | null {
  const raw = c.req.param('provider');
  return raw && isGoogleProvider(raw) ? raw : null;
}

function oauthClient(env: IntegrationsEnv) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REDIRECT_URI) return null;
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: env.GOOGLE_REDIRECT_URI,
  };
}

/**
 * Map a connection problem onto a status the dashboard can act on.
 *
 * 409 for 'needs-reauth' and 'insufficient-scope' rather than 401: the caller's
 * own session is fine, it is the *stored Google grant* that is not. Answering
 * 401 would make the dashboard's interceptor sign the user out of Engine
 * because Google revoked something.
 */
function connectionErrorResponse(c: Context<Env>, error: ConnectionUnavailableError) {
  const status = error.reason === 'unconfigured' ? 503 : error.reason === 'not-connected' ? 404 : 409;
  return c.json({ error: error.message, reason: error.reason }, status);
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
 * What can be connected, and what each provider needs on the Google side.
 *
 * Public and unauthenticated because it is a static description of the product
 * — no account data, no secrets. The UI renders the connect screen from this, so
 * the list of required Cloud APIs and the "needs an access request" warning stay
 * in one place instead of being retyped into the frontend.
 */
integrationsRoutes.get('/integrations/providers', (c) =>
  c.json({
    providers: Object.values(GOOGLE_PROVIDERS).map((p) => ({
      id: p.id,
      name: p.name,
      purpose: p.purpose,
      scopes: p.scopes,
      resourceNoun: p.resourceNoun,
      requiredApis: p.requiredApis,
      requiresAccessRequest: p.requiresAccessRequest,
      writes: p.writes,
    })),
  }),
);

/* ── Account-scoped: connect, list, disconnect ──────────────────────────── */

/** Every Google connection on an account, with its health. Never returns a token. */
integrationsRoutes.get('/accounts/:accountId/integrations', async (c) => {
  const accountId = c.req.param('accountId');
  if (!UUID_RE.test(accountId)) return c.json({ error: 'accountId must be a uuid', field: 'accountId' }, 400);

  const db = createDb(c.env.DATABASE_URL);
  const user = c.get('user');
  await upsertUser(db, user);
  if (!(await isAccountMember(db, accountId, user.id))) {
    return c.json({ error: 'you are not a member of this account', accountId }, 403);
  }

  const connections = await listConnections(db, accountId);
  return c.json({
    connections,
    /** True when the deployment itself has an OAuth client — nothing can be connected without one. */
    oauthConfigured: oauthClient(c.env) !== null,
  });
});

/**
 * Step 1 of the handshake: mint a signed state and return the consent URL.
 *
 * Returns the URL rather than a 302 so the dashboard can open it in a popup and
 * keep its own page state — and so this route stays testable as JSON.
 */
integrationsRoutes.post('/accounts/:accountId/integrations/:provider/connect-url', async (c) => {
  const accountId = c.req.param('accountId');
  if (!UUID_RE.test(accountId)) return c.json({ error: 'accountId must be a uuid', field: 'accountId' }, 400);
  const provider = readProvider(c);
  if (!provider) return c.json({ error: 'unknown provider', field: 'provider' }, 400);

  const client = oauthClient(c.env);
  if (!client) {
    return c.json(
      { error: 'Google OAuth is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI)' },
      503,
    );
  }
  if (!c.env.OAUTH_STATE_SECRET) {
    return c.json({ error: 'OAUTH_STATE_SECRET is not configured — refusing to start an unsigned OAuth flow' }, 503);
  }
  if (!c.env.ENCRYPTION_KEY) {
    // Checked here, not only at callback time. Starting a flow we cannot
    // complete would walk the user through Google's consent screen and then
    // fail, having granted us access we cannot store.
    return c.json({ error: 'ENCRYPTION_KEY is not configured — cannot store a credential' }, 503);
  }

  const db = createDb(c.env.DATABASE_URL);
  const guard = await requireOwner(c, db, accountId);
  if ('error' in guard) return guard.error;

  const body = (await c.req.json<{ returnTo?: string }>().catch(() => ({}))) as { returnTo?: string };
  const state = await signOAuthState(
    { accountId, userId: c.get('user').id, provider, returnTo: body.returnTo },
    c.env.OAUTH_STATE_SECRET,
  );
  return c.json({ url: buildConsentUrl(provider, client, state), provider });
});

/**
 * Step 2: Google's redirect target.
 *
 * Deliberately **not** behind `requireAuth` — a browser arriving from Google
 * carries no Authorization header, and it cannot. The signed `state` is what
 * authenticates this request: it names the account and the user, and we minted
 * it minutes ago. That is the whole reason `oauthState.ts` exists.
 *
 * Responds with HTML rather than JSON, since a human's browser lands here.
 */
integrationsRoutes.get('/oauth/google/callback', async (c) => {
  const error = c.req.query('error');
  if (error) {
    // The user clicked Cancel, or Google refused. Not our failure to report as one.
    return callbackPage(c, 'cancelled', `Google returned "${error}". Nothing was connected.`);
  }

  const code = c.req.query('code');
  const state = c.req.query('state');
  if (!code || !state) return callbackPage(c, 'error', 'Google’s redirect was missing its code or state.');

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

  const { accountId, userId, provider: providerId, returnTo } = verified.claims;
  if (!isGoogleProvider(providerId)) return callbackPage(c, 'error', 'Unknown provider in the connection link.');

  const client = oauthClient(c.env);
  if (!client) return callbackPage(c, 'error', 'Google OAuth is not configured on this deployment.');

  let tokens;
  try {
    tokens = await exchangeCode(code, client);
  } catch (err) {
    return callbackPage(c, 'error', err instanceof Error ? err.message : 'Token exchange failed.');
  }

  if (!tokens.refreshToken) {
    // Without a refresh token the connection works for an hour and then dies.
    // Storing it would be worse than refusing: the UI would show a healthy
    // integration that stops producing data overnight.
    return callbackPage(
      c,
      'error',
      'Google did not return a refresh token. Remove Engine’s access at myaccount.google.com/permissions, then connect again.',
    );
  }

  const db = createDb(c.env.DATABASE_URL);
  try {
    await upsertConnection(
      db,
      {
        accountId,
        provider: providerId,
        refreshToken: tokens.refreshToken,
        grantedScopes: tokens.grantedScopes,
        googleSubject: tokens.googleSubject,
        googleEmail: tokens.googleEmail,
        connectedBy: userId,
      },
      c.env.ENCRYPTION_KEY,
    );
  } catch (err) {
    return callbackPage(c, 'error', err instanceof Error ? err.message : 'Could not store the credential.');
  }

  const target = safeReturnTo(returnTo, c.env.DASHBOARD_URL);
  return callbackPage(
    c,
    'connected',
    `${GOOGLE_PROVIDERS[providerId].name} is connected${tokens.googleEmail ? ` as ${tokens.googleEmail}` : ''}.`,
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

  let accessToken: string;
  try {
    accessToken = await getAccessToken(db, accountId, provider, c.env);
  } catch (err) {
    if (err instanceof ConnectionUnavailableError) return connectionErrorResponse(c, err);
    throw err;
  }

  try {
    if (provider === 'gsc') {
      const properties = await listGscProperties(accessToken);
      return c.json({
        resources: properties.map((p) => ({
          id: p.siteUrl,
          label: p.siteUrl,
          // Surfaced so the picker can disable rather than silently offer a
          // property that returns no data.
          selectable: canReadGscProperty(p.permissionLevel),
          detail: p.permissionLevel,
        })),
      });
    }

    if (provider === 'ga4') {
      const { properties, truncated } = await listGa4Properties(accessToken);
      return c.json({
        resources: properties.map((p) => ({ id: p.name, label: p.displayName, selectable: true })),
        truncated,
      });
    }

    // GBP resources are two levels deep: locations live under an account, so
    // list the accounts and then their locations. Flattened here because the
    // picker only ever assigns a location.
    const { accounts } = await listGbpAccounts(accessToken);
    const resources: { id: string; label: string; selectable: boolean; detail?: string }[] = [];
    let truncated = false;
    for (const account of accounts) {
      const { locations, truncated: pageTruncated } = await listGbpLocations(accessToken, account.name);
      truncated = truncated || pageTruncated;
      for (const location of locations) {
        resources.push({
          id: location.name,
          label: location.title || location.name,
          selectable: true,
          detail: [account.accountName, location.storeCode, location.locality].filter(Boolean).join(' · '),
        });
      }
    }
    return c.json({ resources, truncated });
  } catch (err) {
    if (err instanceof GoogleApiError) {
      // These are the actionable ones — an unenabled API or a pending access
      // request is our configuration to fix, not the customer's.
      return c.json({ error: err.message, failure: err.failure, provider }, err.needsReauth ? 409 : 502);
    }
    throw err;
  }
});

/** Disconnect a provider: revoke at Google, clear the stored token, keep the audit row. */
integrationsRoutes.delete('/accounts/:accountId/integrations/:provider', async (c) => {
  const accountId = c.req.param('accountId');
  if (!UUID_RE.test(accountId)) return c.json({ error: 'accountId must be a uuid', field: 'accountId' }, 400);
  const provider = readProvider(c);
  if (!provider) return c.json({ error: 'unknown provider', field: 'provider' }, 400);

  const db = createDb(c.env.DATABASE_URL);
  const guard = await requireOwner(c, db, accountId);
  if ('error' in guard) return guard.error;

  const existing = await getConnection(db, accountId, provider);
  if (!existing) return c.json({ error: `${provider} is not connected`, provider }, 404);

  const { revokedAtGoogle } = await disconnect(db, accountId, provider, c.env);
  return c.json({ disconnected: true, provider, revokedAtGoogle });
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
  // The DB enforces this too, but a 400 naming the field beats a constraint
  // violation surfacing as a 500.
  if (provider === 'gbp') {
    if (typeof body.entityId !== 'string' || !UUID_RE.test(body.entityId)) {
      return c.json({ error: 'entityId (the location entity) is required for gbp', field: 'entityId' }, 400);
    }
  } else if (body.entityId !== undefined) {
    return c.json({ error: `entityId does not apply to ${provider}`, field: 'entityId' }, 400);
  }

  const db = createDb(c.env.DATABASE_URL);
  const access = await projectMemberError(c, db, projectId);
  if ('error' in access) return access.error;

  const result = await assignResource(db, access.accountId, {
    projectId,
    provider,
    resourceId: body.resourceId,
    resourceLabel: typeof body.resourceLabel === 'string' ? body.resourceLabel : undefined,
    entityId: provider === 'gbp' ? (body.entityId as string) : undefined,
  });
  if ('error' in result) {
    return c.json({ error: `${provider} is not connected for this account`, reason: result.error }, 409);
  }

  // E1's "GSC connected" milestone. It moved here from the old
  // `/oauth/gsc/callback`, which stamped it on token exchange — i.e. as soon as
  // a user granted consent, even though no property had been chosen and the
  // token was discarded. The milestone feeds the roadmap's time-to-first-insight
  // KPI, so it should mark the point a project can actually read search data:
  // a property assigned to it.
  if (provider === 'gsc') await markGscConnected(db, projectId);

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
  if (hasRange && provider === 'gbp') {
    // GBP has no time dimension to backfill — a location's profile is current
    // state, not a daily series. Accepting the range and ignoring it would be
    // the confusing option.
    return c.json({ error: 'gbp has no date range to sync — it reads current profile state', field: 'from' }, 400);
  }

  const db = createDb(c.env.DATABASE_URL);
  const access = await projectMemberError(c, db, projectId);
  if ('error' in access) return access.error;

  const window = hasRange ? { from: body.from as string, to: body.to as string } : undefined;

  try {
    if (provider === 'gbp') {
      const result = await syncGbp(db, access.accountId, projectId, c.env);
      if ('error' in result) {
        return c.json({ error: 'no GBP location is assigned to this project', reason: result.error }, 409);
      }
      return c.json({ synced: result });
    }

    const result =
      provider === 'gsc'
        ? await syncGsc(db, access.accountId, projectId, c.env, window)
        : await syncGa4(db, access.accountId, projectId, c.env, window);

    if ('error' in result) {
      return c.json({ error: `no ${provider} property is assigned to this project`, reason: result.error }, 409);
    }
    return c.json({ synced: result });
  } catch (err) {
    if (err instanceof ConnectionUnavailableError) return connectionErrorResponse(c, err);
    if (err instanceof GoogleApiError) {
      return c.json({ error: err.message, failure: err.failure, provider }, err.needsReauth ? 409 : 502);
    }
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
