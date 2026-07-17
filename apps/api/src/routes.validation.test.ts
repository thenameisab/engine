import { describe, expect, it } from 'vitest';
import type { CrawledPage } from '@engine/diagnosis';
import app from './index.js';

/**
 * The validation contract at the route boundary, driven through the real Hono
 * stack (middleware, routing, JSON serialization) rather than by calling the
 * validators directly — ./validate.test.ts already covers those.
 *
 * These need no database: every rejection happens before `createDb`, which is
 * the point. A malformed body must never reach Postgres or the rule engine, so
 * a `DATABASE_URL` that would fail to connect proves the 400 came first.
 */
const env = {
  AUTH_MODE: 'disabled',
  DATABASE_URL: 'postgres://never.connected.invalid/db',
} as const;

function post(path: string, body: unknown): Promise<Response> {
  return app.request(
    path,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
    env,
  );
}

const validPage: CrawledPage = {
  url: 'https://example.com/product',
  entityId: 'ent_1',
  statusCode: 200,
  redirectChain: [],
  indexable: true,
  inSitemap: true,
  title: 'A product',
  metaDescription: 'A description.',
  vitals: { lcpMs: 1200, inpMs: 90, cls: 0.02, field: true },
  structuredData: [],
  aiCrawlerAccess: {
    GPTBot: 'allowed',
    ClaudeBot: 'allowed',
    PerplexityBot: 'allowed',
    'Google-Extended': 'allowed',
  },
  hreflang: [],
  expectsHreflang: false,
};

const validTarget = { kind: 'edge-worker', workerName: 'engine-edge' };
const validFinding = {
  id: '11111111-1111-4111-8111-111111111111',
  entityId: 'ent_1',
  source: 'technical',
  issueType: 'meta-title-missing',
  severity: 0.4,
  predictedImpact: 0.32,
  evidence: { url: 'https://example.com/product' },
  actionTemplates: [{ type: 'meta', label: 'Add a title', description: '…' }],
  createdAt: '2026-07-17T00:00:00.000Z',
};

describe('POST /projects/:projectId/audit', () => {
  it('rejects a page missing metaDescription with a 400 naming the field', async () => {
    const page: Record<string, unknown> = structuredClone(validPage);
    delete page.metaDescription;

    const res = await post('/projects/proj_1/audit', { pages: [page] });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'invalid pages[0].metaDescription: expected a string, got missing',
      field: 'pages[0].metaDescription',
    });
  });

  it('names the offending page by index in a multi-page crawl', async () => {
    const page: Record<string, unknown> = structuredClone(validPage);
    delete page.vitals;

    const res = await post('/projects/proj_1/audit', { pages: [validPage, validPage, page] });

    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe('pages[2].vitals');
  });

  it('rejects a body that is not JSON at all', async () => {
    const res = await post('/projects/proj_1/audit', 'not json{');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'body is not valid JSON' });
  });
});

describe('POST /projects/:projectId/actions/generate', () => {
  it('rejects a context missing target with a 400 naming the field', async () => {
    const res = await post('/projects/proj_1/actions/generate', {
      finding: validFinding,
      context: { url: 'https://example.com/product' },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'invalid context.target: expected an object, got missing',
      field: 'context.target',
    });
  });

  it('rejects a malformed deploy target', async () => {
    const res = await post('/projects/proj_1/actions/generate', {
      finding: validFinding,
      context: { url: 'https://example.com/product', target: { kind: 'edge-worker' } },
    });

    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe('context.target.workerName');
  });

  it('rejects a finding whose id would become a null FK', async () => {
    const finding: Record<string, unknown> = structuredClone(validFinding);
    delete finding.id;

    const res = await post('/projects/proj_1/actions/generate', {
      finding,
      context: { url: 'https://example.com/product', target: validTarget },
    });

    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe('finding.id');
  });

  it('rejects a body that is not JSON at all', async () => {
    const res = await post('/projects/proj_1/actions/generate', '{"finding":');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'body is not valid JSON' });
  });
});

describe('POST /projects/:projectId/entities/:entityId/keywords', () => {
  const valid = { keyword: 'home loans', geoCountry: 'IN', device: 'desktop', language: 'en', engine: 'google' };

  it('rejects an out-of-range device before any database call', async () => {
    const res = await post('/projects/proj_1/entities/ent_1/keywords', { ...valid, device: 'watch' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'invalid device: expected one of "desktop", "mobile", "tablet", got a string',
      field: 'device',
    });
  });

  it('rejects a body that is not JSON at all', async () => {
    const res = await post('/projects/proj_1/entities/ent_1/keywords', 'not json{');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'body is not valid JSON' });
  });
});

/**
 * The gate stays in front of validation: a malformed body from an unauthenticated
 * caller is still 401, not a 400 that would confirm the route's shape to someone
 * who has no business knowing it.
 */
describe('auth ordering', () => {
  it('answers 401 before validating the body', async () => {
    const res = await app.request(
      '/projects/proj_1/audit',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"pages":[{}]}' },
      { AUTH_JWKS_URL: 'https://auth.invalid/jwks.json', DATABASE_URL: env.DATABASE_URL },
    );
    expect(res.status).toBe(401);
  });
});
