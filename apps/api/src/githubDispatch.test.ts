import { describe, expect, it } from 'vitest';
import { dispatchCrawlWorkflow } from './githubDispatch.js';

function fakeFetch(status: number, capture: { url?: string; init?: RequestInit } = {}): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    capture.url = String(url);
    capture.init = init;
    return new Response(null, { status });
  }) as typeof fetch;
}

describe('dispatchCrawlWorkflow', () => {
  it('does nothing without a token, and says so', async () => {
    const result = await dispatchCrawlWorkflow({}, fakeFetch(204));
    expect(result).toEqual({ dispatched: false, reason: 'no dispatch token configured' });
  });

  it('posts a workflow_dispatch for the default repository and branch', async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const result = await dispatchCrawlWorkflow({ GITHUB_DISPATCH_TOKEN: 'ghp_x' }, fakeFetch(204, capture));
    expect(result).toEqual({ dispatched: true });
    expect(capture.url).toBe('https://api.github.com/repos/thenameisab/engine/actions/workflows/crawl.yml/dispatches');
    expect(capture.init?.method).toBe('POST');
    expect(JSON.parse(capture.init?.body as string)).toEqual({ ref: 'main' });
    expect((capture.init?.headers as Record<string, string>).authorization).toBe('Bearer ghp_x');
  });

  it('honours the repo, ref and workflow overrides', async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    await dispatchCrawlWorkflow(
      { GITHUB_DISPATCH_TOKEN: 't', GITHUB_DISPATCH_REPO: 'o/r', GITHUB_DISPATCH_REF: 'staging', GITHUB_DISPATCH_WORKFLOW: 'w.yml' },
      fakeFetch(204, capture),
    );
    expect(capture.url).toBe('https://api.github.com/repos/o/r/actions/workflows/w.yml/dispatches');
    expect(JSON.parse(capture.init?.body as string)).toEqual({ ref: 'staging' });
  });

  it('reports a non-204 as not dispatched without throwing; the schedule still runs', async () => {
    const result = await dispatchCrawlWorkflow({ GITHUB_DISPATCH_TOKEN: 't' }, fakeFetch(401));
    expect(result).toEqual({ dispatched: false, reason: 'GitHub answered 401' });
  });

  it('reports a network failure as a reason, never a throw', async () => {
    const failing = (async () => { throw new Error('boom'); }) as unknown as typeof fetch;
    const result = await dispatchCrawlWorkflow({ GITHUB_DISPATCH_TOKEN: 't' }, failing);
    expect(result).toEqual({ dispatched: false, reason: 'boom' });
  });
});
