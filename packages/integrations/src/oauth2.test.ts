import { describe, it, expect } from 'vitest';
import {
  buildAuthorizationRequest,
  exchangeCode,
  refreshAccessToken,
  revokeToken,
  missingScopes,
} from './oauth2.js';
import { getProvider } from './registry.js';
import { challengeFor } from './pkce.js';
import { IntegrationError } from './errors.js';
import type { IntegrationProvider } from './types.js';

const CLIENT = {
  clientId: 'client-abc.apps.googleusercontent.com',
  clientSecret: 'GOCSPX-supersecret',
  redirectUri: 'https://api.example.com/oauth/google/callback',
};

const gsc = getProvider('gsc') as IntegrationProvider;
const gbp = getProvider('gbp') as IntegrationProvider;
const hubspot = getProvider('hubspot') as IntegrationProvider;

function stub(body: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const http = (impl: typeof fetch) => ({ fetchImpl: impl, sleep: async () => undefined, maxRetries: 0 });

describe('buildAuthorizationRequest', () => {
  it('always sends an S256 PKCE challenge matching the returned verifier', async () => {
    const req = await buildAuthorizationRequest(gsc, CLIENT, 'signed.state');
    const url = new URL(req.url);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(await challengeFor(req.pkce.verifier));
    // The verifier itself must never travel to the authorization endpoint.
    expect(req.url).not.toContain(req.pkce.verifier);
  });

  it('carries the vendor quirks from the registry rather than from shared code', async () => {
    const url = new URL((await buildAuthorizationRequest(gsc, CLIENT, 's')).url);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('include_granted_scopes')).toBe('true');
  });

  it('omits Google-only parameters for a non-Google vendor', async () => {
    const url = new URL((await buildAuthorizationRequest(hubspot, CLIENT, 's')).url);
    expect(url.searchParams.get('access_type')).toBeNull();
    expect(url.searchParams.get('prompt')).toBeNull();
    expect(url.origin + url.pathname).toBe('https://app.hubspot.com/oauth/authorize');
  });

  it('requests the declared scopes plus the identity scopes, without duplicates', async () => {
    const url = new URL((await buildAuthorizationRequest(gsc, CLIENT, 's')).url);
    const scopes = (url.searchParams.get('scope') ?? '').split(' ');
    expect(scopes).toContain('https://www.googleapis.com/auth/webmasters.readonly');
    expect(scopes).toContain('openid');
    expect(new Set(scopes).size).toBe(scopes.length);
  });

  it('generates a different verifier for every flow', async () => {
    const a = await buildAuthorizationRequest(gsc, CLIENT, 's');
    const b = await buildAuthorizationRequest(gsc, CLIENT, 's');
    expect(a.pkce.verifier).not.toBe(b.pkce.verifier);
  });

  it('refuses an API-key provider', async () => {
    const cloudflare = getProvider('cloudflare') as IntegrationProvider;
    await expect(buildAuthorizationRequest(cloudflare, CLIENT, 's')).rejects.toThrow(/not an OAuth provider/);
  });
});

describe('exchangeCode', () => {
  it('sends the verifier and the registered redirect URI', async () => {
    const { impl, calls } = stub({ access_token: 'at', refresh_token: 'rt', expires_in: 3599, scope: 'a b' });
    await exchangeCode(gsc, CLIENT, 'the-code', 'v'.repeat(43), http(impl));
    const body = new URLSearchParams(calls[0].init.body as string);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('the-code');
    expect(body.get('code_verifier')).toBe('v'.repeat(43));
    expect(body.get('redirect_uri')).toBe(CLIENT.redirectUri);
  });

  it('reads the granted scopes and the consenting account from the id_token', async () => {
    const claims = btoa(JSON.stringify({ sub: '1234', email: 'owner@example.com' }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const { impl } = stub({
      access_token: 'at',
      refresh_token: 'rt',
      expires_in: 3599,
      scope: 'openid email https://www.googleapis.com/auth/webmasters.readonly',
      id_token: `header.${claims}.sig`,
    });
    const tokens = await exchangeCode(gsc, CLIENT, 'c', 'v'.repeat(43), http(impl));
    expect(tokens.externalSubject).toBe('1234');
    expect(tokens.externalLabel).toBe('owner@example.com');
    expect(tokens.grantedScopes).toContain('https://www.googleapis.com/auth/webmasters.readonly');
  });

  it('survives a malformed id_token — it costs the label, not the connection', async () => {
    const { impl } = stub({ access_token: 'at', refresh_token: 'rt', id_token: 'not.a.jwt' });
    const tokens = await exchangeCode(gsc, CLIENT, 'c', 'v'.repeat(43), http(impl));
    expect(tokens.accessToken).toBe('at');
    expect(tokens.externalSubject).toBeUndefined();
  });

  it('uses client_secret_post for Google', async () => {
    const { impl, calls } = stub({ access_token: 'at' });
    await exchangeCode(gsc, CLIENT, 'c', 'v'.repeat(43), http(impl));
    const body = new URLSearchParams(calls[0].init.body as string);
    expect(body.get('client_secret')).toBe(CLIENT.clientSecret);
    expect((calls[0].init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('maps invalid_grant to grant_revoked, which is the reconnect signal', async () => {
    const { impl } = stub({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400);
    try {
      await exchangeCode(gsc, CLIENT, 'c', 'v'.repeat(43), http(impl));
      expect.unreachable('should have thrown');
    } catch (e) {
      const err = e as IntegrationError;
      expect(err.reason).toBe('grant_revoked');
      expect(err.needsReauth).toBe(true);
      expect(err.retryable).toBe(false);
    }
  });

  it('maps invalid_client to not_configured, which is an operator problem', async () => {
    const { impl } = stub({ error: 'invalid_client' }, 401);
    await expect(exchangeCode(gsc, CLIENT, 'c', 'v'.repeat(43), http(impl))).rejects.toMatchObject({
      reason: 'not_configured',
    });
  });

  it('never puts the client secret into the error, even when the vendor echoes it', async () => {
    const { impl } = stub({ error: 'invalid_request', error_description: `bad client_secret=${CLIENT.clientSecret}` }, 400);
    try {
      await exchangeCode(gsc, CLIENT, 'c', 'v'.repeat(43), http(impl));
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as Error).message).not.toContain(CLIENT.clientSecret);
    }
  });

  it('rejects a 200 response that carries no access token', async () => {
    const { impl } = stub({ expires_in: 3599 });
    await expect(exchangeCode(gsc, CLIENT, 'c', 'v'.repeat(43), http(impl))).rejects.toMatchObject({
      reason: 'invalid_response',
    });
  });
});

describe('refreshAccessToken', () => {
  it('posts the stored refresh token', async () => {
    const { impl, calls } = stub({ access_token: 'fresh', expires_in: 3599 });
    const tokens = await refreshAccessToken(gsc, CLIENT, 'stored-rt', http(impl));
    const body = new URLSearchParams(calls[0].init.body as string);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('stored-rt');
    expect(tokens.accessToken).toBe('fresh');
  });

  it('reports the absent refresh token for a non-rotating vendor without inventing one', async () => {
    // Google does not return one on refresh. The caller consults
    // rotatesRefreshToken; storing this undefined would break the connection.
    const { impl } = stub({ access_token: 'fresh', expires_in: 3599 });
    const tokens = await refreshAccessToken(gsc, CLIENT, 'stored-rt', http(impl));
    expect(tokens.refreshToken).toBeUndefined();
    expect(gsc.auth.kind === 'oauth2' && gsc.auth.rotatesRefreshToken).toBe(false);
  });

  it('surfaces the new refresh token for a rotating vendor', async () => {
    const { impl } = stub({ access_token: 'fresh', refresh_token: 'rotated', expires_in: 1800 });
    const tokens = await refreshAccessToken(hubspot, CLIENT, 'old', http(impl));
    expect(tokens.refreshToken).toBe('rotated');
    expect(hubspot.auth.kind === 'oauth2' && hubspot.auth.rotatesRefreshToken).toBe(true);
  });
});

describe('revokeToken', () => {
  it('reports success when the vendor accepts the revocation', async () => {
    const { impl, calls } = stub('', 200);
    expect(await revokeToken(gsc, CLIENT, 'rt', http(impl))).toEqual({ revoked: true, supported: true });
    expect(calls[0].url).toBe('https://oauth2.googleapis.com/revoke');
  });

  it('reports failure without throwing, so a disconnect can still complete', async () => {
    const { impl } = stub({ error: 'invalid_token' }, 400);
    expect(await revokeToken(gsc, CLIENT, 'rt', http(impl))).toEqual({ revoked: false, supported: true });
  });

  it('distinguishes "vendor has no revocation endpoint" from "vendor refused"', async () => {
    // HubSpot exposes none, and the UI must not claim access was revoked.
    const { impl } = stub('', 200);
    expect(await revokeToken(hubspot, CLIENT, 'rt', http(impl))).toEqual({ revoked: false, supported: false });
  });
});

describe('missingScopes', () => {
  it('names a required scope the user unticked at the consent screen', () => {
    expect(missingScopes(gbp, ['openid', 'email'])).toEqual(['https://www.googleapis.com/auth/business.manage']);
  });

  it('is empty when everything required was granted, ignoring optional extras', () => {
    expect(missingScopes(gsc, ['https://www.googleapis.com/auth/webmasters.readonly'])).toEqual([]);
  });
});
