import { describe, expect, it } from 'vitest';
import { app } from './index.js';

/**
 * The GitHub webhook at the boundary.
 *
 * The endpoint is unauthenticated by necessity — GitHub cannot hold a JWT — so
 * the signature is the whole gate, and these prove it answers before any
 * database is touched. `DATABASE_URL` points at a dead loopback port, so a
 * request that reaches Postgres fails loudly rather than passing quietly.
 */
const SECRET = 'a-long-random-webhook-secret';
const env = {
  DATABASE_URL: 'postgres://127.0.0.1:1/db',
  GITHUB_WEBHOOK_SECRET: SECRET,
} as const;

async function sign(payload: string, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return `sha256=${[...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function deliver(payload: string, headers: Record<string, string>, useEnv: object = env): Promise<Response> {
  return app.request('/webhooks/github', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: payload }, useEnv);
}

const merged = JSON.stringify({
  action: 'closed',
  pull_request: { number: 42, merged: true },
  repository: { full_name: 'acme/site' },
});
const opened = JSON.stringify({
  action: 'opened',
  pull_request: { number: 42, merged: false },
  repository: { full_name: 'acme/site' },
});

describe('POST /webhooks/github', () => {
  it('needs no bearer token — the signature is the gate', async () => {
    // If this route had landed behind requireAuth, every real delivery would
    // 401 and the fast path would silently never work.
    const res = await deliver(opened, { 'x-hub-signature-256': await sign(opened) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, applied: false });
  });

  it('refuses an unsigned delivery', async () => {
    expect((await deliver(merged, {})).status).toBe(400);
  });

  it('refuses a signature made with the wrong secret', async () => {
    const res = await deliver(merged, { 'x-hub-signature-256': await sign(merged, 'not-the-secret') });
    expect(res.status).toBe(400);
  });

  it('refuses a body altered after signing', async () => {
    const header = await sign(opened);
    expect((await deliver(merged, { 'x-hub-signature-256': header })).status).toBe(400);
  });

  it('refuses everything when no secret is configured, rather than trusting the body', async () => {
    // An open endpoint that enqueues work on a caller's word is worse than no
    // endpoint. A valid-looking signature must not help here either.
    const res = await deliver(merged, { 'x-hub-signature-256': await sign(merged) }, { DATABASE_URL: env.DATABASE_URL });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'github webhook is not configured' });
  });

  it('answers 200 to a signed delivery it has no interest in', async () => {
    // GitHub retries a non-2xx and disables an endpoint that keeps failing, so
    // refusing an `opened` event would eventually cost us the merges too.
    for (const payload of [opened, JSON.stringify({ zen: 'Keep it logically awesome.', hook_id: 1 })]) {
      const res = await deliver(payload, { 'x-hub-signature-256': await sign(payload) });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ received: true, applied: false });
    }
  });

  it('rejects a signed body that is not JSON', async () => {
    const payload = 'not json';
    const res = await deliver(payload, { 'x-hub-signature-256': await sign(payload) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'body is not valid JSON' });
  });

  it('reaches the database only for a merge, which is what the dead URL proves', async () => {
    // A merge is the one delivery that has to look for a deployed fix. With
    // DATABASE_URL pointing nowhere that lookup throws, so a 500 here is the
    // evidence the handler got that far — and every case above returning 200
    // or 400 is evidence they did not.
    const res = await deliver(merged, { 'x-hub-signature-256': await sign(merged) });
    expect(res.status).toBe(500);
  });
});
