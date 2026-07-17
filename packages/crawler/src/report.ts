/**
 * Ships a completed crawl to `apps/api`'s `POST /projects/:id/audit` — the
 * out-of-band side of the contract that endpoint was built for (B1.1 crawl
 * runs off-edge; the diagnosis rule engine takes `CrawledPage[]` directly).
 *
 * `/projects/*` is gated (PR #21), so a report needs a credential. The crawler
 * has no user session — it is a machine caller like the edge worker, so it
 * presents the same shared service token rather than a Neon Auth JWT.
 */
import type { CrawledPage } from '@engine/diagnosis';

export interface ReportCrawlOptions {
  apiBaseUrl: string;
  projectId: string;
  /**
   * Shared service token (`INTERNAL_API_TOKEN` on the API). Optional so a
   * locally-run API with `AUTH_MODE=disabled` still works; against any gated
   * API its absence is a 401, which `reportCrawlToApi` explains rather than
   * leaving as a bare status code.
   */
  token?: string;
  fetchImpl?: typeof fetch;
}

export async function reportCrawlToApi(pages: CrawledPage[], options: ReportCrawlOptions): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${options.apiBaseUrl.replace(/\/$/, '')}/projects/${options.projectId}/audit`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: JSON.stringify({ pages }),
  });
  if (!res.ok) {
    // A crawl is expensive; losing one to an unexplained 401 is the difference
    // between a fixable config mistake and a mystery. Name the cause.
    const hint =
      (res.status === 401 || res.status === 403) && !options.token
        ? ' (no service token sent — set ENGINE_API_TOKEN to the API\'s INTERNAL_API_TOKEN)'
        : '';
    throw new Error(`audit report failed: ${res.status} ${await res.text()}${hint}`);
  }
  return res.json();
}
