/**
 * Drain the audit-request queue: list what is queued, claim each request,
 * crawl it, report, mark it done or failed. The API owns the queue
 * (docs/46-Audit-Runner.md); this is the only consumer.
 *
 * Logging names request ids and counts only. The runner's first home is a
 * GitHub Action on a public repository, where every log line is public, and a
 * customer's domain is not ours to publish.
 */

export interface QueuedRequest {
  id: string;
  projectId: string;
  entityId: string;
  rootUrl: string;
  maxPages: number;
  /**
   * What this request is for. Absent from an API that predates verification,
   * which is treated as a crawl — the old behaviour, unchanged.
   */
  kind?: 'crawl' | 'verify';
  /** The fix being checked, on a verify request. */
  actionId?: string | null;
}

export type Outcome = { auditRunId: string } | { error: string };

export interface QueueApi {
  listQueued(): Promise<QueuedRequest[]>;
  /** Null when another runner took it first, or it is no longer queued. */
  claim(id: string): Promise<QueuedRequest | null>;
  finish(id: string, outcome: Outcome): Promise<void>;
  /**
   * Report what was on the live page. The API owns the matching: the Action and
   * its diff live in its database, and shipping them to a public GitHub Action
   * so it could compare them itself would send a customer's proposed content
   * somewhere it does not need to go.
   */
  reportVerify(id: string, result: VerifyReport): Promise<void>;
}

export type VerifyReport = { renderedHtml: string } | { robotsTxt: string } | { error: string };

/**
 * Fetch what a verify request points at. A robots fix is checked against the
 * site's robots.txt; everything else against the page itself.
 *
 * A failed fetch is a report, not a throw: "we could not reach the page" is
 * something the customer needs told, and it is not the same as "the change is
 * not there".
 */
export async function fetchForVerify(
  request: QueuedRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<VerifyReport> {
  try {
    const target = new URL(request.rootUrl);
    const res = await fetchImpl(target.toString());
    if (!res.ok) return { error: `the page answered ${res.status}` };
    const body = await res.text();
    return target.pathname === '/robots.txt' ? { robotsTxt: body } : { renderedHtml: body };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export interface CrawlOutcome {
  pagesCrawled: number;
  auditRunId: string;
}

export interface RunQueueResult {
  seen: number;
  claimed: number;
  done: number;
  failed: number;
}

export async function runQueue(
  api: QueueApi,
  crawl: (request: QueuedRequest) => Promise<CrawlOutcome>,
  log: (line: string) => void = () => {},
  verifyFetch: (request: QueuedRequest) => Promise<VerifyReport> = (r) => fetchForVerify(r),
): Promise<RunQueueResult> {
  const queued = await api.listQueued();
  const result: RunQueueResult = { seen: queued.length, claimed: 0, done: 0, failed: 0 };
  log(`${queued.length} request(s) queued`);

  for (const item of queued) {
    const request = await api.claim(item.id);
    if (!request) {
      log(`${item.id}: claimed elsewhere, skipping`);
      continue;
    }
    result.claimed += 1;

    // A verify is one HTTP GET and no browser. Handled before the crawl branch
    // so a queue holding both drains both, which is the whole reason the two
    // share one queue.
    if (request.kind === 'verify') {
      log(`${request.id}: checking a deployed fix`);
      const report = await verifyFetch(request);
      await api.reportVerify(request.id, report);
      result.done += 1;
      log(`${request.id}: checked`);
      continue;
    }

    log(`${request.id}: crawling up to ${request.maxPages} page(s)`);
    try {
      const outcome = await crawl(request);
      await api.finish(request.id, { auditRunId: outcome.auditRunId });
      result.done += 1;
      log(`${request.id}: done, ${outcome.pagesCrawled} page(s) audited`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The message can carry the site's URL (a fetch failure names its target),
      // so it goes to the API, where the customer reads it, and not to the log.
      await api.finish(request.id, { error: message.slice(0, 1000) }).catch(() => {});
      result.failed += 1;
      log(`${request.id}: failed`);
    }
  }
  return result;
}

/** The API's /internal/audit-requests routes, as a QueueApi. */
export function createQueueApi(options: { apiBaseUrl: string; token: string; fetchImpl?: typeof fetch }): QueueApi {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.apiBaseUrl.replace(/\/$/, '');
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${options.token}` };

  async function call<T>(path: string, init: RequestInit): Promise<{ status: number; body: T }> {
    const res = await fetchImpl(`${base}${path}`, { ...init, headers });
    const text = await res.text();
    let body: T;
    try {
      body = JSON.parse(text) as T;
    } catch {
      body = {} as T;
    }
    return { status: res.status, body };
  }

  return {
    async listQueued() {
      const { status, body } = await call<{ requests: QueuedRequest[]; error?: string }>('/internal/audit-requests?status=queued', { method: 'GET' });
      if (status !== 200) throw new Error(`listing the queue failed: ${status} ${body.error ?? ''}`.trim());
      return body.requests;
    },
    async claim(id) {
      const { status, body } = await call<{ request: QueuedRequest; error?: string }>(`/internal/audit-requests/${id}/claim`, { method: 'POST', body: '{}' });
      if (status === 409) return null;
      if (status !== 200) throw new Error(`claiming ${id} failed: ${status} ${body.error ?? ''}`.trim());
      return body.request;
    },
    async reportVerify(id, result) {
      const { status, body } = await call<{ error?: string }>(`/internal/audit-requests/${id}/verify-result`, {
        method: 'POST',
        body: JSON.stringify(result),
      });
      if (status !== 200) throw new Error(`reporting the check for ${id} failed: ${status} ${body.error ?? ''}`.trim());
    },
    async finish(id, outcome) {
      const { status, body } = await call<{ error?: string }>(`/internal/audit-requests/${id}/finish`, { method: 'POST', body: JSON.stringify(outcome) });
      if (status !== 200) throw new Error(`finishing ${id} failed: ${status} ${body.error ?? ''}`.trim());
    },
  };
}
