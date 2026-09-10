import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.js';
import { effectiveCadenceForAccount, getCadenceOverride, listAccountCadences, setCadenceOverride } from './accountCadence.js';
import { listDueCrawls, queueDueCrawls, CADENCE_REQUESTER } from './crawlSchedule.js';
import { recordMentions, shareOfVoice } from './answerMentions.js';

/**
 * Wave 3's SQL: the cadence override, which projects are due a crawl, and
 * share of voice over mined samples. Runs only when `TEST_DATABASE_URL`
 * points at a database migrated through 0034.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('measurement methodology (Postgres)', () => {
  let db: Db;
  let accountId: string;
  let projectId: string;
  let entityId: string;

  beforeAll(async () => {
    db = createDb(url!);
    const [account] = await db<{ id: string }[]>`
      insert into accounts (name) values ('cadence-test ' || gen_random_uuid()::text) returning id
    `;
    accountId = account!.id;
    const [project] = await db<{ id: string }[]>`
      insert into projects (account_id, name, domain) values (${accountId}, 'cadence', 'cadence-test.example') returning id
    `;
    projectId = project!.id;
    const [entity] = await db<{ id: string }[]>`
      insert into entities (project_id, canonical_name, role) values (${projectId}, 'Cadence Co', 'self') returning id
    `;
    entityId = entity!.id;
  });

  afterAll(async () => {
    await db`delete from accounts where id = ${accountId}`;
    await db.end();
  });

  describe('account cadence', () => {
    it('is the free default with no subscription and no override', async () => {
      const e = await effectiveCadenceForAccount(db, accountId);
      expect(e.tier).toBe('free');
      expect(e.policy).toEqual({ rankPoll: 'weekly', aiPoll: 'monthly', crawl: 'monthly' });
      expect(await getCadenceOverride(db, accountId)).toBeNull();
    });

    it('stores an override, reports its source, and deletes the row when every field is cleared', async () => {
      await setCadenceOverride(db, accountId, { rankPoll: 'daily', aiPoll: null, crawl: null }, 'local:admin@example.com');
      const e = await effectiveCadenceForAccount(db, accountId);
      expect(e.policy.rankPoll).toBe('daily');
      expect(e.source).toEqual({ rankPoll: 'override', aiPoll: 'plan-default', crawl: 'plan-default' });

      const listed = (await listAccountCadences(db)).find((a) => a.accountId === accountId);
      expect(listed?.override).toEqual({ rankPoll: 'daily', aiPoll: null, crawl: null });

      expect(await setCadenceOverride(db, accountId, { rankPoll: null, aiPoll: null, crawl: null }, 'x')).toBeNull();
      expect(await getCadenceOverride(db, accountId)).toBeNull();
    });
  });

  describe('scheduled crawls', () => {
    const dueHere = async () => (await listDueCrawls(db, 500)).filter((d) => d.projectId === projectId);

    it('is due when nothing has ever been crawled, and not once a request is live', async () => {
      expect(await dueHere()).toHaveLength(1);
      expect((await dueHere())[0]).toMatchObject({ entityId, domain: 'cadence-test.example', cadence: 'monthly' });

      const summary = await queueDueCrawls(db, 250, 500);
      const mine = summary.queued.find((q) => q.projectId === projectId);
      expect(mine).toBeDefined();
      expect(mine!.requestedBy).toBe(CADENCE_REQUESTER);
      expect(mine!.maxPages).toBe(250);
      // The request itself is the latest activity now.
      expect(await dueHere()).toHaveLength(0);
      await db`delete from audit_requests where project_id = ${projectId}`;
    });

    it('measures from the last run and honours the window, the override and on-demand', async () => {
      await db`insert into audit_runs (project_id, pages_audited, findings_count, health_score, created_at)
               values (${projectId}, 1, 0, 50, now() - interval '10 days')`;
      // Free tier: monthly, ten days is inside the window.
      expect(await dueHere()).toHaveLength(0);
      // Weekly override: ten days is past it.
      await setCadenceOverride(db, accountId, { rankPoll: null, aiPoll: null, crawl: 'weekly' }, 'x');
      expect(await dueHere()).toHaveLength(1);
      // On demand: never scheduled.
      await setCadenceOverride(db, accountId, { rankPoll: null, aiPoll: null, crawl: 'on_demand' }, 'x');
      expect(await dueHere()).toHaveLength(0);
      await setCadenceOverride(db, accountId, { rankPoll: null, aiPoll: null, crawl: null }, 'x');
      await db`delete from audit_runs where project_id = ${projectId}`;
    });
  });

  describe('share of voice', () => {
    async function sample(prompt: string, answerText: string | null): Promise<string> {
      const [row] = await db<{ id: string }[]>`
        insert into citation_events (entity_id, engine, model, prompt, cited, method, raw_answer_ref, answer_text, sampled_at)
        values (${entityId}, 'sarvam', 'sarvam-105b-conversations', ${prompt}, false, 'api', 'ref', ${answerText}, now())
        returning id
      `;
      return row!.id;
    }

    it('counts each brand over the mined samples only, and says how many were not mined', async () => {
      const a = await sample('best tool', 'Cadence Co and Rival are the picks.');
      const b = await sample('best tool', 'Rival, and also Other.');
      await sample('best tool', null); // pre-0034: no text, no mentions
      await recordMentions(db, a, [
        { brand: 'Cadence Co', isSelf: true, matchedEntityId: entityId, source: 'known' },
        { brand: 'Rival', isSelf: false, matchedEntityId: null, source: 'extracted' },
      ]);
      await recordMentions(db, b, [
        { brand: 'rival', isSelf: false, matchedEntityId: null, source: 'extracted' },
        { brand: 'Other', isSelf: false, matchedEntityId: null, source: 'extracted' },
      ]);

      const sov = await shareOfVoice(db, entityId, 30);
      expect(sov.samples).toBe(3);
      expect(sov.minedSamples).toBe(2);
      expect(sov.prompts).toHaveLength(1);
      expect(sov.prompts[0]!.samples).toBe(2);
      // "Rival" and "rival" are one brand, named in both mined samples.
      expect(sov.brands.map((x) => [x.brand, x.named, x.samples])).toEqual([
        ['Rival', 2, 2],
        ['Cadence Co', 1, 2],
        ['Other', 1, 2],
      ]);
      expect(sov.brands[1]).toMatchObject({ isSelf: true, matchedEntityId: entityId });
      expect(sov.brands[0]!.band.point).toBe(1);
      expect(sov.brands[0]!.band.low).toBeLessThan(1);

      // Re-mining a sample replaces its mentions rather than adding to them.
      await recordMentions(db, b, [{ brand: 'Other', isSelf: false, matchedEntityId: null, source: 'extracted' }]);
      const again = await shareOfVoice(db, entityId, 30);
      expect(again.brands.find((x) => x.brand === 'Rival')?.named).toBe(1);
    });
  });
});
