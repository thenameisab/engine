import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CrawledPage } from '@engine/diagnosis';
import { createDb, type Db } from '../db.js';
import { upsertCrawledPages, getCrawledPage } from './crawledPages.js';

/**
 * That the HTTP status survives the write.
 *
 * It did not. `crawlPage` read `response.status()` and put it on the record,
 * `validate.ts` checked it, and the insert had no column to put it in — so the
 * value was measured, transmitted, validated and dropped. Migration 0031 adds
 * the column; this proves the round trip, which a stubbed `db` cannot.
 *
 * Runs only when `TEST_DATABASE_URL` points at a migrated database.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('crawled_pages.status_code (Postgres)', () => {
  let db: Db;
  let projectId: string;

  const page = (over: Partial<CrawledPage> = {}): CrawledPage =>
    ({
      url: 'https://acme.com/',
      entityId: null,
      statusCode: 200,
      redirectChain: [],
      indexable: true,
      inSitemap: false,
      title: 'Home',
      metaDescription: 'Home page.',
      bodyText: 'Hello',
      internalLinkCount: 3,
      headings: [],
      structuredData: [],
      hreflang: [],
      expectsHreflang: false,
      pageValue: 0,
      vitals: { lcpMs: 1000, inpMs: 50, cls: 0.01, field: false },
      aiCrawlerAccess: { GPTBot: 'allowed', ClaudeBot: 'allowed', PerplexityBot: 'allowed', 'Google-Extended': 'allowed' },
      ...over,
    }) as CrawledPage;

  beforeAll(async () => {
    db = createDb(url!);
    const [account] = await db<{ id: string }[]>`
      insert into accounts (name) values ('status-test ' || gen_random_uuid()::text) returning id
    `;
    const [project] = await db<{ id: string }[]>`
      insert into projects (account_id, name, domain) values (${account!.id}, 'status', 'acme.com') returning id
    `;
    projectId = project!.id;
  });

  afterAll(async () => {
    await db?.end();
  });

  it('stores the status the crawler saw, for a success and for an error page', async () => {
    await upsertCrawledPages(db, projectId, [
      page(),
      page({ url: 'https://acme.com/gone', statusCode: 404, title: 'Not found' }),
    ]);

    expect((await getCrawledPage(db, projectId, 'https://acme.com/'))!.statusCode).toBe(200);
    expect((await getCrawledPage(db, projectId, 'https://acme.com/gone'))!.statusCode).toBe(404);
  });

  it('updates the status on a re-crawl, so a fixed page stops reading as broken', async () => {
    // The upsert is on (project_id, url). A page that 404s today and returns
    // 200 next week has to be able to change its answer, or the status would
    // be a permanent verdict recorded once.
    await upsertCrawledPages(db, projectId, [page({ url: 'https://acme.com/gone', statusCode: 404 })]);
    expect((await getCrawledPage(db, projectId, 'https://acme.com/gone'))!.statusCode).toBe(404);

    await upsertCrawledPages(db, projectId, [page({ url: 'https://acme.com/gone', statusCode: 200 })]);
    expect((await getCrawledPage(db, projectId, 'https://acme.com/gone'))!.statusCode).toBe(200);
  });

  it('reads null, not 200, for a row written before the column existed', async () => {
    // The reason 0031 has no backfill: every pre-existing row was written
    // without a status, and defaulting to 200 would assert that those pages
    // answered 200 — the exact false claim the column exists to prevent.
    await db`
      insert into crawled_pages (project_id, url, title, body_text, headings)
      values (${projectId}, 'https://acme.com/legacy', 'Legacy', 'Old row', '[]'::jsonb)
    `;
    expect((await getCrawledPage(db, projectId, 'https://acme.com/legacy'))!.statusCode).toBeNull();
  });
});
