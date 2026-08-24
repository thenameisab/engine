import { describe, it, expect } from 'vitest';
import { classifyGoogleError, googleGet, paginate, GoogleApiError } from './api.js';

describe('classifyGoogleError', () => {
  it('distinguishes an unenabled API from a plain 403', () => {
    const notEnabled =
      'Google Analytics Admin API has not been used in project 12345 before or it is disabled. Enable it by visiting...';
    expect(classifyGoogleError(403, notEnabled)).toBe('api-not-enabled');
    expect(classifyGoogleError(403, '{"error":{"status":"PERMISSION_DENIED","message":"The caller does not have permission"}}')).toBe(
      'forbidden',
    );
  });

  it('recognises SERVICE_DISABLED and accessNotConfigured as the same cause', () => {
    expect(classifyGoogleError(403, '{"reason":"SERVICE_DISABLED"}')).toBe('api-not-enabled');
    expect(classifyGoogleError(403, '{"reason":"accessNotConfigured"}')).toBe('api-not-enabled');
  });

  it('separates the GBP zero-quota 403 from a rate limit, since waiting never fixes it', () => {
    expect(classifyGoogleError(403, "Quota exceeded for quota metric 'Requests' ...")).toBe('quota-not-granted');
    expect(classifyGoogleError(403, '{"reason":"rateLimitExceeded"}')).toBe('rate-limited');
    expect(classifyGoogleError(429, 'Too many requests')).toBe('rate-limited');
  });

  it('maps the unambiguous statuses directly', () => {
    expect(classifyGoogleError(401, 'Invalid Credentials')).toBe('unauthorized');
    expect(classifyGoogleError(404, 'Not Found')).toBe('not-found');
    expect(classifyGoogleError(500, 'Internal error')).toBe('unknown');
  });
});

describe('GoogleApiError', () => {
  it('marks only a 401 as needing re-consent', () => {
    expect(new GoogleApiError('unauthorized', 401, 'x', 'ctx').needsReauth).toBe(true);
    expect(new GoogleApiError('forbidden', 403, 'x', 'ctx').needsReauth).toBe(false);
    // An unenabled API is our configuration problem, not the customer's token.
    expect(new GoogleApiError('api-not-enabled', 403, 'x', 'ctx').needsReauth).toBe(false);
  });

  it('marks rate limits and 5xx as retryable, and configuration failures as not', () => {
    expect(new GoogleApiError('rate-limited', 429, 'x', 'ctx').retryable).toBe(true);
    expect(new GoogleApiError('unknown', 503, 'x', 'ctx').retryable).toBe(true);
    expect(new GoogleApiError('quota-not-granted', 403, 'x', 'ctx').retryable).toBe(false);
    expect(new GoogleApiError('api-not-enabled', 403, 'x', 'ctx').retryable).toBe(false);
  });

  it('names the failure and the call in its message', () => {
    const err = new GoogleApiError('api-not-enabled', 403, 'not been used in project', 'accountSummaries.list');
    expect(err.message).toContain('accountSummaries.list');
    expect(err.message).toContain('api-not-enabled');
  });
});

describe('googleGet', () => {
  function stub(status: number, body: string) {
    return (async () => new Response(body, { status })) as unknown as typeof fetch;
  }

  it('sends the bearer token', async () => {
    let seen: RequestInit | undefined;
    const impl = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      seen = init;
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;
    await googleGet('https://example.test/x', 'the-token', 'ctx', impl);
    expect((seen?.headers as Record<string, string>).authorization).toBe('Bearer the-token');
  });

  it('throws a classified GoogleApiError on failure', async () => {
    await expect(
      googleGet('https://example.test/x', 't', 'sites.list', stub(403, 'has not been used in project 1')),
    ).rejects.toMatchObject({ failure: 'api-not-enabled', status: 403 });
  });

  it('treats an empty 200 body as an empty object rather than a parse error', async () => {
    expect(await googleGet('https://example.test/x', 't', 'ctx', stub(200, ''))).toEqual({});
  });
});

describe('paginate', () => {
  it('follows nextPageToken and concatenates the pages', async () => {
    const pages: Record<string, { items: number[]; nextPageToken?: string }> = {
      '': { items: [1, 2], nextPageToken: 'p2' },
      p2: { items: [3, 4], nextPageToken: 'p3' },
      p3: { items: [5] },
    };
    const result = await paginate<number>(async (token) => pages[token ?? '']);
    expect(result.items).toEqual([1, 2, 3, 4, 5]);
    expect(result.truncated).toBe(false);
  });

  it('reports truncation at the page cap instead of looping forever', async () => {
    // A page that always returns a next token — the runaway case the cap exists for.
    const result = await paginate<number>(async () => ({ items: [1], nextPageToken: 'always' }), 3);
    expect(result.items).toEqual([1, 1, 1]);
    expect(result.truncated).toBe(true);
  });

  it('handles a single empty page', async () => {
    expect(await paginate<number>(async () => ({ items: [] }))).toEqual({ items: [], truncated: false });
  });
});
