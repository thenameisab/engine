import { describe, it, expect } from 'vitest';
import { signOAuthState, verifyOAuthState } from './oauthState.js';

const SECRET = 'test-oauth-state-secret';
const NOW = 1_700_000_000;

const CLAIMS = { accountId: 'acct-1', userId: 'user-1', provider: 'gsc' as const };

/** base64url -> base64, restoring the padding the encoder stripped. */
function b64urlToB64(s: string): string {
  return s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
}

describe('signOAuthState', () => {
  it('refuses to mint an unsigned state when no secret is configured', async () => {
    await expect(signOAuthState(CLAIMS, '')).rejects.toThrow(/OAUTH_STATE_SECRET is not set/);
  });

  it('produces a different token for the same claims, via the nonce', async () => {
    const a = await signOAuthState(CLAIMS, SECRET, { nowSeconds: NOW });
    const b = await signOAuthState(CLAIMS, SECRET, { nowSeconds: NOW });
    expect(a).not.toBe(b);
  });
});

describe('verifyOAuthState', () => {
  it('round-trips the claims the callback needs', async () => {
    const token = await signOAuthState({ ...CLAIMS, returnTo: '/app/settings' }, SECRET, { nowSeconds: NOW });
    const result = await verifyOAuthState(token, SECRET, { nowSeconds: NOW + 5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims.accountId).toBe('acct-1');
    expect(result.claims.userId).toBe('user-1');
    expect(result.claims.provider).toBe('gsc');
    expect(result.claims.returnTo).toBe('/app/settings');
  });

  it('rejects a state whose accountId was edited — the attack the bare-projectId state allowed', async () => {
    const token = await signOAuthState(CLAIMS, SECRET, { nowSeconds: NOW });
    const [body] = token.split('.');
    const forged = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64urlToB64(body)), (c) => c.charCodeAt(0))));
    forged.accountId = 'victim-account';
    const forgedBody = btoa(JSON.stringify(forged)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const result = await verifyOAuthState(`${forgedBody}.${token.split('.')[1]}`, SECRET, { nowSeconds: NOW + 5 });
    expect(result).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await signOAuthState(CLAIMS, 'some-other-secret', { nowSeconds: NOW });
    const result = await verifyOAuthState(token, SECRET, { nowSeconds: NOW + 5 });
    expect(result).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('rejects an expired state', async () => {
    const token = await signOAuthState(CLAIMS, SECRET, { nowSeconds: NOW, ttlSeconds: 60 });
    const result = await verifyOAuthState(token, SECRET, { nowSeconds: NOW + 61 });
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('accepts a state one second before expiry', async () => {
    const token = await signOAuthState(CLAIMS, SECRET, { nowSeconds: NOW, ttlSeconds: 60 });
    const result = await verifyOAuthState(token, SECRET, { nowSeconds: NOW + 59 });
    expect(result.ok).toBe(true);
  });

  it('fails closed when no secret is configured, rather than accepting anything', async () => {
    const token = await signOAuthState(CLAIMS, SECRET, { nowSeconds: NOW });
    expect(await verifyOAuthState(token, undefined)).toEqual({ ok: false, reason: 'unconfigured' });
  });

  it('rejects malformed tokens', async () => {
    for (const bad of ['', 'nodot', 'a.b.c', '!!!.???']) {
      const result = await verifyOAuthState(bad, SECRET, { nowSeconds: NOW });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(['malformed', 'bad-signature']).toContain(result.reason);
    }
  });

  it('rejects a validly-signed token that is missing required claims', async () => {
    // Sign a payload that passes the signature check but has no userId — the
    // shape check has to run after verification, not instead of it.
    const body = btoa(JSON.stringify({ accountId: 'a', provider: 'gsc', exp: NOW + 600, nonce: 'n' }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(SECRET) as unknown as ArrayBuffer,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = new Uint8Array(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body) as unknown as ArrayBuffer),
    );
    let s = '';
    for (const b of sig) s += String.fromCharCode(b);
    const sigB64 = btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(await verifyOAuthState(`${body}.${sigB64}`, SECRET, { nowSeconds: NOW })).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
});
