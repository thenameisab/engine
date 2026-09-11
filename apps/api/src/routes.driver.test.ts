import { describe, expect, it } from 'vitest';
import { app } from './index.js';

/**
 * The Driver route at the boundary.
 *
 * Like the other `routes.*.test.ts` files, these need no database: every
 * rejection here happens before `createDb`, and a `DATABASE_URL` that cannot
 * connect is what proves the ordering. A validation error that only surfaces
 * after a connection attempt is a validation error that costs a round trip and
 * fails differently when the database is slow.
 */
const env = {
  AUTH_MODE: 'disabled',
  DATABASE_URL: 'postgres://127.0.0.1:1/db',
} as const;

const PROJECT = '11111111-1111-4111-8111-111111111111';

function post(path: string, body: unknown): Promise<Response> {
  return app.request(
    path,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    env,
  );
}

describe('POST /projects/:projectId/driver/ask', () => {
  it('rejects a malformed project id before touching the database', async () => {
    const res = await post('/projects/not-a-uuid/driver/ask', { question: 'how is search?' });
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe('projectId');
  });

  it('rejects a body that is not JSON', async () => {
    const res = await app.request(
      `/projects/${PROJECT}/driver/ask`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' },
      env,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('body is not valid JSON');
  });

  it('requires a question', async () => {
    const res = await post(`/projects/${PROJECT}/driver/ask`, {});
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe('question');
  });

  it('treats a blank question as missing rather than asking the model nothing', async () => {
    const res = await post(`/projects/${PROJECT}/driver/ask`, { question: '   ' });
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe('question');
  });

  it('rejects a non-string question', async () => {
    const res = await post(`/projects/${PROJECT}/driver/ask`, { question: { text: 'hi' } });
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe('question');
  });

  it('offers no way to name a project in the body', async () => {
    // Scope comes from the path, after the access check. A body field that
    // reached the tool context would be a cross-tenant read, so the route
    // simply has nowhere to put one — this asserts the shape stays that way.
    const res = await post(`/projects/not-a-uuid/driver/ask`, {
      question: 'findings',
      projectId: PROJECT,
      accountId: PROJECT,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe('projectId');
  });
});
