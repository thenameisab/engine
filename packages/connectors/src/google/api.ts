/**
 * Shared request plumbing for Google's REST APIs, and the error type the
 * product needs to act on.
 *
 * A bare `res.ok` check is not enough here. The three failures a first-time
 * Google integration actually hits are all HTTP 403 with different bodies —
 * the API is not enabled on the Cloud project, the quota is zero pending an
 * access request (Business Profile), or the user's token does not cover the
 * resource — and they need different responses from us: fix the console, wait
 * for approval, ask the user to reconnect. Collapsing them into "403 Forbidden"
 * is what turns a five-minute fix into an afternoon.
 */

export type GoogleApiFailure =
  /** The API is not enabled on the OAuth client's Cloud project. */
  | 'api-not-enabled'
  /** Enabled, but quota is zero pending an approved access request (GBP). */
  | 'quota-not-granted'
  /** The token is expired or revoked — the connection needs re-consent. */
  | 'unauthorized'
  /** Authenticated, but this account cannot see this resource. */
  | 'forbidden'
  /** Rate limited. Retry later; not a configuration problem. */
  | 'rate-limited'
  /** The resource does not exist (deleted property, wrong id). */
  | 'not-found'
  /** Anything else, including Google's 5xx. */
  | 'unknown';

export class GoogleApiError extends Error {
  readonly failure: GoogleApiFailure;
  readonly status: number;
  /** Google's raw message, kept for logs. Never contains our credentials. */
  readonly detail: string;

  constructor(failure: GoogleApiFailure, status: number, detail: string, context: string) {
    super(`Google API ${context} failed (${failure}, HTTP ${status}): ${detail}`);
    this.name = 'GoogleApiError';
    this.failure = failure;
    this.status = status;
    this.detail = detail;
  }

  /**
   * True when re-consenting would fix this. Drives moving a connection to
   * 'needs_reauth' rather than leaving it 'connected' and quietly broken.
   */
  get needsReauth(): boolean {
    return this.failure === 'unauthorized';
  }

  /** True when retrying the same call later could succeed. */
  get retryable(): boolean {
    return this.failure === 'rate-limited' || (this.failure === 'unknown' && this.status >= 500);
  }
}

/**
 * Classify a Google error response. Google returns 403 for several unrelated
 * causes and only the message body distinguishes them, so this reads the body
 * rather than the status alone.
 */
export function classifyGoogleError(status: number, body: string): GoogleApiFailure {
  const lower = body.toLowerCase();
  if (status === 401) return 'unauthorized';
  if (status === 429) return 'rate-limited';
  if (status === 404) return 'not-found';
  if (status === 403) {
    // "has not been used in project X before or it is disabled"
    if (lower.includes('has not been used in project') || lower.includes('is disabled')) return 'api-not-enabled';
    if (lower.includes('accessnotconfigured') || lower.includes('service_disabled')) return 'api-not-enabled';
    // Business Profile returns a zero-quota 403 until an access request is
    // approved. It reads like a rate limit but no amount of waiting helps.
    if (lower.includes('quota') && (lower.includes('exceeded') || lower.includes('limit'))) return 'quota-not-granted';
    if (lower.includes('rate limit') || lower.includes('ratelimitexceeded')) return 'rate-limited';
    return 'forbidden';
  }
  return 'unknown';
}

/** GET a Google JSON endpoint with a bearer token, classifying failures. */
export async function googleGet<T>(
  url: string,
  accessToken: string,
  context: string,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  return googleRequest<T>(url, accessToken, context, fetchImpl, { method: 'GET' });
}

/** POST JSON to a Google endpoint with a bearer token, classifying failures. */
export async function googlePost<T>(
  url: string,
  accessToken: string,
  body: unknown,
  context: string,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  return googleRequest<T>(url, accessToken, context, fetchImpl, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

async function googleRequest<T>(
  url: string,
  accessToken: string,
  context: string,
  fetchImpl: typeof fetch,
  init: RequestInit,
): Promise<T> {
  const res = await fetchImpl(url, {
    ...init,
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new GoogleApiError(classifyGoogleError(res.status, detail), res.status, detail.slice(0, 500), context);
  }
  // Some Google endpoints answer 200 with an empty body (an empty list, a
  // successful write with no return). JSON.parse would throw on that, so an
  // empty body becomes an empty object and the caller's optional-field handling
  // does the rest.
  const text = await res.text();
  if (text.trim() === '') return {} as T;
  return JSON.parse(text) as T;
}

/**
 * Walk a paginated Google list endpoint, following `nextPageToken`.
 *
 * Bounded by `maxPages`. An unbounded loop over a paging token we do not
 * control is a hang waiting to happen, and a caller that silently stops early
 * is worse than one that says how far it got — so hitting the cap is reported,
 * not swallowed.
 */
export async function paginate<T>(
  fetchPage: (pageToken?: string) => Promise<{ items: T[]; nextPageToken?: string }>,
  maxPages = 20,
): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const result = await fetchPage(pageToken);
    items.push(...result.items);
    if (!result.nextPageToken) return { items, truncated: false };
    pageToken = result.nextPageToken;
  }
  return { items, truncated: true };
}
