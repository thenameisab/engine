/**
 * The OAuth 2.0 authorization-code flow, once, for every vendor.
 *
 * This is the Google flow from `@engine/connectors` with the Google taken out.
 * Endpoints, client-authentication style, refresh-token rotation behaviour and
 * per-vendor authorization parameters are all read from the provider row, so
 * the second OAuth vendor is a registry entry rather than a second copy of
 * this file — which is what the Google-shaped original would have forced.
 *
 * Two things are deliberately not configurable, because a vendor that needs
 * them turned off is a vendor whose integration should be reviewed by a person:
 * PKCE is always sent, and the token endpoint is never allowed to redirect.
 */
import type { OAuth2Auth, IntegrationProvider } from './types.js';
import { IntegrationError } from './errors.js';
import { vendorFetch, parseJson, type HttpOptions } from './http.js';
import { createPkcePair, type PkcePair } from './pkce.js';

export interface OAuthClientCredentials {
  clientId: string;
  clientSecret: string;
  /** Must byte-for-byte match a redirect URI registered with the vendor. */
  redirectUri: string;
}

export interface AuthorizationRequest {
  url: string;
  /** Store this against the flow; it is required to exchange the code. */
  pkce: PkcePair;
}

export interface OAuthTokens {
  accessToken: string;
  /**
   * Absent is legitimate on both operations, for different reasons: on
   * exchange the vendor may withhold it on a repeat grant, and on refresh a
   * non-rotating vendor simply does not send one. `rotatesRefreshToken` on the
   * provider is what tells the caller which absence is a problem.
   */
  refreshToken?: string;
  /** Seconds until the access token expires, as the vendor reported it. */
  expiresIn: number;
  /** Scopes actually granted, which may be narrower than those requested. */
  grantedScopes: string[];
  /** Stable vendor-side id of the consenting account, when discoverable. */
  externalSubject?: string;
  /** Human label for that account — an email or portal name. Display only. */
  externalLabel?: string;
}

function oauth(provider: IntegrationProvider): OAuth2Auth {
  if (provider.auth.kind !== 'oauth2') {
    throw new IntegrationError('invalid_request', `${provider.id} is not an OAuth provider`, {
      providerId: provider.id,
    });
  }
  return provider.auth;
}

/**
 * Build the consent URL, and the PKCE pair whose verifier the caller must keep.
 *
 * `state` is minted by the caller (`@engine/auth`'s signed state), not here:
 * this module knows about vendors, and what a state has to prove is an
 * application concern — which account, which user, where to return.
 */
export async function buildAuthorizationRequest(
  provider: IntegrationProvider,
  client: OAuthClientCredentials,
  signedState: string,
  opts: { loginHint?: string } = {},
): Promise<AuthorizationRequest> {
  const auth = oauth(provider);
  const pkce = await createPkcePair();

  const url = new URL(auth.authorizationUrl);
  url.searchParams.set('client_id', client.clientId);
  url.searchParams.set('redirect_uri', client.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scopeString(provider));
  url.searchParams.set('state', signedState);
  url.searchParams.set('code_challenge', pkce.challenge);
  url.searchParams.set('code_challenge_method', pkce.method);
  for (const [k, v] of Object.entries(auth.authorizationParams ?? {})) url.searchParams.set(k, v);
  if (opts.loginHint) url.searchParams.set('login_hint', opts.loginHint);

  return { url: url.toString(), pkce };
}

/**
 * The scope string sent at consent.
 *
 * `openid email` is prepended for any provider asking for them, so the
 * callback can record *which* vendor account consented. A customer with three
 * Google accounts otherwise has no way to tell which one is wired, and "why is
 * this failing?" becomes unanswerable.
 */
function scopeString(provider: IntegrationProvider): string {
  const auth = oauth(provider);
  const all = [...auth.scopes, ...(auth.optionalScopes ?? [])];
  return [...new Set(all)].join(' ');
}

interface TokenResponseBody {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

function headersFor(auth: OAuth2Auth, client: OAuthClientCredentials): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (auth.clientAuth === 'client_secret_basic') {
    headers.authorization = `Basic ${btoa(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`)}`;
  }
  return headers;
}

function bodyFor(auth: OAuth2Auth, client: OAuthClientCredentials, params: URLSearchParams): URLSearchParams {
  if (auth.clientAuth === 'client_secret_post') {
    params.set('client_id', client.clientId);
    params.set('client_secret', client.clientSecret);
  } else {
    // Basic carries the secret; the id is still required in the body by
    // several vendors and harmless to the rest.
    params.set('client_id', client.clientId);
  }
  return params;
}

/**
 * Map a token-endpoint failure onto a reason a caller can act on.
 *
 * `invalid_grant` is the load-bearing one: it means the grant is gone — the
 * customer revoked access, changed their password, or it expired — and the
 * only fix is a reconnect. Treating it as a transient error produces a sync
 * that retries a dead credential forever and never tells anyone.
 */
function tokenError(provider: IntegrationProvider, status: number, body: TokenResponseBody, raw: string): never {
  const code = body.error ?? '';
  const detail = body.error_description ? ` — ${body.error_description}` : '';
  const message = `${provider.name} token request failed: HTTP ${status} ${code || raw.slice(0, 200)}${detail}`;

  if (code === 'invalid_grant') {
    throw new IntegrationError('grant_revoked', message, { providerId: provider.id, status });
  }
  if (code === 'invalid_client' || code === 'unauthorized_client') {
    throw new IntegrationError('not_configured', message, { providerId: provider.id, status });
  }
  if (code === 'invalid_scope') {
    throw new IntegrationError('insufficient_scope', message, { providerId: provider.id, status });
  }
  if (status === 429) {
    throw new IntegrationError('rate_limited', message, { providerId: provider.id, status });
  }
  throw new IntegrationError(status >= 500 ? 'vendor_error' : 'invalid_credentials', message, {
    providerId: provider.id,
    status,
  });
}

async function postToken(
  provider: IntegrationProvider,
  client: OAuthClientCredentials,
  params: URLSearchParams,
  http: HttpOptions,
): Promise<OAuthTokens> {
  const auth = oauth(provider);
  const res = await vendorFetch(
    auth.tokenUrl,
    { method: 'POST', headers: headersFor(auth, client), body: bodyFor(auth, client, params).toString() },
    { ...http, providerId: provider.id },
  );
  const body = parseJson<TokenResponseBody>(res, `${provider.name} token request`, provider.id);
  if (!res.ok) tokenError(provider, res.status, body, res.text);
  if (!body.access_token) {
    throw new IntegrationError('invalid_response', `${provider.name} token response contained no access_token`, {
      providerId: provider.id,
      status: res.status,
    });
  }

  const claims = body.id_token ? readIdTokenClaims(body.id_token) : {};
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresIn: body.expires_in ?? 3600,
    grantedScopes: body.scope ? body.scope.split(' ').filter(Boolean) : [],
    externalSubject: claims.sub,
    externalLabel: claims.email,
  };
}

/**
 * Exchange an authorization code, proving possession of the PKCE verifier.
 */
export async function exchangeCode(
  provider: IntegrationProvider,
  client: OAuthClientCredentials,
  code: string,
  codeVerifier: string,
  http: HttpOptions = {},
): Promise<OAuthTokens> {
  return postToken(
    provider,
    client,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: client.redirectUri,
      code_verifier: codeVerifier,
    }),
    http,
  );
}

/**
 * Exchange a stored refresh token for a fresh access token.
 *
 * The caller must consult `rotatesRefreshToken` before writing the result
 * back: for a non-rotating vendor the absence of a refresh token here is
 * normal, and storing that absence destroys a working connection.
 */
export async function refreshAccessToken(
  provider: IntegrationProvider,
  client: OAuthClientCredentials,
  refreshToken: string,
  http: HttpOptions = {},
): Promise<OAuthTokens> {
  return postToken(
    provider,
    client,
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    http,
  );
}

/**
 * Sever the grant at the vendor.
 *
 * Reports rather than throws, and distinguishes "no endpoint exists" from
 * "the vendor refused": a disconnect must always be able to complete locally,
 * and a token the vendor no longer recognises must not be able to block one.
 * The UI says which happened, because "disconnected" and "disconnected, and
 * access revoked at the vendor" are different promises.
 */
export async function revokeToken(
  provider: IntegrationProvider,
  client: OAuthClientCredentials,
  token: string,
  http: HttpOptions = {},
): Promise<{ revoked: boolean; supported: boolean }> {
  const auth = oauth(provider);
  if (!auth.revocationUrl) return { revoked: false, supported: false };
  try {
    const res = await vendorFetch(
      auth.revocationUrl,
      {
        method: 'POST',
        headers: headersFor(auth, client),
        body: bodyFor(auth, client, new URLSearchParams({ token })).toString(),
      },
      { ...http, providerId: provider.id, maxRetries: 0 },
    );
    return { revoked: res.ok, supported: true };
  } catch {
    return { revoked: false, supported: true };
  }
}

/**
 * Scopes this integration needs but was not granted.
 *
 * Worth checking rather than assuming: a user can untick a scope on the
 * consent screen and the vendor still returns a perfectly valid token. Caught
 * here, it becomes "reconnect and accept the Analytics permission"; missed, it
 * becomes a 403 hours later with nothing pointing at the cause.
 */
export function missingScopes(provider: IntegrationProvider, granted: readonly string[]): string[] {
  const auth = oauth(provider);
  const have = new Set(granted);
  return auth.scopes.filter((s) => !have.has(s));
}

/**
 * Read `sub` and `email` from an id_token **without verifying the signature**.
 *
 * Safe here and only here: this id_token arrived over TLS on our own
 * back-channel token request, in direct response to a code we just sent. There
 * is no third party in that exchange who could substitute it, and the OpenID
 * Connect core spec makes this exact allowance for the token-endpoint
 * response. An id_token arriving any other way must have its signature checked
 * against the issuer's JWKS first, which is why this stays private to this
 * module rather than being exported as a general-purpose reader.
 */
function readIdTokenClaims(idToken: string): { sub?: string; email?: string } {
  const parts = idToken.split('.');
  if (parts.length !== 3) return {};
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const claims = JSON.parse(json) as { sub?: string; email?: string };
    return { sub: claims.sub, email: claims.email };
  } catch {
    // Costs the display label, nothing more. The connection is still usable,
    // so this must not fail the exchange.
    return {};
  }
}
