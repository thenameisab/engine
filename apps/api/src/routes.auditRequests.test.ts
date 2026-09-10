import { describe, expect, it } from 'vitest';
import { app } from './index.js';

/**
 * The audit-request routes at the boundary: validation and the service gate,
 * both of which answer before any database is touched. The unreachable
 * DATABASE_URL proves the order.
 */
const env = {
  AUTH_MODE: 'disabled',
  // A dead loopback port. Refused at once, with no name to look up: the old
  // `never.connected.invalid` host relied on DNS failing quickly, and on CI it
  // did not — three role reads against it timed out a 5-second test.
  DATABASE_URL: 'postgres://127.0.0.1:1/db',
  INTERNAL_API_TOKEN: 'service-token-for-tests',
} as const;

/**
 * AUTH_MODE=disabled short-circuits requireAuth with a development user, so the
 * service-token path never runs under it. The machine-caller tests use this env
 * instead, where the bearer token is the only way in.
 */
const serviceEnv = {
  DATABASE_URL: env.DATABASE_URL,
  INTERNAL_API_TOKEN: env.INTERNAL_API_TOKEN,
} as const;
const auth = { authorization: `Bearer ${env.INTERNAL_API_TOKEN}` };

const PROJECT = '11111111-1111-4111-8111-111111111111';

function post(path: string, body: unknown, headers: Record<string, string> = {}, useEnv: object = env): Promise<Response> {
  return app.request(
    path,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
    useEnv,
  );
}

describe('POST /projects/:projectId/audit-requests', () => {
  it('rejects a non-uuid project id before touching the database', async () => {
    const res = await post('/projects/proj_1/audit-requests', {});
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe('projectId');
  });

  it('bounds maxPages', async () => {
    const res = await post(`/projects/${PROJECT}/audit-requests`, { maxPages: 5000 });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'invalid maxPages: expected an integer from 1 to 500, got 5000',
      field: 'maxPages',
    });
  });

  it('rejects a fractional page cap', async () => {
    const res = await post(`/projects/${PROJECT}/audit-requests`, { maxPages: 2.5 });
    expect(res.status).toBe(400);
  });

  it('rejects a non-string entityId', async () => {
    const res = await post(`/projects/${PROJECT}/audit-requests`, { entityId: 7 });
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe('entityId');
  });
});

describe('/internal/audit-requests', () => {
  it('is 401 with no credential at all', async () => {
    const res = await app.request('/internal/audit-requests', { method: 'GET' }, serviceEnv);
    expect(res.status).toBe(401);
  });

  it('is 404 for a signed-in person, so the machine door is not advertised', async () => {
    const res = await app.request('/internal/audit-requests', { method: 'GET' }, env);
    expect(res.status).toBe(404);
  });

  it('is 404 for a person on claim and finish too', async () => {
    expect((await post(`/internal/audit-requests/${PROJECT}/claim`, {})).status).toBe(404);
    expect((await post(`/internal/audit-requests/${PROJECT}/finish`, { error: 'x' })).status).toBe(404);
  });

  it('admits the service token, then validates the id before the database', async () => {
    const res = await post('/internal/audit-requests/not-a-uuid/claim', {}, auth, serviceEnv);
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe('id');
  });

  it('finish needs exactly one of auditRunId or error', async () => {
    const both = await post(`/internal/audit-requests/${PROJECT}/finish`, { auditRunId: 'r', error: 'e' }, auth, serviceEnv);
    expect(both.status).toBe(400);
    const neither = await post(`/internal/audit-requests/${PROJECT}/finish`, {}, auth, serviceEnv);
    expect(neither.status).toBe(400);
  });

  it('refuses an unknown status filter', async () => {
    const res = await app.request('/internal/audit-requests?status=done', { method: 'GET', headers: auth }, serviceEnv);
    expect(res.status).toBe(400);
  });
});

describe('POST /projects/:projectId/findings/propose-batch', () => {
  it('requires an issueType, and says so before touching the database', async () => {
    const res = await post(`/projects/${PROJECT}/findings/propose-batch`, {});
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe('issueType');
  });

  it('refuses a blank issueType rather than proposing for everything', async () => {
    // The failure this prevents is not an error message: an empty string that
    // matched nothing would 404, but one that matched *every* finding would
    // queue a fix for every page on the site from one click.
    const res = await post(`/projects/${PROJECT}/findings/propose-batch`, { issueType: '   ' });
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe('issueType');
  });

  it('rejects a body that is not JSON', async () => {
    const res = await post(`/projects/${PROJECT}/findings/propose-batch`, 'not json');
    expect(res.status).toBe(400);
  });
});
