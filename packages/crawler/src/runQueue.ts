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
}

export type Outcome = { auditRunId: string } | { error: string };

export interface QueueApi {
  listQueued(): Promise<QueuedRequest[]>;
  /** Null when another runner took it first, or it is no longer queued. */
  claim(id: string): Promise<QueuedRequest | null>;
  finish(id: string, outcome: Outcome): Promise<void>;
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
    async finish(id, outcome) {
      const { status, body } = await call<{ error?: string }>(`/internal/audit-requests/${id}/finish`, { method: 'POST', body: JSON.stringify(outcome) });
      if (status !== 200) throw new Error(`finishing ${id} failed: ${status} ${body.error ?? ''}`.trim());
    },
  };
}
