import { describe, expect, it } from 'vitest';
import { app } from './index.js';
import { RANK_POLL_CRON } from './repositories/rankPoll.js';

/**
 * The keyword routes at the boundary. Like ./routes.validation.test.ts, these
 * need no database: every rejection here happens before `createDb`, and a
 * `DATABASE_URL` that cannot connect proves the ordering.
 */
const env = {
  AUTH_MODE: 'disabled',
  DATABASE_URL: 'postgres://never.connected.invalid/db',
} as const;

const PROJECT = '11111111-1111-4111-8111-111111111111';
const ENTITY = '22222222-2222-4222-8222-222222222222';

function post(path: string, body: unknown): Promise<Response> {
  return app.request(
    path,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    env,
  );
}

describe('POST /projects/:id/entities/:id/keywords', () => {
  it('rejects a body with no keyword before touching the database', async () => {
    const res = await post(`/projects/${PROJECT}/entities/${ENTITY}/keywords`, {
      geoCountry: 'IN',
      device: 'desktop',
      language: 'en',
      engine: 'google',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe('keyword');
  });

  it('rejects a cadence that is not one of the three', async () => {
    const res = await post(`/projects/${PROJECT}/entities/${ENTITY}/keywords`, {
      keyword: 'payslip ocr',
      geoCountry: 'IN',
      device: 'desktop',
      language: 'en',
      engine: 'google',
      cadence: 'hourly',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe('cadence');
  });

  it('rejects an engine Engine cannot poll', async () => {
    const res = await post(`/projects/${PROJECT}/entities/${ENTITY}/keywords`, {
      keyword: 'payslip ocr',
      geoCountry: 'IN',
      device: 'desktop',
      language: 'en',
      engine: 'duckduckgo',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe('engine');
  });
});

describe('DELETE /projects/:id/keywords/:keywordId', () => {
  it('rejects a malformed id before touching the database', async () => {
    const res = await app.request(`/projects/${PROJECT}/keywords/not-a-uuid`, { method: 'DELETE' }, env);
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe('keywordId');
  });
});

describe('the rank-poll cron', () => {
  /**
   * The dispatcher tells the two schedules apart by this string alone, and
   * `wrangler.toml` holds the other copy. If they drift, the rank poll never
   * runs and the Google sync runs twice a day.
   */
  it('matches the expression in wrangler.toml', async () => {
    const { readFile } = await import('node:fs/promises');
    const toml = await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8');
    expect(toml).toContain(`"${RANK_POLL_CRON}"`);
  });
});
