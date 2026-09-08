/**
 * Start the crawl workflow on GitHub Actions right away, instead of waiting for
 * its 15-minute schedule (docs/46-Audit-Runner.md, Option A with dispatch).
 *
 * Best effort by design: a failure here is logged and the request stays
 * queued, because the schedule will pick it up. The token is platform-owned
 * (it starts a workflow in this repository), so it is not the per-customer
 * GitHub credential problem the ship-readiness review raises about deploys.
 */
export interface DispatchEnv {
  /** Fine-grained token with `actions: write` on the repository. Unset means never dispatch. */
  GITHUB_DISPATCH_TOKEN?: string;
  /** owner/name. Defaults to this product's repository. */
  GITHUB_DISPATCH_REPO?: string;
  /** Branch the workflow runs from. */
  GITHUB_DISPATCH_REF?: string;
  /** Workflow file name under .github/workflows. */
  GITHUB_DISPATCH_WORKFLOW?: string;
}

export interface DispatchResult {
  dispatched: boolean;
  /** Why not, when not. Safe to log; never includes the token. */
  reason?: string;
}

const DEFAULT_REPO = 'thenameisab/engine';
const DEFAULT_REF = 'main';
const DEFAULT_WORKFLOW = 'crawl.yml';
const TIMEOUT_MS = 5000;

export async function dispatchCrawlWorkflow(env: DispatchEnv, fetchImpl: typeof fetch = fetch): Promise<DispatchResult> {
  if (!env.GITHUB_DISPATCH_TOKEN) return { dispatched: false, reason: 'no dispatch token configured' };
  const repo = env.GITHUB_DISPATCH_REPO ?? DEFAULT_REPO;
  const workflow = env.GITHUB_DISPATCH_WORKFLOW ?? DEFAULT_WORKFLOW;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'engine-api',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ref: env.GITHUB_DISPATCH_REF ?? DEFAULT_REF }),
      signal: controller.signal,
    });
    if (res.status === 204) return { dispatched: true };
    return { dispatched: false, reason: `GitHub answered ${res.status}` };
  } catch (err) {
    return { dispatched: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
