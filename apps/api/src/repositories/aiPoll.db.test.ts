import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.js';
import { listDuePrompts, citationTargets } from './aiPoll.js';
import { citedShareByEngine } from './citationEvents.js';
import { setEntityPrompts } from './entities.js';

/**
 * The prompt due-check and the cited-share rollup against a real Postgres.
 *
 * Both are queries a stubbed `db` cannot judge. The due-check in particular
 * unnests an array column and joins it laterally against `citation_events`,
 * and the first draft of that join referenced the unnested column
 * unqualified — which Postgres resolves to `citation_events.prompt`, the
 * innermost scope, making the condition `ce.prompt = ce.prompt`. That is
 * always true, so every prompt looked sampled and the poll would have found
 * nothing due, forever, while every unit test passed.
 *
 * Runs only when `TEST_DATABASE_URL` points at a migrated database.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('AI poll (Postgres)', () => {
  let db: Db;
  let accountId: string;
  let projectId: string;
  let entityId: string;

  beforeAll(async () => {
    db = createDb(url!);
    const [account] = await db<{ id: string }[]>`
      insert into accounts (name) values ('ai-test ' || gen_random_uuid()::text) returning id
    `;
    accountId = account.id;
    const [project] = await db<{ id: string }[]>`
      insert into projects (account_id, name, domain)
      values (${accountId}, 'ai test', 'ai-test.example') returning id
    `;
    projectId = project.id;
    const [entity] = await db<{ id: string }[]>`
      insert into entities (project_id, canonical_name, urls)
      values (${projectId}, 'Ai Test Co', array['https://docs.ai-test.example']) returning id
    `;
    entityId = entity.id;
  });

  afterAll(async () => {
    await db`delete from accounts where id::text = ${accountId}`;
    await db.end();
  });

  beforeEach(async () => {
    await db`delete from citation_events where entity_id = ${entityId}`;
    await db`update entities set prompts = '{}' where id = ${entityId}`;
  });

  /** One stored sample, `daysAgo` in the past. */
  async function sample(
    prompt: string,
    opts: {
      cited: boolean;
      daysAgo: number;
      engine?: string;
      sources?: string[];
      /** Undefined leaves it null — a row from before migration 0030. */
      model?: string;
      byName?: boolean;
      byDomain?: boolean;
    },
  ): Promise<void> {
    await db`
      insert into citation_events
        (entity_id, engine, model, prompt, cited, cited_by_name, cited_by_domain,
         sources_cited, method, raw_answer_ref, sampled_at)
      values (
        ${entityId}, ${opts.engine ?? 'sarvam'}, ${opts.model ?? null}, ${prompt}, ${opts.cited},
        ${opts.byName ?? null}, ${opts.byDomain ?? null},
        ${opts.sources ?? []}, 'api', 'ref',
        now() - (${String(opts.daysAgo)} || ' days')::interval
      )
    `;
  }

  /** Only this test entity's due rows — the table is shared with other suites. */
  async function dueHere(): Promise<string[]> {
    const rows = await listDuePrompts(db, 500);
    return rows.filter((r) => r.entity_id === entityId).map((r) => r.prompt);
  }

  describe('listDuePrompts', () => {
    it('finds a prompt that has never been sampled', async () => {
      await setEntityPrompts(db, projectId, entityId, ['what is payslip ocr']);
      expect(await dueHere()).toEqual(['what is payslip ocr']);
    });

    it('returns one row per prompt in the bank', async () => {
      await setEntityPrompts(db, projectId, entityId, ['a prompt', 'b prompt', 'c prompt']);
      expect((await dueHere()).sort()).toEqual(['a prompt', 'b prompt', 'c prompt']);
    });

    it('skips a prompt sampled inside the weekly window', async () => {
      await setEntityPrompts(db, projectId, entityId, ['recent prompt']);
      await sample('recent prompt', { cited: true, daysAgo: 2 });
      expect(await dueHere()).toEqual([]);
    });

    it('is due again after the window, which is short of a full seven days', async () => {
      // 6d12h, not 7d: a cron fires with drift, so a prompt sampled at
      // 05:00:05 would not be seven days old when the next run starts at
      // 05:00:01 — weekly would silently become every-eighth-day.
      await setEntityPrompts(db, projectId, entityId, ['old prompt']);
      await sample('old prompt', { cited: false, daysAgo: 6.7 });
      expect(await dueHere()).toEqual(['old prompt']);
    });

    it('matches a sample to its own prompt, not to any sample of any prompt', async () => {
      // The ambiguity bug in one test: with the join collapsed to
      // `ce.prompt = ce.prompt`, sampling *one* prompt makes *both* look
      // sampled and neither is ever due again.
      await setEntityPrompts(db, projectId, entityId, ['sampled one', 'never sampled']);
      await sample('sampled one', { cited: true, daysAgo: 1 });
      expect(await dueHere()).toEqual(['never sampled']);
    });

    it('ignores an entity with an empty bank', async () => {
      await setEntityPrompts(db, projectId, entityId, []);
      expect(await dueHere()).toEqual([]);
    });

    it('carries the project domain and the entity urls, which decide "cited"', async () => {
      await setEntityPrompts(db, projectId, entityId, ['one prompt']);
      const row = (await listDuePrompts(db, 500)).find((r) => r.entity_id === entityId)!;
      expect(row.domain).toBe('ai-test.example');
      expect(row.canonical_name).toBe('Ai Test Co');
      // A brand name target is the only citation signal a non-browsing engine
      // can give, so it has to reach the poller.
      expect(citationTargets(row)).toContain('Ai Test Co');
      expect(citationTargets(row)).toContain('ai-test.example');
    });

    it('honours the cap, so one big bank cannot spend a whole night', async () => {
      await setEntityPrompts(db, projectId, entityId, ['p one', 'p two', 'p three']);
      expect((await listDuePrompts(db, 2)).length).toBe(2);
    });

    it('takes the least recently sampled first, so nothing is starved', async () => {
      await setEntityPrompts(db, projectId, entityId, ['older', 'newer']);
      await sample('older', { cited: false, daysAgo: 30 });
      await sample('newer', { cited: false, daysAgo: 8 });
      expect(await dueHere()).toEqual(['older', 'newer']);
    });
  });

  describe('citedShareByEngine', () => {
    it('returns a Wilson band, not a bare rate', async () => {
      // One cited answer out of three is 33%, with a 95% band from about 6%
      // to 79%. The width is the point: three samples cannot support 33% on
      // its own.
      await sample('p', { cited: true, daysAgo: 1 });
      await sample('p', { cited: false, daysAgo: 1 });
      await sample('p', { cited: false, daysAgo: 1 });

      const [row] = await citedShareByEngine(db, entityId, 30);
      expect(row.engine).toBe('sarvam');
      expect(row.samples).toBe(3);
      expect(row.cited).toBe(1);
      expect(row.band.point).toBeCloseTo(1 / 3, 5);
      expect(row.band.low).toBeGreaterThan(0);
      expect(row.band.low).toBeLessThan(row.band.point);
      expect(row.band.high).toBeGreaterThan(row.band.point);
      expect(row.band.high).toBeLessThan(1);
    });

    it('counts distinct prompts, not samples', async () => {
      await sample('first prompt', { cited: true, daysAgo: 1 });
      await sample('first prompt', { cited: true, daysAgo: 1 });
      await sample('second prompt', { cited: false, daysAgo: 1 });

      const [row] = await citedShareByEngine(db, entityId, 30);
      expect(row.samples).toBe(3);
      expect(row.prompts).toBe(2);
    });

    it('groups by engine', async () => {
      await sample('p', { cited: true, daysAgo: 1, engine: 'sarvam' });
      await sample('p', { cited: false, daysAgo: 1, engine: 'openai' });

      const rows = await citedShareByEngine(db, entityId, 30);
      expect(rows.map((r) => r.engine).sort()).toEqual(['openai', 'sarvam']);
    });

    it('reports how few answers named a source, which is the engine’s limit', async () => {
      // Sarvam does not browse. This number is what stops an empty
      // citation-opportunity panel from reading as "no gaps to close".
      await sample('p', { cited: true, daysAgo: 1, sources: [] });
      await sample('p', { cited: true, daysAgo: 1, sources: ['https://g2.com/x'] });

      const [row] = await citedShareByEngine(db, entityId, 30);
      expect(row.samples).toBe(2);
      expect(row.samplesWithSources).toBe(1);
    });

    it('excludes samples older than the lookback window', async () => {
      await sample('p', { cited: true, daysAgo: 60 });
      expect(await citedShareByEngine(db, entityId, 30)).toEqual([]);
    });

    it('returns nothing for an entity with no samples at all', async () => {
      expect(await citedShareByEngine(db, entityId, 30)).toEqual([]);
    });
  });

  describe('citedShareByEngine: provenance (migration 0030)', () => {
    it('keeps two models of one vendor in separate groups', async () => {
      // The whole reason the column exists. Pooled, these would read as one
      // 50% band for "sarvam"; apart, they are 100% and 0% — a disagreement
      // between instruments, which is what it is.
      await sample('p', { cited: true, daysAgo: 1, model: 'sarvam-105b', byName: true, byDomain: false });
      await sample('p', { cited: false, daysAgo: 1, model: 'sarvam-105b-conversations', byName: false, byDomain: false });

      const rows = await citedShareByEngine(db, entityId, 30);
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.model).sort()).toEqual(['sarvam-105b', 'sarvam-105b-conversations']);
      expect(rows.find((r) => r.model === 'sarvam-105b')!.band.point).toBe(1);
      expect(rows.find((r) => r.model === 'sarvam-105b-conversations')!.band.point).toBe(0);
    });

    it('keeps unrecorded-model rows out of a recorded model’s band', async () => {
      // A pre-0030 row must not be absorbed into whichever model is current;
      // that would be asserting a fact the database never observed.
      await sample('p', { cited: true, daysAgo: 1 });
      await sample('p', { cited: true, daysAgo: 1, model: 'sarvam-105b', byName: true, byDomain: false });

      const rows = await citedShareByEngine(db, entityId, 30);
      expect(rows).toHaveLength(2);
      expect(rows.some((r) => r.model === null)).toBe(true);
    });

    it('counts named and linked apart', async () => {
      await sample('p', { cited: true, daysAgo: 1, model: 'm', byName: true, byDomain: false });
      await sample('p', { cited: true, daysAgo: 1, model: 'm', byName: true, byDomain: true });
      await sample('p', { cited: false, daysAgo: 1, model: 'm', byName: false, byDomain: false });

      const [row] = await citedShareByEngine(db, entityId, 30);
      expect(row.samples).toBe(3);
      expect(row.cited).toBe(2);
      expect(row.citedByName).toBe(2);
      // The stronger claim, and the one a non-browsing engine cannot make.
      expect(row.citedByDomain).toBe(1);
    });

    it('reports the split as null, not zero, when no row recorded it', async () => {
      // "No answer linked you" and "nobody measured whether an answer linked
      // you" are different facts, and zero would state the first.
      await sample('p', { cited: true, daysAgo: 1 });
      const [row] = await citedShareByEngine(db, entityId, 30);
      expect(row.citedByName).toBeNull();
      expect(row.citedByDomain).toBeNull();
      expect(row.cited).toBe(1);
    });
  });
});
