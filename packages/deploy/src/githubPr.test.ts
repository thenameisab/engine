import { describe, it, expect, vi } from 'vitest';
import type { Action } from '@engine/core';
import {
  getBranchSha,
  createBranch,
  getFileSha,
  putFileContent,
  openPullRequest,
  exportActionAsPr,
} from './githubPr.js';

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

describe('getBranchSha', () => {
  it('reads the sha off the branch ref', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ object: { sha: 'abc123' } }));
    const sha = await getBranchSha('tok', 'acme/site', 'main', fetchImpl as unknown as typeof fetch);
    expect(sha).toBe('abc123');
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/acme/site/git/ref/heads/main');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('throws naming the HTTP status on failure', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 404));
    await expect(getBranchSha('tok', 'acme/site', 'main', fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      'HTTP 404',
    );
  });
});

describe('createBranch', () => {
  it('posts a new ref pointing at the given sha', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    await createBranch('tok', 'acme/site', 'engine-fix/abcd1234', 'abc123', fetchImpl as unknown as typeof fetch);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/acme/site/git/refs');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ ref: 'refs/heads/engine-fix/abcd1234', sha: 'abc123' });
  });
});

describe('getFileSha', () => {
  it('returns the blob sha when the file exists', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ sha: 'blob1' }));
    const sha = await getFileSha('tok', 'acme/site', 'content/pricing.mdx', 'main', fetchImpl as unknown as typeof fetch);
    expect(sha).toBe('blob1');
  });

  it('returns null when the file does not exist (404)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 404));
    const sha = await getFileSha('tok', 'acme/site', 'content/new.mdx', 'main', fetchImpl as unknown as typeof fetch);
    expect(sha).toBeNull();
  });
});

describe('putFileContent', () => {
  it('base64-encodes the content and includes the sha when updating an existing file', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    await putFileContent(
      'tok',
      'acme/site',
      'content/pricing.mdx',
      'engine-fix/abcd1234',
      'new content',
      'Engine: meta fix',
      'blob1',
      fetchImpl as unknown as typeof fetch,
    );
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/acme/site/contents/content/pricing.mdx');
    const body = JSON.parse(init.body as string);
    expect(body.sha).toBe('blob1');
    expect(Buffer.from(body.content, 'base64').toString('utf-8')).toBe('new content');
  });

  it('omits sha when creating a new file', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    await putFileContent(
      'tok',
      'acme/site',
      'content/new.mdx',
      'engine-fix/abcd1234',
      'brand new content',
      'Engine: schema fix',
      null,
      fetchImpl as unknown as typeof fetch,
    );
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).sha).toBeUndefined();
  });
});

describe('openPullRequest', () => {
  it('posts to the pulls endpoint and returns the html url + number', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ html_url: 'https://github.com/acme/site/pull/42', number: 42 }));
    const pr = await openPullRequest(
      'tok',
      'acme/site',
      { title: 'Engine: meta fix', body: 'body', head: 'engine-fix/abcd1234', base: 'main' },
      fetchImpl as unknown as typeof fetch,
    );
    expect(pr).toEqual({ url: 'https://github.com/acme/site/pull/42', number: 42 });
  });
});

describe('exportActionAsPr', () => {
  const action: Pick<Action, 'id' | 'type' | 'diff' | 'target'> = {
    id: 'act_abcd1234efgh',
    type: 'meta',
    diff: { before: 'Old Title', after: 'New Title', format: 'text', field: 'title' },
    target: { kind: 'github-pr', repo: 'acme/site', branch: 'main', path: 'content/pricing.mdx' },
  };

  /** Routes each GitHub endpoint to a canned response, in orchestration order. */
  function routedFetch(): typeof fetch {
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/git/ref/heads/main')) return jsonResponse({ object: { sha: 'base-sha' } });
      if (url.endsWith('/git/refs') && method === 'POST') return jsonResponse({});
      if (url.includes('/contents/content/pricing.mdx?ref=engine-fix/act_abcd')) return jsonResponse({}, 404);
      if (url.endsWith('/contents/content/pricing.mdx') && method === 'PUT') return jsonResponse({});
      if (url.endsWith('/pulls') && method === 'POST') {
        return jsonResponse({ html_url: 'https://github.com/acme/site/pull/7', number: 7 });
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    }) as unknown as typeof fetch;
  }

  it('orchestrates branch -> file write -> PR and derives the branch name from the action id', async () => {
    const fetchImpl = routedFetch();
    const pr = await exportActionAsPr('tok', action, fetchImpl);
    expect(pr).toEqual({ url: 'https://github.com/acme/site/pull/7', number: 7 });

    const branchCreateCall = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
      ([url]: [string]) => url.endsWith('/git/refs'),
    );
    expect(JSON.parse((branchCreateCall![1] as RequestInit).body as string)).toEqual({
      ref: 'refs/heads/engine-fix/act_abcd',
      sha: 'base-sha',
    });
  });

  it('rejects a non-github-pr target', async () => {
    const wrongTarget = { ...action, target: { kind: 'edge-worker' as const, workerName: 'w' } };
    await expect(exportActionAsPr('tok', wrongTarget, routedFetch())).rejects.toThrow('non-github-pr target');
  });
});
