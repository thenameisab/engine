import { describe, it, expect, vi } from 'vitest';
import { fetchPendingActions, reportDeployed } from './pendingActions.js';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

const engineConfig = { apiBase: 'http://localhost:8787', projectId: 'proj_1', siteId: 'site_1', apiToken: 'tok' };

describe('fetchPendingActions', () => {
  it('calls the cms-plugin queue scoped to shopify + the configured siteId', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ actions: [{ id: 'a1' }] }));
    const actions = await fetchPendingActions(engineConfig, fetchImpl as unknown as typeof fetch);
    expect(actions).toEqual([{ id: 'a1' }]);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8787/projects/proj_1/cms-plugin/actions?plugin=shopify&siteId=site_1');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('returns an empty array rather than undefined when the response carries no actions field', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const actions = await fetchPendingActions(engineConfig, fetchImpl as unknown as typeof fetch);
    expect(actions).toEqual([]);
  });

  it('throws naming the HTTP status on failure', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, false, 401));
    await expect(fetchPendingActions(engineConfig, fetchImpl as unknown as typeof fetch)).rejects.toThrow('HTTP 401');
  });
});

describe('reportDeployed', () => {
  it('posts to the ordinary deploy transition with a self-labelled actor', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    await reportDeployed(engineConfig, 'action_1', fetchImpl as unknown as typeof fetch);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8787/projects/proj_1/actions/action_1/deploy');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ actor: 'shopify-plugin:site_1' });
  });

  it('throws naming the HTTP status on failure', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, false, 409));
    await expect(reportDeployed(engineConfig, 'action_1', fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      'HTTP 409',
    );
  });
});
