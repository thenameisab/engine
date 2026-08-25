import { describe, it, expect } from 'vitest';
import {
  buildConsentUrl,
  exchangeCode,
  refreshAccessToken,
  revokeToken,
  isPermanentGrantFailure,
} from './oauth.js';
import { GOOGLE_PROVIDERS, hasRequiredScopes, isGoogleProvider } from './providers.js';

const CLIENT = {
  clientId: 'test-client-id.apps.googleusercontent.com',
  clientSecret: 'test-client-secret',
  redirectUri: 'https://api.example.com/oauth/google/callback',
};

/** A stub fetch that records the single request it received. */
function stubFetch(response: { status?: number; body: string }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(response.body, { status: response.status ?? 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** Build an unsigned id_token with the given claims — only the payload is read. */
function idToken(claims: Record<string, unknown>): string {
  const b64 = btoa(JSON.stringify(claims)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `header.${b64}.signature`;
}

describe('providers', () => {
  it('narrows known provider ids and rejects others', () => {
    expect(isGoogleProvider('gsc')).toBe(true);
    expect(isGoogleProvider('ga4')).toBe(true);
    expect(isGoogleProvider('gbp')).toBe(true);
    expect(isGoogleProvider('bing')).toBe(false);
  });

  it('flags GBP as needing an access request, and the read-only pair as not', () => {
    expect(GOOGLE_PROVIDERS.gbp.requiresAccessRequest).toBe(true);
    expect(GOOGLE_PROVIDERS.gsc.requiresAccessRequest).toBe(false);
    expect(GOOGLE_PROVIDERS.ga4.requiresAccessRequest).toBe(false);
  });

  it('marks GBP as the only writing provider', () => {
    expect(GOOGLE_PROVIDERS.gbp.writes).toBe(true);
    expect(GOOGLE_PROVIDERS.gsc.writes).toBe(false);
    expect(GOOGLE_PROVIDERS.ga4.writes).toBe(false);
  });

  it('requires the GA4 Admin API, not just the Data API', () => {
    expect(GOOGLE_PROVIDERS.ga4.requiredApis).toContain('Google Analytics Admin API');
  });

  it('detects a scope the user unticked on the consent screen', () => {
    expect(hasRequiredScopes('gsc', ['https://www.googleapis.com/auth/webmasters.readonly', 'openid'])).toBe(true);
    expect(hasRequiredScopes('gsc', ['openid', 'email'])).toBe(false);
    // Granting GSC does not grant GA4.
    expect(hasRequiredScopes('ga4', ['https://www.googleapis.com/auth/webmasters.readonly'])).toBe(false);
  });
});

describe('buildConsentUrl', () => {
  it('requests offline access with a forced prompt, so a refresh token is returned', () => {
    const url = new URL(buildConsentUrl('gsc', CLIENT, 'signed-state'));
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('response_type')).toBe('code');
  });

  it('carries the signed state verbatim, not a project id', () => {
    const url = new URL(buildConsentUrl('gsc', CLIENT, 'abc.def'));
    expect(url.searchParams.get('state')).toBe('abc.def');
  });

  it('asks for the provider scope plus openid/email, so the consenting account is identifiable', () => {
    const scope = new URL(buildConsentUrl('gbp', CLIENT, 's')).searchParams.get('scope')!.split(' ');
    expect(scope).toContain('openid');
    expect(scope).toContain('email');
    expect(scope).toContain('https://www.googleapis.com/auth/business.manage');
  });

  it('makes a second provider additive rather than replacing the first grant', () => {
    const url = new URL(buildConsentUrl('ga4', CLIENT, 's'));
    expect(url.searchParams.get('include_granted_scopes')).toBe('true');
  });

  it('sends the exact registered redirect_uri', () => {
    const url = new URL(buildConsentUrl('gsc', CLIENT, 's'));
    expect(url.searchParams.get('redirect_uri')).toBe(CLIENT.redirectUri);
  });

  it('omits login_hint unless asked', () => {
    expect(new URL(buildConsentUrl('gsc', CLIENT, 's')).searchParams.has('login_hint')).toBe(false);
    expect(
      new URL(buildConsentUrl('gsc', CLIENT, 's', { loginHint: 'a@b.com' })).searchParams.get('login_hint'),
    ).toBe('a@b.com');
  });
});

describe('exchangeCode', () => {
  it('posts the code with the client credentials, form-encoded', async () => {
    const { impl, calls } = stubFetch({
      body: JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3599, scope: 'openid' }),
    });
    await exchangeCode('the-code', CLIENT, impl);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://oauth2.googleapis.com/token');
    const body = new URLSearchParams(String(calls[0].init?.body));
    expect(body.get('code')).toBe('the-code');
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('client_secret')).toBe('test-client-secret');
    expect(body.get('redirect_uri')).toBe(CLIENT.redirectUri);
  });

  it('returns the tokens, granted scopes and the consenting account', async () => {
    const { impl } = stubFetch({
      body: JSON.stringify({
        access_token: 'at',
        refresh_token: 'rt',
        expires_in: 3599,
        scope: 'openid email https://www.googleapis.com/auth/webmasters.readonly',
        id_token: idToken({ sub: '11822', email: 'owner@example.com' }),
      }),
    });
    const tokens = await exchangeCode('c', CLIENT, impl);
    expect(tokens.accessToken).toBe('at');
    expect(tokens.refreshToken).toBe('rt');
    expect(tokens.expiresIn).toBe(3599);
    expect(tokens.grantedScopes).toContain('https://www.googleapis.com/auth/webmasters.readonly');
    expect(tokens.googleSubject).toBe('11822');
    expect(tokens.googleEmail).toBe('owner@example.com');
  });

  it('reports a missing refresh token rather than inventing one', async () => {
    const { impl } = stubFetch({ body: JSON.stringify({ access_token: 'at', expires_in: 3599 }) });
    const tokens = await exchangeCode('c', CLIENT, impl);
    expect(tokens.refreshToken).toBeUndefined();
  });

  it('survives a malformed id_token, losing only the display label', async () => {
    const { impl } = stubFetch({
      body: JSON.stringify({ access_token: 'at', refresh_token: 'rt', id_token: 'not-a-jwt' }),
    });
    const tokens = await exchangeCode('c', CLIENT, impl);
    expect(tokens.accessToken).toBe('at');
    expect(tokens.googleEmail).toBeUndefined();
  });

  it('surfaces redirect_uri_mismatch, the most common first-setup failure', async () => {
    const { impl } = stubFetch({
      status: 400,
      body: JSON.stringify({ error: 'redirect_uri_mismatch', error_description: 'Bad Request' }),
    });
    await expect(exchangeCode('c', CLIENT, impl)).rejects.toThrow(/redirect_uri_mismatch/);
  });

  it('reports a non-JSON error body instead of throwing a parse error', async () => {
    const { impl } = stubFetch({ status: 502, body: '<html>gateway</html>' });
    await expect(exchangeCode('c', CLIENT, impl)).rejects.toThrow(/returned non-JSON/);
  });

  it('rejects a 200 response with no access_token', async () => {
    const { impl } = stubFetch({ body: JSON.stringify({ scope: 'openid' }) });
    await expect(exchangeCode('c', CLIENT, impl)).rejects.toThrow(/no access_token/);
  });

  it('defaults expiresIn when Google omits it', async () => {
    const { impl } = stubFetch({ body: JSON.stringify({ access_token: 'at' }) });
    expect((await exchangeCode('c', CLIENT, impl)).expiresIn).toBe(3600);
  });
});

describe('refreshAccessToken', () => {
  it('posts the refresh grant without a redirect_uri', async () => {
    const { impl, calls } = stubFetch({ body: JSON.stringify({ access_token: 'fresh', expires_in: 3599 }) });
    const tokens = await refreshAccessToken('stored-rt', CLIENT, impl);
    const body = new URLSearchParams(String(calls[0].init?.body));
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('stored-rt');
    expect(body.has('redirect_uri')).toBe(false);
    expect(tokens.accessToken).toBe('fresh');
    // Google does not reissue a refresh token here; callers must not overwrite storage with this.
    expect(tokens.refreshToken).toBeUndefined();
  });

  it('surfaces invalid_grant, which means the user revoked access', async () => {
    const { impl } = stubFetch({
      status: 400,
      body: JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }),
    });
    await expect(refreshAccessToken('dead-rt', CLIENT, impl)).rejects.toThrow(/invalid_grant/);
  });
});

describe('isPermanentGrantFailure', () => {
  it('treats a revoked grant and a bad client as permanent', () => {
    expect(isPermanentGrantFailure(new Error('Google refresh-token exchange failed: HTTP 400 invalid_grant'))).toBe(true);
    expect(isPermanentGrantFailure(new Error('HTTP 401 invalid_client'))).toBe(true);
  });

  it('treats a server error and a rate limit as transient', () => {
    expect(isPermanentGrantFailure(new Error('HTTP 500 backendError'))).toBe(false);
    expect(isPermanentGrantFailure(new Error('HTTP 429 rateLimitExceeded'))).toBe(false);
  });
});

describe('revokeToken', () => {
  it('posts the token to the revoke endpoint', async () => {
    const { impl, calls } = stubFetch({ body: '' });
    expect(await revokeToken('rt', impl)).toBe(true);
    expect(calls[0].url).toBe('https://oauth2.googleapis.com/revoke');
    expect(new URLSearchParams(String(calls[0].init?.body)).get('token')).toBe('rt');
  });

  it('reports failure rather than throwing, so an already-revoked token cannot block a disconnect', async () => {
    const { impl } = stubFetch({ status: 400, body: JSON.stringify({ error: 'invalid_token' }) });
    expect(await revokeToken('already-gone', impl)).toBe(false);
  });
});
