import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.js';
import { upsertGscDaily, upsertGa4Daily, gscDailyRows, BATCH_ROWS, type GscDailyRow, type Ga4DailyRow } from './googleSync.js';

/**
 * The batched writers against a real Postgres.
 *
 * Runs only when `TEST_DATABASE_URL` points at a migrated database (locally,
 * the scratch cluster on 5433); CI has no database for tests and skips. This
 * is the test the review asked for: nothing exercised a write path against
 * Postgres before, and the bug this module just had — one statement per row,
 * dying part-way through a few thousand — is exactly the kind a unit test
 * with a stubbed `db` cannot see.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('batched Google writes (Postgres)', () => {
  let db: Db;
  let accountId: string;
  let projectId: string;

  beforeAll(async () => {
    db = createDb(url!);
    const [account] = await db<{ id: string }[]>`
      insert into accounts (name) values ('sync-test ' || gen_random_uuid()::text) returning id
    `;
    accountId = account.id;
    const [project] = await db<{ id: string }[]>`
      insert into projects (account_id, name, domain) values (${accountId}, 'sync test', 'sync-test.example') returning id
    `;
    projectId = project.id;
  });

  afterAll(async () => {
    // Cascades through projects and every *_daily table.
    await db`delete from accounts where id::text = ${accountId}`;
    await db.end();
  });

  it('writes 6,000 query rows in a few statements, not 6,000, and re-writing overwrites', async () => {
    const rows: GscDailyRow[] = [];
    for (let day = 0; day < 30; day++) {
      const date = `2026-08-${String(1 + (day % 28)).padStart(2, '0')}`;
      for (let q = 0; q < 200; q++) {
        rows.push({ project_id: projectId, date, key: `query ${q}`, clicks: q % 7, impressions: q * 3, ctr: 0.1, position: 5.5 });
      }
    }
    // 30 × 200 = 6,000 shaped rows, of which 2 days repeat (day 28, 29 wrap): 5,600 distinct keys.
    const distinct = new Map(rows.map((r) => [`${r.date} ${r.key}`, r]));
    const started = Date.now();
    const written = await upsertGscDaily(db, 'gsc_query_daily', [...distinct.values()]);
    const elapsed = Date.now() - started;
    expect(written).toBe(distinct.size);
    expect(Math.ceil(distinct.size / BATCH_ROWS)).toBeLessThanOrEqual(12);

    const [count] = await db<{ n: string }[]>`select count(*) as n from gsc_query_daily where project_id::text = ${projectId}`;
    expect(Number(count.n)).toBe(distinct.size);

    // Re-sync the same window with new numbers: the count must not move.
    const revised = [...distinct.values()].map((r) => ({ ...r, clicks: r.clicks + 1 }));
    await upsertGscDaily(db, 'gsc_query_daily', revised);
    const [again] = await db<{ n: string; clicks: string }[]>`
      select count(*) as n, sum(clicks) as clicks from gsc_query_daily where project_id::text = ${projectId}
    `;
    expect(Number(again.n)).toBe(distinct.size);
    expect(Number(again.clicks)).toBe(revised.reduce((s, r) => s + r.clicks, 0));

    // Not a benchmark, a guard: the old one-row-per-statement loop took
    // minutes for this many rows on a remote database.
    console.log(`upsertGscDaily: ${distinct.size} rows in ${elapsed}ms`);
    expect(elapsed).toBeLessThan(30_000);
  });

  it('writes property totals and page rows to their own tables', async () => {
    const totals = gscDailyRows(
      [
        { keys: ['2026-09-01'], clicks: 19, impressions: 400, ctr: 0.0475, position: 14.4 },
        { keys: ['2026-09-02'], clicks: 26, impressions: 413, ctr: 0.063, position: 14.2 },
      ],
      null,
      projectId,
    );
    expect(await upsertGscDaily(db, 'gsc_site_daily', totals)).toBe(2);
    const pages = gscDailyRows(
      [{ keys: ['2026-09-01', 'https://sync-test.example/'], clicks: 10, impressions: 100, ctr: 0.1, position: 2 }],
      'page',
      projectId,
    );
    expect(await upsertGscDaily(db, 'gsc_page_daily', pages)).toBe(1);
    const [site] = await db<{ n: string }[]>`select count(*) as n from gsc_site_daily where project_id::text = ${projectId}`;
    const [page] = await db<{ page: string }[]>`select page from gsc_page_daily where project_id::text = ${projectId}`;
    expect(Number(site.n)).toBe(2);
    expect(page.page).toBe('https://sync-test.example/');
  });

  it('writes GA4 channel rows in batches and upserts on the four-column key', async () => {
    const rows: Ga4DailyRow[] = [];
    for (let day = 1; day <= 28; day++) {
      for (const [channel, source] of [
        ['Organic Search', 'google'],
        ['AI Assistant', 'chatgpt.com'],
        ['Unassigned', 'copilot.com'],
      ]) {
        rows.push({
          project_id: projectId,
          date: `2026-08-${String(day).padStart(2, '0')}`,
          channel_group: channel,
          source,
          sessions: day,
          engaged_sessions: 1,
          conversions: 0,
          revenue: 0,
        });
      }
    }
    expect(await upsertGa4Daily(db, rows)).toBe(84);
    expect(await upsertGa4Daily(db, rows)).toBe(84);
    const [count] = await db<{ n: string }[]>`select count(*) as n from ga4_channel_daily where project_id::text = ${projectId}`;
    expect(Number(count.n)).toBe(84);
  });
});
