/**
 * GitHub's `pull_request` webhook: the fast path to "this fix is live".
 *
 * A `github-pr` deploy means the pull request is open. Nothing on the
 * customer's site changes until someone merges it, so the page check has to
 * wait for the merge. `scheduledPrMergeCheck` in the API finds merges by
 * polling each open PR once a night, which is correct and slow: a customer who
 * merges at 09:00 sees "Verified" the next morning.
 *
 * This turns that into seconds. The scheduled pass stays — a webhook can be
 * mis-delivered, arrive while the API is down, or never be configured at all,
 * and a verification that only ever happens on a delivery that failed is no
 * verification.
 *
 * Verified against Web Crypto rather than an SDK, the same reasoning as
 * `packages/billing/src/signature.ts`: the algorithm is HMAC-SHA256 over the
 * raw body, so it is fully testable with no live App.
 * https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
 */

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time equality for two equal-length hex strings. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify a raw delivery body against the `X-Hub-Signature-256` header.
 *
 * Simpler than Stripe's: one signature, no timestamp, so no replay window to
 * tune. Replaying a merge delivery is harmless here — the handler enqueues a
 * verification, and `createVerifyRequest` already refuses a second one while
 * the first is live.
 *
 * The `sha256=` prefix is required, not optional. A bare hex digest means the
 * caller sent the older `X-Hub-Signature` (SHA-1) value under the new header
 * name, and accepting it would accept a weaker algorithm by accident.
 */
export async function verifyGithubSignature(
  payload: string,
  sigHeader: string | undefined | null,
  secret: string,
): Promise<boolean> {
  if (!sigHeader) return false;
  const [algorithm, presented] = sigHeader.split('=');
  if (algorithm !== 'sha256' || !presented) return false;
  return timingSafeEqual(presented.toLowerCase(), await hmacSha256Hex(secret, payload));
}

export interface MergedPullRequest {
  /** `owner/name`, matching the `github-pr` DeployTarget's `repo`. */
  repo: string;
  number: number;
}

/**
 * The merged pull request a delivery describes, or null for every other
 * delivery.
 *
 * Null is the common case and not an error: GitHub sends `opened`,
 * `synchronize`, `labeled` and a dozen others on the same event, plus whatever
 * else the App is subscribed to. The caller answers 200 to all of them —
 * refusing a delivery it simply has no interest in would make GitHub retry it
 * and eventually disable the endpoint.
 *
 * `merged` is what separates a merge from an abandonment: `action: 'closed'`
 * arrives for both.
 */
export function mergedPullRequestFrom(event: unknown): MergedPullRequest | null {
  if (typeof event !== 'object' || event === null) return null;
  const e = event as {
    action?: unknown;
    pull_request?: { number?: unknown; merged?: unknown; merged_at?: unknown } | null;
    repository?: { full_name?: unknown } | null;
  };
  if (e.action !== 'closed') return null;
  const pr = e.pull_request;
  if (!pr || typeof pr.number !== 'number') return null;
  if (pr.merged !== true && (pr.merged_at ?? null) === null) return null;
  const repo = e.repository?.full_name;
  if (typeof repo !== 'string' || repo === '') return null;
  return { repo, number: pr.number };
}
