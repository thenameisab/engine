import { describe, it, expect } from 'vitest';
import { listResources, getLister, providersWithListers, registerLister } from './resources.js';
import { getProvider } from './registry.js';
import { IntegrationError } from './errors.js';
import type { IntegrationProvider } from './types.js';
import type { ApiKeyCredential } from './credentials.js';

const bing = getProvider('bing-webmaster') as IntegrationProvider;
const cloudflare = getProvider('cloudflare') as IntegrationProvider;
const gsc = getProvider('gsc') as IntegrationProvider;

function stub(body: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const http = (impl: typeof fetch) => ({ fetchImpl: impl, sleep: async () => undefined, maxRetries: 0 });
const key = (secrets: Record<string, string>): ApiKeyCredential => ({ kind: 'api_key', secrets, public: {} });

describe('the lister registry', () => {
  it('registers the API-key listers this package owns', () => {
    expect(providersWithListers()).toEqual(['bing-webmaster', 'cloudflare']);
  });

  it('fails a provider with no lister rather than returning an empty list', async () => {
    // An empty picker claims "this account has nothing", which is a different
    // and misleading statement from "we have not built this yet".
    try {
      await listResources({ provider: gsc, accessToken: 'tok' });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as IntegrationError).reason).toBe('not_configured');
      expect((e as Error).message).toMatch(/no resource listing implemented/);
    }
  });

  it('lets a host override a lister without forking', async () => {
    const original = getLister('cloudflare')!;
    registerLister('cloudflare', async () => ({ resources: [], truncated: true }));
    expect((await listResources({ provider: cloudflare, apiKey: key({ apiToken: 'x' }) })).truncated).toBe(true);
    registerLister('cloudflare', original);
  });
});

describe('bing-webmaster lister', () => {
  it('unwraps the WCF `d` envelope and sends the key as a query parameter', async () => {
    const { impl, calls } = stub({ d: [{ Url: 'https://a.example/', IsVerified: true }] });
    const out = await listResources({ provider: bing, apiKey: key({ apiKey: 'abc' }), http: http(impl) });
    expect(out.resources).toEqual([{ id: 'https://a.example/', label: 'https://a.example/', selectable: true, detail: undefined }]);
    expect(calls[0].url).toContain('apikey=abc');
  });

  it('shows an unverified site but refuses to let it be selected', async () => {
    // An unverified site returns no data at all, so offering it produces a
    // connection that looks fine and reports nothing.
    const { impl } = stub({ d: [{ Url: 'https://b.example/', IsVerified: false }] });
    const out = await listResources({ provider: bing, apiKey: key({ apiKey: 'abc' }), http: http(impl) });
    expect(out.resources[0].selectable).toBe(false);
    expect(out.resources[0].detail).toMatch(/not verified/);
  });

  it('skips a malformed entry rather than rendering an undefined row', async () => {
    const { impl } = stub({ d: [{ IsVerified: true }, { Url: 'https://c.example/' }] });
    const out = await listResources({ provider: bing, apiKey: key({ apiKey: 'abc' }), http: http(impl) });
    expect(out.resources.map((r) => r.id)).toEqual(['https://c.example/']);
  });

  it('reports a rejected key as invalid_credentials, not as a vendor outage', async () => {
    const { impl } = stub('unauthorized', 401);
    try {
      await listResources({ provider: bing, apiKey: key({ apiKey: 'bad' }), http: http(impl) });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as IntegrationError).reason).toBe('invalid_credentials');
    }
  });

  it('refuses to call the vendor with no stored key', async () => {
    await expect(listResources({ provider: bing })).rejects.toMatchObject({ reason: 'invalid_credentials' });
  });
});

describe('cloudflare lister', () => {
  it('sends a bearer token and maps zones', async () => {
    const { impl, calls } = stub({
      success: true,
      result: [{ id: 'z1', name: 'example.com', status: 'active' }],
      result_info: { total_count: 1 },
    });
    const out = await listResources({ provider: cloudflare, apiKey: key({ apiToken: 'tok' }), http: http(impl) });
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(out.resources).toEqual([{ id: 'z1', label: 'example.com', selectable: true, detail: undefined }]);
    expect(out.truncated).toBe(false);
  });

  it('treats a 200 with success:false as a failure', async () => {
    // Cloudflare answers 200 with success:false as readily as it answers 4xx.
    // Trusting the status alone would report an error page as an empty account.
    const { impl } = stub({ success: false, errors: [{ message: 'Invalid access token' }] }, 200);
    try {
      await listResources({ provider: cloudflare, apiKey: key({ apiToken: 'bad' }), http: http(impl) });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as Error).message).toMatch(/Invalid access token/);
    }
  });

  it('marks a non-active zone unselectable, with the reason', async () => {
    const { impl } = stub({ success: true, result: [{ id: 'z2', name: 'pending.example', status: 'pending' }] });
    const out = await listResources({ provider: cloudflare, apiKey: key({ apiToken: 'tok' }), http: http(impl) });
    expect(out.resources[0].selectable).toBe(false);
    expect(out.resources[0].detail).toBe('zone is pending');
  });

  it('reports truncation when the account has more zones than one page', async () => {
    const { impl } = stub({
      success: true,
      result: [{ id: 'z1', name: 'a.example', status: 'active' }],
      result_info: { total_count: 120 },
    });
    expect((await listResources({ provider: cloudflare, apiKey: key({ apiToken: 't' }), http: http(impl) })).truncated).toBe(true);
  });
});
