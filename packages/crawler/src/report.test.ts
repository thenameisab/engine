import { describe, it, expect, vi } from 'vitest';
import type { CrawledPage } from '@engine/diagnosis';
import { reportCrawlToApi } from './report.js';

const page: CrawledPage = {
  url: 'https://example.com/',
  entityId: 'ent_1',
  statusCode: 200,
  redirectChain: [],
  indexable: true,
  inSitemap: true,
  title: 'Home',
  metaDescription: 'desc',
  vitals: { lcpMs: 1000, inpMs: 100, cls: 0.01, field: false },
  structuredData: [],
  aiCrawlerAccess: { GPTBot: 'allowed', ClaudeBot: 'allowed', PerplexityBot: 'allowed', 'Google-Extended': 'allowed' },
  hreflang: [],
  expectsHreflang: false,
};

describe('reportCrawlToApi', () => {
  it('POSTs pages to the audit endpoint and returns the parsed body', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const result = await reportCrawlToApi([page], {
      apiBaseUrl: 'https://api.example.com/',
      projectId: 'proj_1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.example.com/projects/proj_1/audit',
      expect.objectContaining({ method: 'POST' }),
    );
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ pages: [page] });
  });

  it('throws with the response body when the API rejects the report', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad request', { status: 400 }));
    await expect(
      reportCrawlToApi([page], { apiBaseUrl: 'https://api.example.com', projectId: 'proj_1', fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow('audit report failed: 400 bad request');
  });
});
