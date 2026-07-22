import { describe, it, expect, vi } from 'vitest';
import type { Action } from '@engine/core';
import {
  getGbpAccessToken,
  deployGbpAction,
  verifyGbpDeploy,
  parseGbpOperation,
  serializeGbpOperation,
  type GbpOperation,
} from './gbp.js';

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

function gbpAction(op: GbpOperation, locationId = 'loc1'): Pick<Action, 'diff' | 'target'> {
  return { diff: { before: '(x)', after: serializeGbpOperation(op), format: 'text' }, target: { kind: 'gbp-api', locationId } };
}

describe('GbpOperation (de)serialization', () => {
  it('round-trips through diff.after', () => {
    const op: GbpOperation = { kind: 'update-field', field: 'description', value: 'Hello' };
    expect(parseGbpOperation({ diff: { before: '', after: serializeGbpOperation(op), format: 'text' } })).toEqual(op);
  });
  it('throws on malformed payload', () => {
    expect(() => parseGbpOperation({ diff: { before: '', after: 'not json', format: 'text' } })).toThrow('valid JSON');
    expect(() => parseGbpOperation({ diff: { before: '', after: '{"x":1}', format: 'text' } })).toThrow('GbpOperation');
  });
});

describe('getGbpAccessToken', () => {
  it('exchanges a refresh token at the OAuth endpoint', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: 'ya29.tok' }));
    const tok = await getGbpAccessToken('refresh', 'cid', 'secret', fetchImpl as unknown as typeof fetch);
    expect(tok).toBe('ya29.tok');
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(init.method).toBe('POST');
    const body = new URLSearchParams(init.body as string);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('refresh');
  });
  it('throws when no access_token comes back', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    await expect(getGbpAccessToken('r', 'c', 's', fetchImpl as unknown as typeof fetch)).rejects.toThrow('no access_token');
  });
});

describe('deployGbpAction', () => {
  it('update-field PATCHes the location with a mask-nested body', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const res = await deployGbpAction('tok', 'loc1', gbpAction({ kind: 'update-field', field: 'description', value: 'A shop.' }), fetchImpl as unknown as typeof fetch);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/locations/loc1?updateMask=profile.description');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ profile: { description: 'A shop.' } });
    expect(res.operation).toBe('update-field');
  });

  it('reply-review PUTs the reply resource', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    await deployGbpAction('tok', 'loc1', gbpAction({ kind: 'reply-review', reviewName: 'accounts/1/locations/2/reviews/3', comment: 'Thanks!' }), fetchImpl as unknown as typeof fetch);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://mybusiness.googleapis.com/v4/accounts/1/locations/2/reviews/3/reply');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ comment: 'Thanks!' });
  });

  it('create-post POSTs a local post', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    await deployGbpAction('tok', 'loc1', gbpAction({ kind: 'create-post', summary: 'Open this weekend!' }), fetchImpl as unknown as typeof fetch);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://mybusiness.googleapis.com/v4/loc1/localPosts');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toMatchObject({ summary: 'Open this weekend!', topicType: 'STANDARD' });
  });

  it('rejects a non-gbp-api target', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const bad = { diff: gbpAction({ kind: 'create-post', summary: 'x' }).diff, target: { kind: 'github-pr', repo: 'a/b', branch: 'main', path: 'x' } } as unknown as Pick<Action, 'diff' | 'target'>;
    await expect(deployGbpAction('tok', 'loc1', bad, fetchImpl as unknown as typeof fetch)).rejects.toThrow('non-gbp-api');
  });

  it('surfaces the HTTP status on API failure', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'nope' }, 403));
    await expect(
      deployGbpAction('tok', 'loc1', gbpAction({ kind: 'create-post', summary: 'x' }), fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow('HTTP 403');
  });
});

describe('verifyGbpDeploy', () => {
  it('passes when the fetched state contains the deployed value', () => {
    expect(verifyGbpDeploy('… description: A shop. …', gbpAction({ kind: 'update-field', field: 'description', value: 'A shop.' }))).toBe(true);
    expect(verifyGbpDeploy('reply: Thanks!', gbpAction({ kind: 'reply-review', reviewName: 'r', comment: 'Thanks!' }))).toBe(true);
  });
  it('fails when the value is absent', () => {
    expect(verifyGbpDeploy('nothing here', gbpAction({ kind: 'create-post', summary: 'Open this weekend!' }))).toBe(false);
  });
});
