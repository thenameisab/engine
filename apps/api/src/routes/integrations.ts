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
  verifyApiKey,
  listProviders,
  getProvider,
  assertConnectable,
  buildAuthorizationRequest,
  exchangeCode,
  validateApiKeySubmission,
  missingScopes,
  listResources,
  signAppJwt,
  fetchAppIdentity,
  fetchInstallation,
  IntegrationError,
  isIntegrationError,
  type IntegrationProvider,
  type ApiKeyCredential,
  type Keyring,
} from '@engine/integrations';
import { GoogleApiError } from '@engine/connectors';
// Importing for the side effect: this registers the Google listers against the
// seam above. Without it `listResources` would report gsc/ga4/gbp as having no
// listing implemented.
import '../repositories/googleListers.js';
import { signOAuthState, verifyOAuthState } from '@engine/auth';
import { createDb, type Db } from '../db.js';
import type { AuthEnv, AuthUser } from '../middleware/auth.js';
import { getAccountRole, upsertUser, getProjectAccountId, isAccountMember, getAccount } from '../repositories/accounts.js';
import { markGscConnected } from '../repositories/onboarding.js';
import { syncGsc, syncGa4, syncGbp } from '../repositories/googleSync.js';
import { startFlow, claimFlow, keyringFrom } from '../repositories/oauthFlows.js';
import {
  isPlatformAdmin,
  isPlatformVendor,
  listUsers,
  setPlatformRole,
  countAdmins,
  getPlatformClientStatus,
  resolveGitHubApp,
  setPlatformClient,
  clearPlatformClient,
  listPlatformEvents,
  ensureStateSecret,
} from '../repositories/platformCredentials.js';
import {
  listConnections,
  getConnection,
  upsertConnection,
  upsertAppInstallation,
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
  /**
   * Signs the OAuth `state` parameter. Optional now — one is generated and
   * stored with the platform client when this is unset. Kept as an override.
   */
  OAUTH_STATE_SECRET?: string;
  /**
   * Comma-separated emails permitted to configure Engine's own OAuth client.
   *
   * Deliberately not `ALLOWED_EMAILS`, which is who may *use* Engine: reusing
   * it would make every customer a platform administrator the moment one is
   * invited. Unset means nobody.
   */
  PLATFORM_ADMIN_EMAILS?: string;
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

/**
 * The secret that signs OAuth `state`.
 *
 * Generated and stored alongside the platform client, so nobody has to invent
 * one — it is machine randomness with no meaning outside this deployment, and
 * asking a human to choose it invites a weak value. `OAUTH_STATE_SECRET` stays
 * as an override for a deployment already configured that way, and it wins
 * because an operator who set it explicitly meant to.
 */
async function resolveStateSecret(
  env: IntegrationsEnv,
  db: Db,
  keyring: Keyring,
): Promise<string | undefined> {
  if (env.OAUTH_STATE_SECRET) return env.OAUTH_STATE_SECRET;
  try {
    return (await ensureStateSecret(db, keyring, 'google')) ?? undefined;
  } catch {
    // Unreachable database. Reported as "no secret" so the caller answers 503
    // rather than minting an unsigned state.
    return undefined;
  }
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
  // A missing or unusable keyring is not an error here — it means nothing can
  // be connected, which is exactly what a `false` here says.
  const keyring = await keyringFrom(c.env).catch(() => undefined);
  const googleReady = Boolean(gsc && keyring && (await clientFor(gsc, c.env, db, keyring)));
  const githubReady = Boolean(keyring && (await resolveGitHubApp(db, keyring).catch(() => null)));
  return c.json({
    connections: await listConnections(db, accountId),
    // Per vendor, because "is Engine's own identity registered" now has more
    // than one answer. This route's previous comment predicted the day a
    // second vendor arrived; the GitHub App is it. A deployment can have
    // Google set up and GitHub not, and one boolean would tell a customer the
    // wrong thing about one of them.
    vendorsConfigured: { google: googleReady, github: githubReady },
    // Kept so a dashboard build that predates the field still works: a Pages
    // deploy and a Worker deploy never land in the same instant.
    oauthConfigured: googleReady,
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
/**
 * Step 1 for a GitHub App: the install link.
 *
 * The customer is sent to GitHub's install screen rather than a consent
 * screen, and chooses there which repositories Engine may touch. What comes
 * back is an installation id — an identifier, not a credential — so this
 * stores no verifier and there is nothing to exchange. The signed state still
 * rides along, and the flow row is still written, because replay protection is
 * the part that matters either way.
 *
 * The App slug is read from GitHub instead of stored: an administrator who
 * renames the App would otherwise leave every customer a link that 404s, and
 * the App is the authority on its own name.
 */
async function githubInstallUrl(
  c: Context<Env>,
  provider: IntegrationProvider,
  accountId: string,
) {
  if (provider.auth.kind !== 'github_app') {
    return c.json({ error: `${provider.name} is not installed as an app`, field: 'provider' }, 400);
  }

  let keyring;
  try {
    keyring = await keyringFrom(c.env);
  } catch {
    return c.json({ error: 'ENCRYPTION_KEY (or ENCRYPTION_KEYS) is not configured — cannot start a connection' }, 503);
  }
  const db = createDb(c.env.DATABASE_URL);

  const app = await resolveGitHubApp(db, keyring);
  if (!app) {
    return c.json(
      {
        error: 'Engine’s GitHub App has not been configured. An administrator sets it once under Settings → Platform.',
        reason: 'platform-client-missing',
      },
      503,
    );
  }

  const stateSecret = await resolveStateSecret(c.env, db, keyring);
  if (!stateSecret) {
    return c.json(
      { error: 'Could not obtain a signing secret for the connection link.', reason: 'state-secret-unavailable' },
      503,
    );
  }

  const guard = await requireOwner(c, db, accountId);
  if ('error' in guard) return guard.error;

  const body = (await c.req.json<{ returnTo?: string }>().catch(() => ({}))) as { returnTo?: string };
  const userId = c.get('user').id;

  let slug: string;
  try {
    const jwt = await signAppJwt(app.appId, app.privateKeyPem);
    slug = (await fetchAppIdentity(provider.auth.apiBaseUrl, jwt)).slug;
  } catch (err) {
    // An App id that does not match its private key fails here, before the
    // customer is sent anywhere — which is the whole point of checking every
    // precondition in step 1.
    const message = isIntegrationError(err) && err.reason === 'not_configured'
      ? 'Engine’s GitHub App credentials are not valid. An administrator should re-enter them under Settings → Platform.'
      : `GitHub could not be reached: ${(err as Error).message}`;
    return c.json({ error: message, reason: 'platform-client-invalid' }, 503);
  }

  const state = await signOAuthState(
    { accountId, userId, provider: provider.id, returnTo: body.returnTo },
    stateSecret,
  );
  const verified = await verifyOAuthState(state, stateSecret);
  /* c8 ignore next -- we just signed it with the same secret. */
  if (!verified.ok) return c.json({ error: 'could not mint a connection link' }, 500);

  await startFlow(db, keyring, {
    nonce: verified.claims.nonce,
    accountId,
    provider: provider.id,
    userId,
    returnTo: body.returnTo,
  });
  await recordEvent(db, {
    accountId,
    provider: provider.id,
    type: 'connect_started',
    actor: { kind: 'user', userId },
  });

  const url = new URL(provider.auth.installUrlTemplate.replace('{slug}', slug));
  url.searchParams.set('state', state);
  return c.json({ url: url.toString(), provider: provider.id });
}

integrationsRoutes.post('/accounts/:accountId/integrations/:provider/connect-url', async (c) => {
  const accountId = c.req.param('accountId');
  if (!UUID_RE.test(accountId)) return c.json({ error: 'accountId must be a uuid', field: 'accountId' }, 400);
  const provider = readProvider(c);
  if (!provider) return c.json({ error: 'unknown provider', field: 'provider' }, 400);

  // A GitHub App is installed, not consented to: the customer goes to
  // GitHub's own install screen, picks an account and the repositories to
  // grant, and comes back with an installation id. Same signed single-use
  // state, no code exchange. Handled in its own function so the OAuth path
  // below stays exactly as it was.
  if (provider.auth.kind === 'github_app') {
    return githubInstallUrl(c, provider, accountId);
  }

  if (provider.auth.kind !== 'oauth2') {
    return c.json(
      { error: `${provider.name} is connected with an API key, not a consent flow`, field: 'provider' },
      400,
    );
  }

  let keyring;
  try {
    keyring = await keyringFrom(c.env);
  } catch {
    return c.json({ error: 'ENCRYPTION_KEY (or ENCRYPTION_KEYS) is not configured — cannot store a credential' }, 503);
  }

  const db = createDb(c.env.DATABASE_URL);

  // Deployment configuration is resolved before the membership check, and the
  // order is deliberate. `clientFor` and `resolveStateSecret` both swallow a
  // database failure and report "not configured"; `requireOwner` throws. Put
  // the throwing call first and an unreachable database turns a deployment
  // that was never configured into a 500, which tells the operator nothing.
  //
  // The old version answered 503 without touching the database at all. That is
  // no longer possible — Engine's OAuth client now lives in a table, which is
  // the entire point of the change — but a 503 naming the real cause is.
  const client = await clientFor(provider, c.env, db, keyring);
  if (!client) {
    return c.json(
      {
        error:
          'Engine’s OAuth client has not been configured. An administrator sets it once under Settings → Platform.',
        reason: 'platform-client-missing',
      },
      503,
    );
  }

  const stateSecret = await resolveStateSecret(c.env, db, keyring);
  if (!stateSecret) {
    return c.json(
      { error: 'Could not obtain a signing secret for the consent link.', reason: 'state-secret-unavailable' },
      503,
    );
  }

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
    stateSecret,
  );
  const verified = await verifyOAuthState(state, stateSecret);
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

  // Prove the key works before storing it. A rejected key is a 400 the form
  // shows inline; a vendor outage is a 502 that asks for a retry, because the
  // key may be fine.
  let verified = false;
  try {
    ({ verified } = await verifyApiKey(provider, credential));
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
  return c.json({ connection, verified });
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

  // The database is needed before the state can be checked now, because the
  // signing secret lives there. Built early and reused below.
  const db = createDb(c.env.DATABASE_URL);
  let keyring;
  try {
    keyring = await keyringFrom(c.env);
  } catch {
    return callbackPage(c, 'error', 'ENCRYPTION_KEY is not configured — the credential cannot be stored.');
  }
  const stateSecret = await resolveStateSecret(c.env, db, keyring);

  const verified = await verifyOAuthState(state, stateSecret);
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

  const client = await clientFor(provider, c.env, db, keyring);
  if (!client) return callbackPage(c, 'error', 'Engine’s OAuth client is not configured on this deployment.');

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
 * The GitHub App's setup callback.
 *
 * Not behind `requireAuth`, for the same reason the Google callback is not: a
 * browser arriving from GitHub's install screen carries no Authorization
 * header. The signed, single-use `state` is what authenticates it.
 *
 * GitHub sends `installation_id` and `setup_action` rather than a code. There
 * is nothing to exchange and nothing secret to store — the installation id is
 * an identifier, useless without Engine's App private key — so this writes the
 * connection with no credential row at all. That is the honest shape: a
 * GitHub App connection has no per-customer secret, and inventing a sealed
 * blob to fill a column would say otherwise.
 */
integrationsRoutes.get('/github/setup/callback', async (c) => {
  const setupAction = c.req.query('setup_action');
  const installationId = c.req.query('installation_id');
  const state = c.req.query('state');

  if (!state) return callbackPage(c, 'error', 'The redirect from GitHub was missing its state.');
  if (!installationId) {
    // Reached by "Cancel" on the install screen, and by GitHub's own link to
    // the App's page — neither is our failure to report as one.
    return callbackPage(c, 'cancelled', 'No repositories were connected.');
  }

  const db = createDb(c.env.DATABASE_URL);
  let keyring;
  try {
    keyring = await keyringFrom(c.env);
  } catch {
    return callbackPage(c, 'error', 'ENCRYPTION_KEY is not configured on this deployment.');
  }
  const stateSecret = await resolveStateSecret(c.env, db, keyring);

  const verified = await verifyOAuthState(state, stateSecret);
  if (!verified.ok) {
    const message =
      verified.reason === 'expired'
        ? 'This connection link expired. Start again from the Integrations screen.'
        : verified.reason === 'unconfigured'
          ? 'Connection-link signing is not configured on this deployment.'
          : 'This connection link was not valid.';
    return callbackPage(c, verified.reason === 'expired' ? 'expired' : 'error', message);
  }

  const { accountId, userId, provider: providerId, nonce } = verified.claims;
  let provider: IntegrationProvider;
  try {
    provider = assertConnectable(providerId);
  } catch {
    return callbackPage(c, 'error', 'Unknown provider in the connection link.');
  }
  if (provider.auth.kind !== 'github_app') {
    return callbackPage(c, 'error', 'Unknown provider in the connection link.');
  }

  const app = await resolveGitHubApp(db, keyring);
  if (!app) return callbackPage(c, 'error', 'Engine’s GitHub App is not configured on this deployment.');

  // Claim before anything else, so a replayed callback stops here.
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

  // Name the connection after the account that installed it, and prove in the
  // same call that the installation really is ours to use — a fabricated
  // `installation_id` in the query string fails here rather than being stored.
  let login: string;
  try {
    const jwt = await signAppJwt(app.appId, app.privateKeyPem);
    login = (await fetchInstallation(provider.auth.apiBaseUrl, jwt, installationId)).login;
  } catch (err) {
    await recordEvent(db, {
      accountId,
      provider: providerId,
      type: 'connect_failed',
      actor: { kind: 'user', userId },
      reason: 'vendor_error',
    });
    return callbackPage(c, 'error', `GitHub did not recognise that installation: ${(err as Error).message}`);
  }

  await upsertAppInstallation(db, {
    accountId,
    provider: providerId,
    installationId,
    label: login,
    connectedBy: userId,
  });
  await recordEvent(db, {
    accountId,
    provider: providerId,
    type: 'connected',
    actor: { kind: 'user', userId },
    metadata: { kind: 'github_app', account: login },
  });

  return callbackPage(
    c,
    'connected',
    setupAction === 'update'
      ? `Updated which of ${login}’s repositories Engine can open pull requests in.`
      : `Connected ${login}. Engine can open pull requests in the repositories you chose.`,
    claim.returnTo,
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
    // A GitHub App installation token is a bearer token like an OAuth one, so
    // it rides the same field; `getAccessToken` knows how to produce each.
    if (provider.auth.kind === 'oauth2' || provider.auth.kind === 'github_app') {
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

  const [assignments, connections, account] = await Promise.all([
    listAssignments(db, projectId),
    listConnections(db, access.accountId),
    getAccount(db, access.accountId),
  ]);
  // The client these connections belong to, by name. The screen scopes its
  // copy to it, so a connection made under another client cannot read as a
  // credential failure here.
  return c.json({
    assignments,
    connections,
    account: account ? { id: account.id, name: account.name } : { id: access.accountId, name: null },
  });
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

/* ── Platform administration ────────────────────────────────────────────── */

/**
 * Engine's own OAuth client, configured in the product.
 *
 * These routes exist because the previous answer to "how do I connect Google?"
 * was five `wrangler secret put` commands. That is a one-time operator task,
 * not a deployment detail, and pushing it into a terminal made the Integrations
 * screen look broken to everyone who could not reach one.
 *
 * A customer must never see any of this. The gate is `PLATFORM_ADMIN_EMAILS`,
 * checked on every route rather than once at a parent — a guard that is applied
 * in three of four handlers is not a guard.
 */
async function requirePlatformAdmin(c: Context<Env>, db: Db): Promise<{ error: Response } | { ok: true }> {
  const user = c.get('user');
  let admin = false;
  try {
    admin = await isPlatformAdmin(db, user, c.env);
  } catch {
    // An unreachable database denies rather than allows. The alternative — fall
    // back to the bootstrap list when the role cannot be read — would let a
    // demoted admin back in whenever the database hiccupped.
    admin = false;
  }
  if (!admin) {
    // 404, not 403. A 403 confirms the screen exists and that this deployment
    // has administrators, to someone who by definition is not one.
    return { error: c.json({ error: 'not found' }, 404) };
  }
  return { ok: true };
}

/**
 * Whether the caller may see the platform screen at all.
 *
 * Answered for every signed-in user, because the dashboard has to decide
 * whether to render the nav entry. It reveals only whether *you* are an
 * administrator, which you already know.
 */
integrationsRoutes.get('/platform/access', async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  try {
    return c.json({ isAdmin: await isPlatformAdmin(db, c.get('user'), c.env) });
  } catch {
    // The nav entry simply does not render. Reporting an error here would put
    // a red banner on every screen for a failure the customer cannot act on.
    return c.json({ isAdmin: false });
  }
});

/** What is configured, and the redirect URI to register with the vendor. */
integrationsRoutes.get('/platform/oauth-clients/:vendor', async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  const guard = await requirePlatformAdmin(c, db);
  if ('error' in guard) return guard.error;
  const vendor = c.req.param('vendor');
  if (!isPlatformVendor(vendor)) return c.json({ error: 'unknown vendor', field: 'vendor' }, 400);

  const stored = await getPlatformClientStatus(db, vendor);

  // The URI the operator must register with the vendor, derived from this
  // request rather than typed by hand — a mistyped redirect URI is the single
  // most common setup failure, and the vendor compares it byte for byte.
  // Per vendor: Google returns to the consent callback, GitHub to the App's
  // setup callback. Suggesting the wrong one produces a mismatch the vendor
  // reports only at the moment a customer tries to connect.
  const callbackPath = vendor === 'github' ? '/github/setup/callback' : '/oauth/google/callback';
  const suggestedRedirectUri = new URL(callbackPath, new URL(c.req.url).origin).toString();

  return c.json({
    vendor,
    client: stored,
    suggestedRedirectUri,
    // True when the deployment is still configured the old way. Surfaced so
    // the screen can say "configured by environment variable" instead of
    // "not configured", which would be wrong and alarming.
    configuredByEnvironment: Boolean(
      !stored && c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET && c.env.GOOGLE_REDIRECT_URI,
    ),
    events: await listPlatformEvents(db, 20),
  });
});

/** Set or rotate Engine's client for a vendor. */
integrationsRoutes.put('/platform/oauth-clients/:vendor', async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  const guard = await requirePlatformAdmin(c, db);
  if ('error' in guard) return guard.error;
  const vendor = c.req.param('vendor');
  if (!isPlatformVendor(vendor)) return c.json({ error: 'unknown vendor', field: 'vendor' }, 400);

  let keyring;
  try {
    keyring = await keyringFrom(c.env);
  } catch {
    return c.json({ error: 'ENCRYPTION_KEY is not configured — the client secret cannot be stored' }, 503);
  }

  const raw = await c.req.json<unknown>().catch(() => null);
  if (raw === null || typeof raw !== 'object') return c.json({ error: 'body is not valid JSON' }, 400);
  const body = raw as { clientId?: unknown; clientSecret?: unknown; redirectUri?: unknown };


  if (typeof body.clientId !== 'string' || body.clientId.trim() === '') {
    return c.json({ error: 'clientId is required', field: 'clientId' }, 400);
  }
  if (typeof body.clientSecret !== 'string' || body.clientSecret.trim() === '') {
    return c.json({ error: 'clientSecret is required', field: 'clientSecret' }, 400);
  }
  if (typeof body.redirectUri !== 'string' || !/^https:\/\/[^\s]+$/.test(body.redirectUri.trim())) {
    // https only. An OAuth redirect carries an authorization code, and a
    // vendor will refuse a plaintext URI anyway — better to say so here than
    // to store a value that fails at consent time.
    return c.json({ error: 'redirectUri must be an https URL', field: 'redirectUri' }, 400);
  }

  const user = c.get('user');
  await upsertUser(db, user);

  const status = await setPlatformClient(db, keyring, {
    vendor,
    clientId: body.clientId.trim(),
    clientSecret: body.clientSecret.trim(),
    redirectUri: body.redirectUri.trim(),
    actorUserId: user.id,
  });
  return c.json({ client: status });
});

/** Remove Engine's client. Customers' stored grants are left in place. */
integrationsRoutes.delete('/platform/oauth-clients/:vendor', async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  const guard = await requirePlatformAdmin(c, db);
  if ('error' in guard) return guard.error;
  const vendor = c.req.param('vendor');
  if (!isPlatformVendor(vendor)) return c.json({ error: 'unknown vendor', field: 'vendor' }, 400);

  const user = c.get('user');
  await upsertUser(db, user);
  const removed = await clearPlatformClient(db, vendor, user.id);
  if (!removed) return c.json({ error: `${vendor} is not configured`, vendor }, 404);
  return c.json({ cleared: true, vendor });
});

/* ── Users and platform roles ───────────────────────────────────────────── */

/**
 * Who exists, and what kind of person each one is.
 *
 * Admin-only, and it returns email addresses — the whole user list of the
 * deployment. That is exactly what a support person needs and exactly what a
 * customer must never see.
 */
integrationsRoutes.get('/platform/users', async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  const guard = await requirePlatformAdmin(c, db);
  if ('error' in guard) return guard.error;

  return c.json({ users: await listUsers(db), adminCount: await countAdmins(db) });
});

/**
 * Promote or demote someone.
 *
 * The two refusals live in the repository, in one transaction with the read
 * that justifies them: an admin cannot demote themselves, and the last admin
 * cannot be demoted at all. Both prevent a deployment nobody can administer
 * without direct database access.
 */
integrationsRoutes.put('/platform/users/:userId/role', async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  const guard = await requirePlatformAdmin(c, db);
  if ('error' in guard) return guard.error;

  const subjectUserId = c.req.param('userId');
  const raw = await c.req.json<unknown>().catch(() => null);
  if (raw === null || typeof raw !== 'object') return c.json({ error: 'body is not valid JSON' }, 400);
  const role = (raw as { role?: unknown }).role;
  if (role !== 'admin' && role !== 'user') {
    return c.json({ error: "role must be 'admin' or 'user'", field: 'role' }, 400);
  }

  const actor = c.get('user');
  await upsertUser(db, actor);
  const result = await setPlatformRole(db, subjectUserId, role, actor.id);
  if (!result.ok) {
    const message =
      result.reason === 'self'
        ? 'You cannot remove your own admin access. Ask another admin to do it.'
        : result.reason === 'last-admin'
          ? 'This is the only admin. Promote someone else first.'
          : 'That user does not exist.';
    return c.json({ error: message, reason: result.reason }, result.reason === 'not-found' ? 404 : 409);
  }
  return c.json({ userId: subjectUserId, from: result.from, to: result.to });
});
