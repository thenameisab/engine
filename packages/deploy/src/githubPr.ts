/**
 * C4.5 "GitHub PR export" — the 'github-pr' `DeployTarget` frozen in
 * `@engine/core`'s contract since the first scaffold commit, never
 * implemented. For a headless site there is no edge worker or CMS plugin to
 * push a fix into; the fix has to land as a reviewable change to a source
 * file in the customer's repo, per C4.5's own note ("for headless sites —
 * fixes as reviewable PRs").
 *
 * Unlike the other deploy targets in this package, this one is genuinely I/O
 * (branch refs, blob SHAs, a real GitHub API round-trip) — there is no pure
 * string transform to unit-test the way `html.ts`/`robots.ts` are. Calls
 * GitHub's REST API directly via `fetch` (same reasoning as
 * `packages/billing/src/checkout.ts` for Stripe): no SDK dependency, and
 * `fetchImpl` is injectable so the request shapes are still fully
 * unit-testable without a live token or repo.
 */
import type { Action } from '@engine/core';

const GITHUB_API = 'https://api.github.com';

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function githubJson<T>(
  path: string,
  token: string,
  fetchImpl: typeof fetch,
  init?: RequestInit,
): Promise<T> {
  const res = await fetchImpl(`${GITHUB_API}${path}`, {
    ...init,
    headers: { ...authHeaders(token), 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`GitHub API ${init?.method ?? 'GET'} ${path} failed: HTTP ${res.status} ${detail}`);
  }
  return (await res.json()) as T;
}

/** The commit sha a branch currently points at. */
export async function getBranchSha(
  token: string,
  repo: string,
  branch: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const ref = await githubJson<{ object: { sha: string } }>(
    `/repos/${repo}/git/ref/heads/${branch}`,
    token,
    fetchImpl,
  );
  return ref.object.sha;
}

/** Create a new branch pointing at `fromSha`. */
export async function createBranch(
  token: string,
  repo: string,
  newBranch: string,
  fromSha: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await githubJson(`/repos/${repo}/git/refs`, token, fetchImpl, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${newBranch}`, sha: fromSha }),
  });
}

/** The blob sha of an existing file on a branch, or null if the file doesn't exist yet (a new file needs no `sha` on create). */
export async function getFileSha(
  token: string,
  repo: string,
  path: string,
  branch: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const res = await fetchImpl(`${GITHUB_API}/repos/${repo}/contents/${path}?ref=${branch}`, {
    headers: authHeaders(token),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub API GET /repos/${repo}/contents/${path} failed: HTTP ${res.status}`);
  const body = (await res.json()) as { sha: string };
  return body.sha;
}

/** Create or update a file's content on a branch. `sha` is required to update an existing file, omitted to create a new one. */
export async function putFileContent(
  token: string,
  repo: string,
  path: string,
  branch: string,
  content: string,
  message: string,
  sha: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await githubJson(`/repos/${repo}/contents/${path}`, token, fetchImpl, {
    method: 'PUT',
    body: JSON.stringify({
      message,
      content: base64Encode(content),
      branch,
      ...(sha ? { sha } : {}),
    }),
  });
}

export interface OpenedPullRequest {
  url: string;
  number: number;
}

/** Open a PR from `head` into `base`. */
export async function openPullRequest(
  token: string,
  repo: string,
  input: { title: string; body: string; head: string; base: string },
  fetchImpl: typeof fetch = fetch,
): Promise<OpenedPullRequest> {
  const pr = await githubJson<{ html_url: string; number: number }>(`/repos/${repo}/pulls`, token, fetchImpl, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return { url: pr.html_url, number: pr.number };
}

function base64Encode(s: string): string {
  // Web-standard btoa is bytewise; encode via UTF-8 bytes first so non-ASCII
  // diff content (accented names, curly quotes) round-trips correctly.
  const bytes = new TextEncoder().encode(s);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function prBody(action: Pick<Action, 'id' | 'type' | 'diff'>): string {
  return [
    `Engine proposed this ${action.type} fix (action \`${action.id}\`).`,
    '',
    '```diff',
    `- ${action.diff.before || '(none)'}`,
    `+ ${action.diff.after}`,
    '```',
  ].join('\n');
}

/**
 * Export one approved Action as a real PR: branch off the target's base
 * branch, write the diff's `after` content to the target's `path`, open a PR
 * describing the fix. The branch name is derived from the action id so a
 * re-export (e.g. a retried deploy) is idempotent at the branch level rather
 * than piling up duplicate branches.
 */
export async function exportActionAsPr(
  token: string,
  action: Pick<Action, 'id' | 'type' | 'diff' | 'target'>,
  fetchImpl: typeof fetch = fetch,
): Promise<OpenedPullRequest> {
  if (action.target.kind !== 'github-pr') {
    throw new Error(`exportActionAsPr called with a non-github-pr target: ${action.target.kind}`);
  }
  const { repo, branch: base, path } = action.target;
  const head = `engine-fix/${action.id.slice(0, 8)}`;

  const baseSha = await getBranchSha(token, repo, base, fetchImpl);
  await createBranch(token, repo, head, baseSha, fetchImpl);
  const existingSha = await getFileSha(token, repo, path, head, fetchImpl);
  await putFileContent(
    token,
    repo,
    path,
    head,
    action.diff.after,
    `Engine: ${action.type} fix (${action.id})`,
    existingSha,
    fetchImpl,
  );
  return openPullRequest(
    token,
    repo,
    { title: `Engine: ${action.type} fix`, body: prBody(action), head, base },
    fetchImpl,
  );
}
