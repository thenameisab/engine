import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.js';
import { listDueKeywords } from './rankPoll.js';
import { createKeywordConfig, listTrackedKeywords, deleteKeywordConfig } from './keywordConfigs.js';

/**
 * The cadence due-check and the tracked-keyword join against a real Postgres.
 *
 * Both are lateral joins over `serp_positions`, and a stubbed `db` cannot tell
 * whether the SQL is right — which keyword is due, and which of two
 * observations is "current" versus "previous", are decided entirely inside the
 * query. Runs only when `TEST_DATABASE_URL` points at a migrated database;
 * CI has none and skips.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('rank tracking (Postgres)', () => {
  let db: Db;
  let accountId: string;
  let projectId: string;
  let entityId: string;

  beforeAll(async () => {
    db = createDb(url!);
    const [account] = await db<{ id: string }[]>`
      insert into accounts (name) values ('rank-test ' || gen_random_uuid()::text) returning id
    `;
    accountId = account.id;
    const [project] = await db<{ id: string }[]>`
      insert into projects (account_id, name, domain)
      values (${accountId}, 'rank test', 'rank-test.example') returning id
    `;
    projectId = project.id;
    const [entity] = await db<{ id: string }[]>`
      insert into entities (project_id, canonical_name) values (${projectId}, 'Rank Test Co') returning id
    `;
    entityId = entity.id;
  });

  afterAll(async () => {
    await db`delete from accounts where id::text = ${accountId}`;
    await db.end();
  });

  beforeEach(async () => {
    await db`delete from serp_positions where entity_id = ${entityId}`;
    await db`delete from keyword_configs where entity_id = ${entityId}`;
  });

  /** One observation, `hoursAgo` in the past. */
  async function observe(keyword: string, position: number | null, hoursAgo: number): Promise<void> {
    await db`
      insert into serp_positions
        (entity_id, keyword, geo_country, device, language, engine, position, url, features, raw_snapshot_ref, polled_at)
      values (
        ${entityId}, ${keyword}, 'IN', 'desktop', 'en', 'google', ${position},
        ${position === null ? null : `https://rank-test.example/${position}`}, '{}', 'ref',
        now() - (${String(hoursAgo)} || ' hours')::interval
      )
    `;
  }

  function track(keyword: string, cadence: 'daily' | 'weekly' | 'on_demand') {
    return createKeywordConfig(db, entityId, {
      keyword,
      geoCountry: 'IN',
      device: 'desktop',
      language: 'en',
      engine: 'google',
      cadence,
    });
  }

  describe('listDueKeywords', () => {
    it('treats a keyword that has never been polled as due', async () => {
      await track('never polled', 'weekly');
      const due = await listDueKeywords(db);
      expect(due.map((d) => d.keyword)).toContain('never polled');
    });

    it('excludes on_demand, which means only when someone asks', async () => {
      await track('ask me', 'on_demand');
      const due = await listDueKeywords(db);
      expect(due.map((d) => d.keyword)).not.toContain('ask me');
    });

    /**
     * The fencepost the 20-hour window exists for: a daily keyword polled 23
     * hours ago must be due on the next daily run, or it becomes
     * every-other-day.
     */
    it('makes a daily keyword due after 23 hours but not after 2', async () => {
      await track('daily kw', 'daily');
      await observe('daily kw', 4, 23);
      expect((await listDueKeywords(db)).map((d) => d.keyword)).toContain('daily kw');

      await db`delete from serp_positions where entity_id = ${entityId}`;
      await observe('daily kw', 4, 2);
      expect((await listDueKeywords(db)).map((d) => d.keyword)).not.toContain('daily kw');
    });

    it('makes a weekly keyword due after 7 days but not after 3', async () => {
      await track('weekly kw', 'weekly');
      await observe('weekly kw', 9, 24 * 7);
      expect((await listDueKeywords(db)).map((d) => d.keyword)).toContain('weekly kw');

      await db`delete from serp_positions where entity_id = ${entityId}`;
      await observe('weekly kw', 9, 24 * 3);
      expect((await listDueKeywords(db)).map((d) => d.keyword)).not.toContain('weekly kw');
    });

    it('carries the project domain, so the poll knows whose position to record', async () => {
      await track('with domain', 'weekly');
      const row = (await listDueKeywords(db)).find((d) => d.keyword === 'with domain')!;
      expect(row.domain).toBe('rank-test.example');
      expect(row.project_id).toBe(projectId);
      expect(row.account_id).toBe(accountId);
    });

    it('honours the cap', async () => {
      await track('a', 'weekly');
      await track('b', 'weekly');
      await track('c', 'weekly');
      expect(await listDueKeywords(db, 2)).toHaveLength(2);
    });
  });

  describe('listTrackedKeywords', () => {
    it('joins the newest observation as current and the one before it as previous', async () => {
      await track('moving', 'weekly');
      await observe('moving', 12, 48);
      await observe('moving', 7, 2);
      const [row] = await listTrackedKeywords(db, projectId);
      expect(row!.position).toBe(7);
      expect(row!.previousPosition).toBe(12);
      expect(row!.url).toBe('https://rank-test.example/7');
      expect(row!.polledAt).not.toBeNull();
    });

    it('leaves previous null on the first poll, so no change is claimed', async () => {
      await track('first', 'weekly');
      await observe('first', 5, 1);
      const [row] = await listTrackedKeywords(db, projectId);
      expect(row!.position).toBe(5);
      expect(row!.previousPosition).toBeNull();
    });

    it('reports a keyword that has never been polled as tracked with no position', async () => {
      await track('waiting', 'weekly');
      const [row] = await listTrackedKeywords(db, projectId);
      expect(row!.position).toBeNull();
      expect(row!.polledAt).toBeNull();
      expect(row!.entityName).toBe('Rank Test Co');
    });

    it('sorts by position, with unranked and unpolled keywords last', async () => {
      await track('ranked well', 'weekly');
      await track('not ranking', 'weekly');
      await track('unpolled', 'weekly');
      await observe('ranked well', 3, 1);
      await observe('not ranking', null, 1);
      const order = (await listTrackedKeywords(db, projectId)).map((r) => r.keyword);
      expect(order[0]).toBe('ranked well');
      expect(order.slice(1).sort()).toEqual(['not ranking', 'unpolled']);
    });
  });

  describe('deleteKeywordConfig', () => {
    it('removes the keyword but keeps the observations', async () => {
      const config = await track('to remove', 'weekly');
      await observe('to remove', 6, 1);
      expect(await deleteKeywordConfig(db, projectId, config.id)).toBe(true);
      expect(await listTrackedKeywords(db, projectId)).toEqual([]);
      const [{ count }] = await db<{ count: string }[]>`
        select count(*) from serp_positions where entity_id = ${entityId} and keyword = 'to remove'
      `;
      expect(Number(count)).toBe(1);
    });

    it("refuses an id that is not in the given project", async () => {
      const config = await track('mine', 'weekly');
      const [other] = await db<{ id: string }[]>`
        insert into projects (account_id, name, domain)
        values (${accountId}, 'other', 'other.example') returning id
      `;
      expect(await deleteKeywordConfig(db, other.id, config.id)).toBe(false);
      expect(await listTrackedKeywords(db, projectId)).toHaveLength(1);
      await db`delete from projects where id = ${other.id}`;
    });
  });
});
