/**
 * The Google OAuth 2.0 authorization-code flow, once, for all three providers.
 *
 * `packages/deploy/src/gbp.ts` already exchanges a refresh token for an access
 * token, but it takes the refresh token as a given — the API layer reads it
 * from a Worker secret. This module is the part that was missing: obtaining
 * that refresh token from a customer, and refreshing, inspecting and revoking
 * it afterwards.
 *
 * Every function takes an injectable `fetchImpl`, so each request shape is
 * unit-testable without a live Google Cloud OAuth client — the same seam
 * `SerperConnector` and the GBP executor use, and the reason those paths are
 * tested despite nobody having provisioned an account yet.
 */
import { GOOGLE_PROVIDERS, type GoogleProvider } from './providers.js';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

export interface GoogleOAuthClient {
  clientId: string;
  clientSecret: string;
  /** Must byte-for-byte match a redirect URI registered on the OAuth client. */
  redirectUri: string;
}

/**
 * Build the consent URL to send the browser to.
 *
 * `access_type=offline` with `prompt=consent` is what makes Google return a
 * refresh token. Without `prompt=consent` Google omits the refresh token on
 * every authorization after the first for a given user — so a customer who
 * reconnects gets an access token that works for an hour and a background sync
 * that dies silently the next day. Forcing the prompt costs one extra click and
 * removes that failure mode.
 *
 * `include_granted_scopes=true` makes a second provider's consent additive:
 * connecting GA4 after GSC yields a token carrying both scopes, instead of one
 * that silently replaces the first.
 */
export function buildConsentUrl(
  provider: GoogleProvider,
  client: GoogleOAuthClient,
  signedState: string,
  opts: { loginHint?: string } = {},
): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set('client_id', client.clientId);
  url.searchParams.set('redirect_uri', client.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  // `openid email` so the callback can record *which* Google account consented
  // and show it in the UI. A user with three Google accounts otherwise has no
  // way to tell which one is wired, which makes "why is this failing?"
  // unanswerable.
  url.searchParams.set('scope', ['openid', 'email', ...GOOGLE_PROVIDERS[provider].scopes].join(' '));
  url.searchParams.set('state', signedState);
  if (opts.loginHint) url.searchParams.set('login_hint', opts.loginHint);
  return url.toString();
}

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

export interface GoogleTokens {
  accessToken: string;
  /** Absent when Google withholds it — see `exchangeCode`'s note. */
  refreshToken?: string;
  /** Seconds until the access token expires, as Google reported it. */
  expiresIn: number;
  /** Scopes actually granted, which may be narrower than those requested. */
  grantedScopes: string[];
  /** The consenting Google account, from the id_token. Absent if `openid` was not granted. */
  googleSubject?: string;
  googleEmail?: string;
}

/**
 * Decode the `email` and `sub` claims from an id_token **without verifying it**.
 *
 * Safe here, and only here: this id_token came back over TLS on our own
 * back-channel token request to Google, in direct response to a code we just
 * sent. There is no third party in that exchange who could have substituted it.
 * Google's own documentation makes the same allowance for the code-exchange
 * response specifically.
 *
 * This is not a general-purpose id_token reader. An id_token arriving any other
 * way — from a browser, a client-side flow, another service — must have its
 * signature checked against Google's JWKS first. The narrow justification above
 * does not travel with the function, so this stays private to this module.
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
    // A malformed id_token costs us the display label, nothing more. The
    // connection is still usable, so this must not fail the whole exchange.
    return {};
  }
}

function parseTokenResponse(json: GoogleTokenResponse): GoogleTokens {
  if (!json.access_token) throw new Error('Google token response contained no access_token');
  const claims = json.id_token ? readIdTokenClaims(json.id_token) : {};
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresIn: json.expires_in ?? 3600,
    grantedScopes: json.scope ? json.scope.split(' ').filter(Boolean) : [],
    googleSubject: claims.sub,
    googleEmail: claims.email,
  };
}

async function postToken(
  body: URLSearchParams,
  fetchImpl: typeof fetch,
  context: string,
): Promise<GoogleTokens> {
  const res = await fetchImpl(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const text = await res.text();
  let json: GoogleTokenResponse;
  try {
    json = JSON.parse(text) as GoogleTokenResponse;
  } catch {
    throw new Error(`Google ${context} returned non-JSON: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    // Google's error body is the only place the actual cause appears
    // ('redirect_uri_mismatch', 'invalid_grant'), and those are exactly the two
    // failures a first-time setup hits. Propagating them saves a long guess.
    throw new Error(
      `Google ${context} failed: HTTP ${res.status} ${json.error ?? 'unknown'}${
        json.error_description ? ` — ${json.error_description}` : ''
      }`,
    );
  }
  return parseTokenResponse(json);
}

/**
 * Exchange an authorization code for tokens.
 *
 * `refreshToken` can legitimately be absent even on success: Google returns one
 * only when it decides this is a fresh grant. `buildConsentUrl` sets
 * `prompt=consent` to make that reliable, but the caller must still handle the
 * absence — storing `undefined` as a credential would produce a connection that
 * looks healthy for an hour and then cannot refresh.
 */
export async function exchangeCode(
  code: string,
  client: GoogleOAuthClient,
  fetchImpl: typeof fetch = fetch,
): Promise<GoogleTokens> {
  return postToken(
    new URLSearchParams({
      code,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uri: client.redirectUri,
      grant_type: 'authorization_code',
    }),
    fetchImpl,
    'authorization-code exchange',
  );
}

/**
 * Exchange a stored refresh token for a fresh access token.
 *
 * Note the response never carries a new refresh token — the stored one stays
 * valid until the user revokes it, so callers must not overwrite storage with
 * `undefined` from this result.
 */
export async function refreshAccessToken(
  refreshToken: string,
  client: Pick<GoogleOAuthClient, 'clientId' | 'clientSecret'>,
  fetchImpl: typeof fetch = fetch,
): Promise<GoogleTokens> {
  return postToken(
    new URLSearchParams({
      refresh_token: refreshToken,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      grant_type: 'refresh_token',
    }),
    fetchImpl,
    'refresh-token exchange',
  );
}

/**
 * True when a token error means the grant is gone for good, rather than a
 * transient failure worth retrying.
 *
 * The distinction drives what the product does: `invalid_grant` means the user
 * revoked access in their Google account, changed their password, or let the
 * grant expire, so the connection must move to 'needs_reauth' and the UI must
 * ask for a reconnect. A 500 from Google means try again later and say nothing.
 * Retrying a dead grant forever, silently, is the failure mode this prevents.
 */
export function isPermanentGrantFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('invalid_grant') || message.includes('invalid_client');
}

/**
 * Revoke a refresh token at Google, so disconnecting in our UI actually severs
 * access rather than only forgetting about it locally.
 *
 * Returns false when Google rejects the revocation — usually because the token
 * was already revoked from the user's Google account settings. The caller should
 * still delete its stored copy in that case, which is why this reports rather
 * than throws: a token Google no longer recognises must not be able to block a
 * disconnect.
 */
export async function revokeToken(token: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const res = await fetchImpl(REVOKE_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }).toString(),
  });
  return res.ok;
}
