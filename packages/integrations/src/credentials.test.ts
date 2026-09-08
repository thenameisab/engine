import { describe, it, expect } from 'vitest';
import {
  loadKeyring,
  sealCredential,
  openCredential,
  credentialAad,
  validateApiKeySubmission,
  verifyApiKey,
  applyApiKey,
  type ApiKeyCredential,
} from './credentials.js';
import { getProvider } from './registry.js';
import { IntegrationError } from './errors.js';
import type { IntegrationProvider } from './types.js';

/** Two distinct, valid AES-256 keys. */
const KEY_A = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const KEY_B = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));

const ACCOUNT = '11111111-1111-1111-1111-111111111111';
const OTHER_ACCOUNT = '22222222-2222-2222-2222-222222222222';

describe('loadKeyring', () => {
  it('accepts a bare unversioned key, so the existing single-key deployment keeps working', async () => {
    const ring = await loadKeyring(KEY_A);
    expect(ring.primary.version).toBe('v1');
    expect(ring.byVersion.size).toBe(1);
  });

  it('takes the first listed key as primary and keeps the rest openable', async () => {
    const ring = await loadKeyring(`v2:${KEY_B}, v1:${KEY_A}`);
    expect(ring.primary.version).toBe('v2');
    expect([...ring.byVersion.keys()].sort()).toEqual(['v1', 'v2']);
  });

  it('refuses an empty, duplicated, or unusable keyring', async () => {
    await expect(loadKeyring(undefined)).rejects.toThrow(IntegrationError);
    await expect(loadKeyring('')).rejects.toThrow(IntegrationError);
    await expect(loadKeyring(`v1:${KEY_A},v1:${KEY_B}`)).rejects.toThrow(/listed twice/);
    await expect(loadKeyring('v1:not-base64!!')).rejects.toThrow(/unusable/);
    // A 16-byte key is not AES-256, and stretching it silently would halve the
    // strength of every stored credential.
    await expect(loadKeyring(btoa('0123456789abcdef'))).rejects.toThrow(/unusable/);
  });

  it('does not echo key material in an error', async () => {
    try {
      await loadKeyring(`v1:${btoa('tooshort')}`);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as Error).message).not.toContain(btoa('tooshort'));
    }
  });
});

describe('sealing an OAuth credential', () => {
  it('round-trips a refresh token', async () => {
    const ring = await loadKeyring(KEY_A);
    const sealed = await sealCredential(ring, ACCOUNT, 'gsc', { kind: 'oauth2', refreshToken: '1//04-secret' });
    expect(sealed.sealed).not.toContain('1//04-secret');
    expect(sealed.keyVersion).toBe('v1');

    const opened = await openCredential(ring, ACCOUNT, 'gsc', sealed);
    expect(opened.credential).toEqual({ kind: 'oauth2', refreshToken: '1//04-secret' });
    expect(opened.staleKey).toBe(false);
  });

  it('refuses to open a blob moved to another account', async () => {
    const ring = await loadKeyring(KEY_A);
    const sealed = await sealCredential(ring, ACCOUNT, 'gsc', { kind: 'oauth2', refreshToken: 'r' });
    await expect(openCredential(ring, OTHER_ACCOUNT, 'gsc', sealed)).rejects.toThrow(/failed to open/);
  });

  it('refuses to open a blob moved to another provider', async () => {
    const ring = await loadKeyring(KEY_A);
    const sealed = await sealCredential(ring, ACCOUNT, 'gsc', { kind: 'oauth2', refreshToken: 'r' });
    await expect(openCredential(ring, ACCOUNT, 'gbp', sealed)).rejects.toThrow(/failed to open/);
  });

  it('refuses to open an API-key blob as an OAuth one', async () => {
    // Without `kind` in the AAD this would open cleanly and the refresh token
    // would then be posted to a token endpoint.
    const ring = await loadKeyring(KEY_A);
    const sealed = await sealCredential(ring, ACCOUNT, 'ahrefs', {
      kind: 'api_key',
      secrets: { apiToken: 't' },
      public: {},
    });
    await expect(
      openCredential(ring, ACCOUNT, 'ahrefs', { ...sealed, kind: 'oauth2' }),
    ).rejects.toThrow(/failed to open/);
  });

  it('binds account, provider and kind into the AAD', () => {
    expect(credentialAad(ACCOUNT, 'gsc', 'oauth2')).toBe(`${ACCOUNT}:gsc:oauth2`);
    expect(credentialAad(ACCOUNT, 'gsc', 'api_key')).not.toBe(credentialAad(ACCOUNT, 'gsc', 'oauth2'));
  });
});

describe('sealing an API-key credential', () => {
  it('seals the secret fields and leaves the public ones readable', async () => {
    const ring = await loadKeyring(KEY_A);
    const credential: ApiKeyCredential = {
      kind: 'api_key',
      secrets: { applicationPassword: 'abcd efgh ijkl' },
      public: { siteUrl: 'https://example.com', username: 'editor' },
    };
    const sealed = await sealCredential(ring, ACCOUNT, 'wordpress', credential);
    expect(sealed.sealed).not.toContain('abcd efgh ijkl');
    expect(sealed.public).toEqual({ siteUrl: 'https://example.com', username: 'editor' });

    const opened = await openCredential(ring, ACCOUNT, 'wordpress', sealed);
    expect(opened.credential).toEqual(credential);
  });
});

describe('key rotation', () => {
  it('opens a credential sealed under an older key and flags it for re-sealing', async () => {
    const oldRing = await loadKeyring(`v1:${KEY_A}`);
    const sealed = await sealCredential(oldRing, ACCOUNT, 'gsc', { kind: 'oauth2', refreshToken: 'r' });

    // Operator adds a new primary and keeps the old key for reading.
    const rotated = await loadKeyring(`v2:${KEY_B},v1:${KEY_A}`);
    const opened = await openCredential(rotated, ACCOUNT, 'gsc', sealed);
    expect(opened.credential).toEqual({ kind: 'oauth2', refreshToken: 'r' });
    expect(opened.staleKey).toBe(true);

    const resealed = await sealCredential(rotated, ACCOUNT, 'gsc', opened.credential);
    expect(resealed.keyVersion).toBe('v2');
    expect((await openCredential(rotated, ACCOUNT, 'gsc', resealed)).staleKey).toBe(false);
  });

  it('names the missing version when a key was dropped too early', async () => {
    const oldRing = await loadKeyring(`v1:${KEY_A}`);
    const sealed = await sealCredential(oldRing, ACCOUNT, 'gsc', { kind: 'oauth2', refreshToken: 'r' });
    const onlyNew = await loadKeyring(`v2:${KEY_B}`);
    await expect(openCredential(onlyNew, ACCOUNT, 'gsc', sealed)).rejects.toThrow(/'v1'.*not in the current keyring/);
  });
});

describe('validateApiKeySubmission', () => {
  const cloudflare = getProvider('cloudflare') as IntegrationProvider;
  const wordpress = getProvider('wordpress') as IntegrationProvider;

  it('splits secret from public fields', () => {
    const out = validateApiKeySubmission(wordpress, {
      siteUrl: 'https://example.com',
      username: 'editor',
      applicationPassword: 'abcd efgh',
    });
    expect(out.secrets).toEqual({ applicationPassword: 'abcd efgh' });
    expect(out.public).toEqual({ siteUrl: 'https://example.com', username: 'editor' });
  });

  it('trims, so a copied trailing newline is not stored as part of the key', () => {
    const out = validateApiKeySubmission(cloudflare, { apiToken: `  ${'k'.repeat(40)}\n` });
    expect(out.secrets.apiToken).toBe('k'.repeat(40));
  });

  it('rejects a missing or blank required field', () => {
    expect(() => validateApiKeySubmission(cloudflare, {})).toThrow(/API token is required/);
    expect(() => validateApiKeySubmission(cloudflare, { apiToken: '   ' })).toThrow(/required/);
  });

  it('rejects a value that fails the declared pattern, without echoing it', () => {
    try {
      validateApiKeySubmission(cloudflare, { apiToken: 'short' });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as Error).message).toMatch(/does not look like a valid value/);
      expect((e as Error).message).not.toContain('short');
    }
  });

  it('anchors the pattern, so a valid substring inside junk is still rejected', () => {
    expect(() => validateApiKeySubmission(cloudflare, { apiToken: `"${'k'.repeat(40)}"` })).toThrow(/valid value/);
  });

  it('refuses an unexpected field rather than silently dropping it', () => {
    expect(() =>
      validateApiKeySubmission(cloudflare, { apiToken: 'k'.repeat(40), accountId: 'abc' }),
    ).toThrow(/unexpected field\(s\): accountId/);
  });

  it('refuses a provider that does not take an API key', () => {
    expect(() => validateApiKeySubmission(getProvider('gsc') as IntegrationProvider, {})).toThrow(
      /does not take an API key/,
    );
  });
});

describe('applyApiKey', () => {
  it('places a header credential with its prefix', () => {
    const provider = getProvider('cloudflare') as IntegrationProvider;
    const out = applyApiKey(provider, { kind: 'api_key', secrets: { apiToken: 'tok' }, public: {} }, 'https://api.cloudflare.com/x');
    expect(out.headers).toEqual({ authorization: 'Bearer tok' });
    expect(out.url).toBe('https://api.cloudflare.com/x');
  });

  it('places a query credential without disturbing existing parameters', () => {
    const provider = getProvider('bing-webmaster') as IntegrationProvider;
    const out = applyApiKey(
      provider,
      { kind: 'api_key', secrets: { apiKey: 'abc' }, public: {} },
      'https://ssl.bing.com/webmaster/api.svc/json/GetUserSites?siteUrl=x',
    );
    expect(out.url).toContain('siteUrl=x');
    expect(out.url).toContain('apikey=abc');
    expect(out.headers).toEqual({});
  });

  it('fails clearly when the stored credential is missing its secret', () => {
    const provider = getProvider('cloudflare') as IntegrationProvider;
    expect(() => applyApiKey(provider, { kind: 'api_key', secrets: {}, public: {} }, 'https://x')).toThrow(
      /missing API token/,
    );
  });
});

describe('verifyApiKey', () => {
  const bing = getProvider('bing-webmaster') as IntegrationProvider;
  const cloudflare = getProvider('cloudflare') as IntegrationProvider;
  const bingKey = validateApiKeySubmission(bing, { apiKey: 'ABCDEFGHIJKLMNOP1234' });
  const cfKey = validateApiKeySubmission(cloudflare, { apiToken: 'a'.repeat(40) });

  function fetchWith(status: number, capture: { url?: string; headers?: Record<string, string> } = {}): typeof fetch {
    return (async (url: string | URL | Request, init?: RequestInit) => {
      capture.url = String(url);
      capture.headers = init?.headers as Record<string, string>;
      return new Response('{}', { status });
    }) as typeof fetch;
  }

  it('places a query-string key on the verify URL and passes on a 200', async () => {
    const capture: { url?: string; headers?: Record<string, string> } = {};
    await expect(verifyApiKey(bing, bingKey, fetchWith(200, capture))).resolves.toEqual({ verified: true });
    expect(capture.url).toBe('https://ssl.bing.com/webmaster/api.svc/json/GetUserSites?apikey=ABCDEFGHIJKLMNOP1234');
  });

  it('places a header key as the provider declares', async () => {
    const capture: { url?: string; headers?: Record<string, string> } = {};
    await verifyApiKey(cloudflare, cfKey, fetchWith(200, capture));
    expect(capture.url).toBe('https://api.cloudflare.com/client/v4/user/tokens/verify');
    expect(capture.headers?.authorization).toBe(`Bearer ${'a'.repeat(40)}`);
  });

  it('turns a vendor 400, 401 or 403 into invalid_credentials, so the customer re-pastes', async () => {
    for (const status of [400, 401, 403]) {
      await expect(verifyApiKey(bing, bingKey, fetchWith(status))).rejects.toMatchObject({ reason: 'invalid_credentials' });
    }
  });

  it('turns any other vendor failure into vendor_error, so the customer retries instead', async () => {
    await expect(verifyApiKey(bing, bingKey, fetchWith(500))).rejects.toMatchObject({ reason: 'vendor_error' });
    const down = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    await expect(verifyApiKey(bing, bingKey, down)).rejects.toMatchObject({ reason: 'vendor_error' });
  });

  it('reports unverified, not verified, for a provider with no verify URL', async () => {
    const noVerify = { ...bing, auth: { ...bing.auth, verifyUrl: undefined } } as IntegrationProvider;
    const called: string[] = [];
    await expect(verifyApiKey(noVerify, bingKey, fetchWith(200, {}))).resolves.toEqual({ verified: false });
    expect(called).toEqual([]);
  });
});
