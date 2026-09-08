import { describe, expect, it } from 'vitest';
import { createQueueApi, runQueue, type Outcome, type QueueApi, type QueuedRequest } from './runQueue.js';

const req = (id: string): QueuedRequest => ({ id, projectId: 'p', entityId: 'e', rootUrl: `https://${id}.example`, maxPages: 50 });

function fakeApi(queued: QueuedRequest[], claimable = new Set(queued.map((q) => q.id))) {
  const finished: Record<string, Outcome> = {};
  const api: QueueApi = {
    listQueued: async () => queued,
    claim: async (id) => (claimable.has(id) ? queued.find((q) => q.id === id)! : null),
    finish: async (id, outcome) => {
      finished[id] = outcome;
    },
  };
  return { api, finished };
}

describe('runQueue', () => {
  it('claims, crawls and finishes each request with its run id', async () => {
    const { api, finished } = fakeApi([req('a'), req('b')]);
    const result = await runQueue(api, async (r) => ({ pagesCrawled: 3, auditRunId: `run-${r.id}` }));
    expect(result).toEqual({ seen: 2, claimed: 2, done: 2, failed: 0 });
    expect(finished).toEqual({ a: { auditRunId: 'run-a' }, b: { auditRunId: 'run-b' } });
  });

  it('skips a request another runner claimed first', async () => {
    const { api, finished } = fakeApi([req('a'), req('b')], new Set(['b']));
    const result = await runQueue(api, async () => ({ pagesCrawled: 1, auditRunId: 'r' }));
    expect(result).toEqual({ seen: 2, claimed: 1, done: 1, failed: 0 });
    expect(Object.keys(finished)).toEqual(['b']);
  });

  it('marks a failed crawl failed with the message, and keeps going', async () => {
    const { api, finished } = fakeApi([req('a'), req('b')]);
    const result = await runQueue(api, async (r) => {
      if (r.id === 'a') throw new Error('site unreachable: https://a.example');
      return { pagesCrawled: 2, auditRunId: 'run-b' };
    });
    expect(result).toEqual({ seen: 2, claimed: 2, done: 1, failed: 1 });
    expect(finished.a).toEqual({ error: 'site unreachable: https://a.example' });
    expect(finished.b).toEqual({ auditRunId: 'run-b' });
  });

  it('never logs a site URL, only request ids and counts', async () => {
    const lines: string[] = [];
    const { api } = fakeApi([req('a')]);
    await runQueue(api, async () => { throw new Error('boom at https://a.example/page'); }, (l) => lines.push(l));
    expect(lines.join('\n')).not.toContain('example');
    expect(lines.some((l) => l.startsWith('a:'))).toBe(true);
  });
});

describe('createQueueApi', () => {
  function fetchStub(routes: Record<string, { status: number; body?: unknown }>) {
    const calls: { url: string; init?: RequestInit }[] = [];
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, init });
      const key = Object.keys(routes).find((k) => u.endsWith(k));
      const r = key ? routes[key]! : { status: 404, body: { error: 'no stub' } };
      return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
    }) as typeof fetch;
    return { impl, calls };
  }

  it('sends the service token and reads the queue', async () => {
    const { impl, calls } = fetchStub({ '/internal/audit-requests?status=queued': { status: 200, body: { requests: [req('a')] } } });
    const api = createQueueApi({ apiBaseUrl: 'https://api.test/', token: 'tok', fetchImpl: impl });
    expect(await api.listQueued()).toEqual([req('a')]);
    expect(calls[0]!.url).toBe('https://api.test/internal/audit-requests?status=queued');
    expect((calls[0]!.init?.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('treats a 409 on claim as "someone else has it"', async () => {
    const { impl } = fetchStub({ '/claim': { status: 409, body: { error: 'request is not queued' } } });
    const api = createQueueApi({ apiBaseUrl: 'https://api.test', token: 'tok', fetchImpl: impl });
    expect(await api.claim('a')).toBeNull();
  });

  it('throws on any other failure so the pass is visibly red', async () => {
    const { impl } = fetchStub({ '/finish': { status: 500, body: { error: 'db down' } } });
    const api = createQueueApi({ apiBaseUrl: 'https://api.test', token: 'tok', fetchImpl: impl });
    await expect(api.finish('a', { error: 'x' })).rejects.toThrow('finishing a failed: 500 db down');
  });
});
