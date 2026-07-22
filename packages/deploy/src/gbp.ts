/**
 * C5 "GBP automation" — the executor for the 'gbp-api' `DeployTarget` frozen in
 * `@engine/core`'s contract, never implemented. B5's local audit emits
 * `source:'local'` findings (incomplete GBP field, unanswered reviews, thin
 * post/review velocity) whose `gbp` actions land here: a real Google Business
 * Profile API write.
 *
 * Like `githubPr.ts` (and for the same reasons) this is genuinely I/O — an
 * OAuth token exchange plus a Business Profile REST round-trip — with no pure
 * string transform to unit-test the way `html.ts`/`robots.ts` are. Calls the
 * Google APIs directly via `fetch` (no SDK dependency), and `fetchImpl` is
 * injectable so every request shape is fully unit-testable without live
 * credentials or a real listing.
 *
 * The Business Profile APIs are split across hosts and gated behind Google's
 * access-request/quota approval; the request shapes here follow the documented
 * v1 (business information) and v4 (reviews/posts) surfaces.
 */
import type { Action } from '@engine/core';

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const INFO_API = 'https://mybusinessbusinessinformation.googleapis.com/v1';
const ENGAGE_API = 'https://mybusiness.googleapis.com/v4';

/**
 * The concrete GBP write an action performs. Serialized into the action's
 * `diff.after` at generation time (`@engine/actions`' `generateGbpAction`) so
 * the executor is a pure function of the Action — the Fix Queue's diff preview
 * still shows a human-readable `before → after`, and this structured op is what
 * actually hits the API.
 */
export type GbpOperation =
  | { kind: 'update-field'; field: 'description' | 'title' | 'categories' | 'regularHours' | 'attributes'; value: string }
  | { kind: 'reply-review'; reviewName: string; comment: string }
  | { kind: 'create-post'; summary: string };

/** Parse the GbpOperation an action carries in `diff.after`. Throws on a malformed payload. */
export function parseGbpOperation(action: Pick<Action, 'diff'>): GbpOperation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(action.diff.after);
  } catch {
    throw new Error('gbp action diff.after is not valid JSON');
  }
  const op = parsed as GbpOperation;
  if (!op || typeof op !== 'object' || !('kind' in op)) throw new Error('gbp action diff.after is not a GbpOperation');
  return op;
}

/** Serialize a GbpOperation for storage in a Diff's `after`. */
export function serializeGbpOperation(op: GbpOperation): string {
  return JSON.stringify(op);
}

async function googleJson<T>(url: string, token: string, fetchImpl: typeof fetch, init?: RequestInit): Promise<T> {
  const res = await fetchImpl(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`GBP API ${init?.method ?? 'GET'} ${url} failed: HTTP ${res.status} ${detail}`);
  }
  return (await res.json()) as T;
}

/**
 * Exchange a long-lived refresh token for a short-lived access token. Kept
 * separate from the writes (and from any per-location credential storage) so
 * the caller owns how the refresh token is obtained/stored — the API layer
 * reads it from a Worker secret today, the same simplification `githubPr` makes
 * with `GITHUB_TOKEN`.
 */
export async function getGbpAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetchImpl(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`GBP OAuth token exchange failed: HTTP ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error('GBP OAuth token exchange returned no access_token');
  return json.access_token;
}

/** The updateMask field path for each updatable location field. */
const FIELD_MASK: Record<Extract<GbpOperation, { kind: 'update-field' }>['field'], string> = {
  description: 'profile.description',
  title: 'title',
  categories: 'categories',
  regularHours: 'regularHours',
  attributes: 'attributes',
};

export interface GbpDeployResult {
  operation: GbpOperation['kind'];
  target: string;
}

/**
 * Execute one approved `gbp` Action against the Business Profile API. Dispatches
 * on the parsed GbpOperation: a field update PATCHes the location, a review
 * reply PUTs the reply resource, a post POSTs a local post. `locationId` is the
 * action target's location (the API layer passes it from the `gbp-api` target).
 */
export async function deployGbpAction(
  accessToken: string,
  locationId: string,
  action: Pick<Action, 'diff' | 'target'>,
  fetchImpl: typeof fetch = fetch,
): Promise<GbpDeployResult> {
  if (action.target.kind !== 'gbp-api') {
    throw new Error(`deployGbpAction called with a non-gbp-api target: ${action.target.kind}`);
  }
  const op = parseGbpOperation(action);

  switch (op.kind) {
    case 'update-field': {
      const mask = FIELD_MASK[op.field];
      const url = `${INFO_API}/locations/${locationId}?updateMask=${encodeURIComponent(mask)}`;
      // The field value is stored as text; nest it under the mask's leaf so the
      // PATCH body matches the mask. `profile.description` -> { profile: { description } }.
      const body = mask.includes('.')
        ? { [mask.split('.')[0]]: { [mask.split('.')[1]]: op.value } }
        : { [mask]: op.value };
      await googleJson(url, accessToken, fetchImpl, { method: 'PATCH', body: JSON.stringify(body) });
      return { operation: op.kind, target: `locations/${locationId}` };
    }
    case 'reply-review': {
      const url = `${ENGAGE_API}/${op.reviewName}/reply`;
      await googleJson(url, accessToken, fetchImpl, { method: 'PUT', body: JSON.stringify({ comment: op.comment }) });
      return { operation: op.kind, target: op.reviewName };
    }
    case 'create-post': {
      const url = `${ENGAGE_API}/${locationId}/localPosts`;
      await googleJson(url, accessToken, fetchImpl, {
        method: 'POST',
        body: JSON.stringify({ languageCode: 'en', summary: op.summary, topicType: 'STANDARD' }),
      });
      return { operation: op.kind, target: `${locationId}/localPosts` };
    }
  }
}

/**
 * Verify a deployed GBP action landed, given the location/review state the
 * caller fetched back. Pure (no I/O) so it is integration-testable alongside
 * the other `verify*` checks: the deployed value must be present in the
 * fetched-back content.
 */
export function verifyGbpDeploy(fetched: string, action: Pick<Action, 'diff'>): boolean {
  const op = parseGbpOperation(action);
  const needle = op.kind === 'reply-review' ? op.comment : op.kind === 'create-post' ? op.summary : op.value;
  return needle.trim() !== '' && fetched.includes(needle.trim());
}
