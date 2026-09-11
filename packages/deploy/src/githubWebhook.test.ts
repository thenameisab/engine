import { describe, it, expect } from 'vitest';
import { verifyGithubSignature, mergedPullRequestFrom } from './githubWebhook.js';

const SECRET = 'a-long-random-webhook-secret';

/** The header GitHub would send for this body and secret. */
async function sign(payload: string, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256=${hex}`;
}

describe('verifyGithubSignature', () => {
  const body = '{"action":"closed"}';

  it('accepts a delivery signed with the shared secret', async () => {
    expect(await verifyGithubSignature(body, await sign(body), SECRET)).toBe(true);
  });

  it('accepts the digest in upper case, which the spec does not forbid', async () => {
    const header = (await sign(body)).toUpperCase().replace('SHA256', 'sha256');
    expect(await verifyGithubSignature(body, header, SECRET)).toBe(true);
  });

  it('refuses a body that changed after it was signed', async () => {
    const header = await sign(body);
    expect(await verifyGithubSignature('{"action":"opened"}', header, SECRET)).toBe(false);
  });

  it('refuses a signature made with a different secret', async () => {
    expect(await verifyGithubSignature(body, await sign(body, 'someone-elses-secret'), SECRET)).toBe(false);
  });

  it('refuses a missing or empty header rather than treating it as unsigned-and-fine', async () => {
    expect(await verifyGithubSignature(body, undefined, SECRET)).toBe(false);
    expect(await verifyGithubSignature(body, null, SECRET)).toBe(false);
    expect(await verifyGithubSignature(body, '', SECRET)).toBe(false);
  });

  it('requires the sha256 prefix, so the older SHA-1 value cannot pass by accident', async () => {
    // A caller sending `X-Hub-Signature`'s value under the -256 header name.
    const hex = (await sign(body)).slice('sha256='.length);
    expect(await verifyGithubSignature(body, hex, SECRET)).toBe(false);
    expect(await verifyGithubSignature(body, `sha1=${hex}`, SECRET)).toBe(false);
  });

  it('refuses a header with the right prefix and nothing after it', async () => {
    expect(await verifyGithubSignature(body, 'sha256=', SECRET)).toBe(false);
  });
});

describe('mergedPullRequestFrom', () => {
  const closed = (over: object = {}) => ({
    action: 'closed',
    pull_request: { number: 42, merged: true, ...over },
    repository: { full_name: 'acme/site' },
  });

  it('reads the repository and number off a merged pull request', () => {
    expect(mergedPullRequestFrom(closed())).toEqual({ repo: 'acme/site', number: 42 });
  });

  it('accepts merged_at, which some payload shapes carry instead of merged', () => {
    expect(mergedPullRequestFrom(closed({ merged: undefined, merged_at: '2026-09-11T09:00:00Z' })))
      .toEqual({ repo: 'acme/site', number: 42 });
  });

  it('ignores a pull request that was closed without merging', () => {
    // `action: 'closed'` arrives for both; `merged` is the whole difference.
    expect(mergedPullRequestFrom(closed({ merged: false, merged_at: null }))).toBeNull();
  });

  it('ignores every other action on the same event', () => {
    for (const action of ['opened', 'synchronize', 'reopened', 'labeled', 'edited']) {
      expect(mergedPullRequestFrom({ ...closed(), action })).toBeNull();
    }
  });

  it('ignores a delivery for a different event entirely', () => {
    // The App may be subscribed to more than pull requests; these are answered
    // 200 and dropped, not refused.
    expect(mergedPullRequestFrom({ action: 'closed', issue: { number: 4 } })).toBeNull();
    expect(mergedPullRequestFrom({ zen: 'Non-blocking is better than blocking.', hook_id: 1 })).toBeNull();
  });

  it('refuses a payload missing the repository or the number', () => {
    expect(mergedPullRequestFrom({ ...closed(), repository: null })).toBeNull();
    expect(mergedPullRequestFrom({ ...closed(), repository: { full_name: '' } })).toBeNull();
    expect(mergedPullRequestFrom(closed({ number: undefined }))).toBeNull();
    expect(mergedPullRequestFrom(closed({ number: '42' }))).toBeNull();
  });

  it('survives anything that is not an object', () => {
    for (const junk of [null, undefined, 'closed', 42, []]) {
      expect(mergedPullRequestFrom(junk)).toBeNull();
    }
  });
});
