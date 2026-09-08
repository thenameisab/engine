import { describe, it, expect, vi } from 'vitest';
import { vendorFetch, parseRetryAfter, parseJson } from './http.js';
import { IntegrationError } from './errors.js';

/**
 * A fetch that plays back a queued list of results, recording each call.
 *
 * Responses are supplied as *factories*, not instances. A Response body is a
 * stream that can be read once, so handing the same object to two attempts
 * fails with "ReadableStream is locked" — an artefact of the stub that looks
 * exactly like a bug in the retry path. Real fetch produces a fresh response
 * per call, and so does this.
 */
type Result = (() => Response) | Error;

function stubFetch(results: Result[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = results[Math.min(i++, results.length - 1)];
    if (next instanceof Error) throw next;
    return next();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** Sugar so each case reads as the response it means. */
const reply = (body: string, init?: ResponseInit) => () => new Response(body, init);

const noSleep = async () => undefined;

describe('vendorFetch', () => {
  it('returns a 4xx as a result rather than throwing', async () => {
    // Only the caller knows whether a 401 is a bad paste or a revoked grant.
    const { impl } = stubFetch([reply('nope', { status: 401 })]);
    const res = await vendorFetch('https://v.example/token', {}, { fetchImpl: impl, sleep: noSleep });
    expect(res.status).toBe(401);
    expect(res.ok).toBe(false);
  });

  it('never follows a redirect on a credential-carrying request', async () => {
    const { impl, calls } = stubFetch([reply('', { status: 302, headers: { location: 'https://evil.example' } })]);
    await expect(
      vendorFetch('https://v.example/token', { method: 'POST' }, { fetchImpl: impl, sleep: noSleep }),
    ).rejects.toThrow(/refusing to resend credentials/);
    expect(calls[0].init.redirect).toBe('manual');
  });

  it('retries a 500 and returns the eventual success', async () => {
    const { impl, calls } = stubFetch([
      reply('boom', { status: 500 }),
      reply('{"ok":true}', { status: 200 }),
    ]);
    const res = await vendorFetch('https://v.example/x', {}, { fetchImpl: impl, sleep: noSleep });
    expect(res.status).toBe(200);
    expect(calls.length).toBe(2);
  });

  it('does not retry a 400 — retrying a rejected request only wastes quota', async () => {
    const { impl, calls } = stubFetch([reply('bad', { status: 400 })]);
    await vendorFetch('https://v.example/x', {}, { fetchImpl: impl, sleep: noSleep });
    expect(calls.length).toBe(1);
  });

  it('honours Retry-After on a 429 instead of using its own backoff', async () => {
    const slept: number[] = [];
    const { impl } = stubFetch([
      reply('slow down', { status: 429, headers: { 'retry-after': '7' } }),
      reply('ok', { status: 200 }),
    ]);
    await vendorFetch(
      'https://v.example/x',
      {},
      { fetchImpl: impl, sleep: async (ms) => void slept.push(ms) },
    );
    expect(slept).toEqual([7000]);
  });

  it('raises rate_limited with the retry hint once attempts are exhausted', async () => {
    const { impl } = stubFetch([reply('quota', { status: 429, headers: { 'retry-after': '30' } })]);
    try {
      await vendorFetch('https://v.example/x', {}, { fetchImpl: impl, sleep: noSleep, maxRetries: 1 });
      expect.unreachable('should have thrown');
    } catch (e) {
      const err = e as IntegrationError;
      expect(err.reason).toBe('rate_limited');
      expect(err.retryAfterSeconds).toBe(30);
      expect(err.retryable).toBe(true);
    }
  });

  it('gives up with vendor_error after exhausting retries on a 503', async () => {
    const { impl, calls } = stubFetch([reply('down', { status: 503 })]);
    await expect(
      vendorFetch('https://v.example/x', {}, { fetchImpl: impl, sleep: noSleep, maxRetries: 2 }),
    ).rejects.toMatchObject({ reason: 'vendor_error' });
    expect(calls.length).toBe(3);
  });

  it('times out rather than holding the isolate open', async () => {
    const impl = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      })) as unknown as typeof fetch;
    await expect(
      vendorFetch('https://v.example/x', {}, { fetchImpl: impl, timeoutMs: 5, maxRetries: 0, sleep: noSleep }),
    ).rejects.toThrow(/timed out after 5ms/);
  });

  it('caps the body it will read', async () => {
    const huge = 'a'.repeat(50_000);
    const { impl } = stubFetch([reply(huge, { status: 200 })]);
    const res = await vendorFetch('https://v.example/x', {}, { fetchImpl: impl, maxBodyBytes: 1000, sleep: noSleep });
    expect(res.text.length).toBeLessThanOrEqual(1000);
  });

  it('returns the body unredacted, because a token response is the credential', async () => {
    // Redacting here would hand the OAuth layer access_token: "[redacted]".
    // Redaction is IntegrationError's job, on the way out to a log or a column.
    const { impl } = stubFetch([reply(JSON.stringify({ access_token: 'ya29.real' }), { status: 200 })]);
    const out = await vendorFetch('https://v.example/token', {}, { fetchImpl: impl, sleep: noSleep });
    expect(out.text).toContain('ya29.real');
  });

  it('redacts a vendor secret when the body becomes an error message', async () => {
    const { impl } = stubFetch([
      reply(JSON.stringify({ error: 'server_error', client_secret: 'GOCSPX-leaked' }), { status: 500 }),
    ]);
    try {
      await vendorFetch('https://v.example/token', {}, { fetchImpl: impl, sleep: noSleep, maxRetries: 0 });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as Error).message).not.toContain('GOCSPX-leaked');
      expect((e as Error).message).toContain('server_error');
    }
  });

  it('retries a transport failure and then reports it without leaking', async () => {
    const { impl, calls } = stubFetch([new Error('connect ECONNREFUSED token=abc123def456')]);
    await expect(
      vendorFetch('https://v.example/x', {}, { fetchImpl: impl, sleep: noSleep, maxRetries: 1 }),
    ).rejects.toThrow(/\[redacted\]/);
    expect(calls.length).toBe(2);
  });
});

describe('parseRetryAfter', () => {
  it('reads a seconds value', () => {
    expect(parseRetryAfter('120')).toBe(120);
  });

  it('reads an HTTP date relative to now', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:01:00 GMT', now)).toBe(60);
  });

  it('clamps to an hour — a vendor asking for a day is not obeyed literally', () => {
    expect(parseRetryAfter('99999')).toBe(3600);
  });

  it('never returns a negative wait for a date already past', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:00 GMT', now)).toBe(0);
  });

  it('returns undefined for a missing or unparseable value', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });
});

describe('parseJson', () => {
  it('reports the status and a bounded excerpt when a vendor sends HTML', () => {
    const res = { status: 502, ok: false, headers: new Headers(), text: '<html>gateway</html>' };
    try {
      parseJson(res, 'token request', 'gsc');
      expect.unreachable('should have thrown');
    } catch (e) {
      const err = e as IntegrationError;
      expect(err.reason).toBe('invalid_response');
      expect(err.status).toBe(502);
      expect(err.message).toContain('gateway');
    }
  });
});
