/**
 * Ships a completed crawl to `apps/api`'s `POST /projects/:id/audit` — the
 * out-of-band side of the contract that endpoint was built for (B1.1 crawl
 * runs off-edge; the diagnosis rule engine takes `CrawledPage[]` directly).
 */
import type { CrawledPage } from '@engine/diagnosis';

export interface ReportCrawlOptions {
  apiBaseUrl: string;
  projectId: string;
  fetchImpl?: typeof fetch;
}

export async function reportCrawlToApi(pages: CrawledPage[], options: ReportCrawlOptions): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${options.apiBaseUrl.replace(/\/$/, '')}/projects/${options.projectId}/audit`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pages }),
  });
  if (!res.ok) {
    throw new Error(`audit report failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}
