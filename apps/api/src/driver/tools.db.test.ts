import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { READ_TOOLS, READ_TOOLS_BY_NAME } from '@engine/driver';
import { createDb, type Db } from '../db.js';
import type { DriverToolContext } from './context.js';
import { buildParts, pick, type ToolRender } from '@engine/driver';
import { RENDER_SPECS } from './parts.js';
import { assertRegistryMatchesCatalogue, READ_HANDLERS, runToolCall } from './registry.js';

/**
 * The read-tool catalogue against a real Postgres.
 *
 * Three things here cannot be proved against a stubbed `db`, and all three are
 * the kind that fail silently:
 *
 *  1. **Tenancy.** Most of these tables are keyed by `entity_id` or by an action
 *     id, not by `project_id`, so every query reaches its scope through a join.
 *     A stub returns whatever it was told to and proves nothing about that join.
 *     Every test here runs with a second account, project and entity present in
 *     the same database, carrying deliberately distinctive rows, and the last
 *     block asserts no tool ever returns one of them.
 *
 *  2. **The three empty states.** §4.2 rule 3 is the difference between "you
 *     have no traffic" and "Search Console was never connected", and §9a
 *     decision 6 makes the second the common case on a new account. Which state
 *     a tool reports depends on rows in `integration_connections`,
 *     `integration_assignments` and the metric tables agreeing — which is
 *     exactly what a stub cannot exercise.
 *
 *  3. **The SQL itself.** Lateral joins, `unnest` over a text array, nullable
 *     numerics read back as strings. Every one of these has a shape that type
 *     checks and returns the wrong rows.
 *
 * Runs only when `TEST_DATABASE_URL` points at a migrated database; CI has none
 * and skips.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('driver read tools (Postgres)', () => {
  let db: Db;
  let accountId: string;
  let projectId: string;
  let entityId: string;
  let ctx: DriverToolContext;

  /** A second tenant, populated once and never cleared. Nothing may ever return its rows. */
  let otherAccountId: string;
  let otherProjectId: string;
  let otherEntityId: string;

  const OTHER_MARK = 'DO-NOT-LEAK';

  beforeAll(async () => {
    db = createDb(url!);

    const mk = async (name: string, domain: string) => {
      const [account] = await db<{ id: string }[]>`
        insert into accounts (name) values (${`${name} ${crypto.randomUUID()}`}) returning id
      `;
      const [project] = await db<{ id: string }[]>`
        insert into projects (account_id, name, domain)
        values (${account.id}, ${name}, ${domain}) returning id
      `;
      const [entity] = await db<{ id: string }[]>`
        insert into entities (project_id, canonical_name) values (${project.id}, ${name}) returning id
      `;
      return { accountId: account.id, projectId: project.id, entityId: entity.id };
    };

    const mine = await mk('Driver Test Co', 'drivertest.example');
    accountId = mine.accountId;
    projectId = mine.projectId;
    entityId = mine.entityId;
    ctx = { db, projectId, accountId, domain: 'drivertest.example' };

    const other = await mk(OTHER_MARK, 'othertenant.example');
    otherAccountId = other.accountId;
    otherProjectId = other.projectId;
    otherEntityId = other.entityId;

    await seedOtherTenant();
  });

  afterAll(async () => {
    await db`delete from accounts where id::text in (${accountId}, ${otherAccountId})`;
    await db.end();
  });

  beforeEach(async () => {
    // Only this tenant's rows. The other tenant stays populated for the whole run.
    await db`delete from gsc_site_daily where project_id::text = ${projectId}`;
    await db`delete from gsc_query_daily where project_id::text = ${projectId}`;
    await db`delete from gsc_page_daily where project_id::text = ${projectId}`;
    await db`delete from ga4_channel_daily where project_id::text = ${projectId}`;
    await db`delete from integration_assignments where project_id::text = ${projectId}`;
    await db`delete from integration_connections where account_id::text = ${accountId}`;
    await db`delete from serp_positions where entity_id::text = ${entityId}`;
    await db`delete from keyword_configs where entity_id::text = ${entityId}`;
    await db`delete from citation_events where entity_id::text = ${entityId}`;
    await db`delete from audit_requests where project_id::text = ${projectId}`;
    await db`delete from actions where finding_id in (select id from findings where entity_id::text = ${entityId})`;
    await db`delete from findings where entity_id::text = ${entityId}`;
    await db`delete from audit_runs where project_id::text = ${projectId}`;
    await db`delete from crawled_pages where project_id::text = ${projectId}`;
    await db`delete from entity_graph_audits where project_id::text = ${projectId}`;
    await db`delete from competitor_gaps where project_id::text = ${projectId}`;
    await db`delete from competitor_sets where project_id::text = ${projectId}`;
    await db`delete from local_audits where project_id::text = ${projectId}`;
    await db`delete from local_profiles where project_id::text = ${projectId}`;
  });

  /* ── fixtures ───────────────────────────────────────────────────────────── */

  const DAY = (offset: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - offset);
    return d.toISOString().slice(0, 10);
  };

  async function connectGoogle(
    provider: 'gsc' | 'ga4' | 'gbp',
    opts: { status?: string; assign?: boolean; syncedAt?: string | null; syncError?: string | null; account?: string; project?: string } = {},
  ): Promise<void> {
    const account = opts.account ?? accountId;
    const project = opts.project ?? projectId;
    const [connection] = await db<{ id: string }[]>`
      insert into integration_connections (account_id, provider, status, external_label)
      values (${account}, ${provider}, ${opts.status ?? 'connected'}, 'someone@example.com')
      on conflict (account_id, provider) do update set status = excluded.status
      returning id
    `;
    if (opts.assign === false) return;
    await db`
      insert into integration_assignments
        (connection_id, provider, project_id, resource_id, resource_label, last_synced_at, last_sync_error)
      values (${connection.id}, ${provider}, ${project}, ${'sc-domain:example.com'}, 'example.com',
              ${opts.syncedAt === undefined ? new Date().toISOString() : opts.syncedAt},
              ${opts.syncError ?? null})
      on conflict (connection_id, project_id, resource_id) do nothing
    `;
  }

  async function addSiteDay(date: string, clicks: number, impressions: number, position = 8, project = projectId): Promise<void> {
    await db`
      insert into gsc_site_daily (project_id, date, clicks, impressions, ctr, position)
      values (${project}, ${date}, ${clicks}, ${impressions}, ${impressions ? clicks / impressions : 0}, ${position})
      on conflict (project_id, date) do update set clicks = excluded.clicks
    `;
  }

  async function addQuery(date: string, query: string, clicks: number, impressions: number, position: number, project = projectId): Promise<void> {
    await db`
      insert into gsc_query_daily (project_id, date, query, clicks, impressions, ctr, position)
      values (${project}, ${date}, ${query}, ${clicks}, ${impressions}, ${impressions ? clicks / impressions : 0}, ${position})
      on conflict (project_id, date, query) do update set clicks = excluded.clicks
    `;
  }

  async function addFinding(over: { issueType?: string; source?: string; severity?: number; resolved?: boolean; entity?: string } = {}): Promise<string> {
    const [row] = await db<{ id: string }[]>`
      insert into findings (entity_id, source, severity, predicted_impact, evidence, action_templates, fingerprint, issue_type, resolved_at)
      values (${over.entity ?? entityId}, ${over.source ?? 'technical'}, ${over.severity ?? 80}, 5,
              '{"url":"/pricing"}'::jsonb, '[]'::jsonb, ${crypto.randomUUID()},
              ${over.issueType ?? 'missing_schema'}, ${over.resolved ? new Date().toISOString() : null})
      returning id
    `;
    return row.id;
  }

  async function addAction(findingId: string, status = 'proposed'): Promise<string> {
    const [row] = await db<{ id: string }[]>`
      insert into actions (finding_id, type, target, diff, status)
      values (${findingId}, 'schema', '{"url":"/pricing"}'::jsonb, '{"before":"","after":"x"}'::jsonb, ${status})
      returning id
    `;
    return row.id;
  }

  async function addCitation(cited: boolean, opts: { engine?: string; sources?: string[]; entity?: string; daysAgo?: number } = {}): Promise<string> {
    const [row] = await db<{ id: string }[]>`
      insert into citation_events (entity_id, engine, prompt, cited, sources_cited, method, raw_answer_ref, sampled_at)
      values (${opts.entity ?? entityId}, ${opts.engine ?? 'openai'}, 'who is driver test co', ${cited},
              ${opts.sources ?? []}, 'api', 'ref', ${DAY(opts.daysAgo ?? 1)})
      returning id
    `;
    return row.id;
  }

  /** The other tenant gets a row in every table, each marked so a leak is obvious. */
  async function seedOtherTenant(): Promise<void> {
    await connectGoogle('gsc', { account: otherAccountId, project: otherProjectId });
    await addSiteDay(DAY(1), 9999, 99999, 1, otherProjectId);
    await addQuery(DAY(1), `${OTHER_MARK} query`, 9999, 99999, 1, otherProjectId);
    await db`
      insert into gsc_page_daily (project_id, date, page, clicks, impressions, ctr, position)
      values (${otherProjectId}, ${DAY(1)}, ${`https://othertenant.example/${OTHER_MARK}`}, 9999, 99999, 0.1, 1)
    `;
    await db`
      insert into ga4_channel_daily (project_id, date, channel_group, source, sessions, engaged_sessions, conversions)
      values (${otherProjectId}, ${DAY(1)}, ${OTHER_MARK}, 'chatgpt.com', 9999, 9999, 99)
    `;
    await db`
      insert into keyword_configs (entity_id, keyword, geo_country, device, language, engine)
      values (${otherEntityId}, ${`${OTHER_MARK} keyword`}, 'us', 'desktop', 'en', 'google')
    `;
    await db`
      insert into serp_positions (entity_id, keyword, geo_country, device, language, engine, position, url, raw_snapshot_ref, polled_at)
      values (${otherEntityId}, ${`${OTHER_MARK} keyword`}, 'us', 'desktop', 'en', 'google', 1,
              ${`https://othertenant.example/${OTHER_MARK}`}, 'ref', now())
    `;
    const otherCitation = await addCitation(true, {
      entity: otherEntityId,
      sources: [`https://${OTHER_MARK.toLowerCase()}.example/page`],
    });
    await db`
      insert into answer_mentions (citation_event_id, brand, brand_key, is_self, source)
      values (${otherCitation}, ${OTHER_MARK}, ${OTHER_MARK.toLowerCase()}, false, 'known')
    `;
    const otherFinding = await addFinding({ entity: otherEntityId, issueType: OTHER_MARK });
    await addAction(otherFinding, 'deployed');
    await db`
      insert into audit_runs (project_id, pages_audited, findings_count, health_score)
      values (${otherProjectId}, 9999, 9999, 1)
    `;
    await db`
      insert into crawled_pages (project_id, url, title)
      values (${otherProjectId}, ${`https://othertenant.example/${OTHER_MARK}`}, ${OTHER_MARK})
    `;
    await db`
      insert into entity_graph_audits (entity_id, project_id, score, wikidata_score, schema_score, sameas_score, corroboration_score, corroborating_domains)
      values (${otherEntityId}, ${otherProjectId}, 99, 99, 99, 99, 99, 99)
    `;
    await db`
      insert into competitor_gaps (project_id, self_entity_id, gap_type, item, held_by_count, held_by, impact)
      values (${otherProjectId}, ${otherEntityId}, ${OTHER_MARK}, ${OTHER_MARK}, 9, '[]'::jsonb, 99)
    `;
    await db`
      insert into local_audits (entity_id, project_id, score, gbp_score, nap_score, review_score, reviews_considered)
      values (${otherEntityId}, ${otherProjectId}, 99, 99, 99, 99, 99)
    `;
    await db`
      insert into local_profiles (entity_id, project_id, profile)
      values (${otherEntityId}, ${otherProjectId}, ${db.json({ name: OTHER_MARK })})
    `;
  }

  /** Run a tool through the registry and parse the envelope back out. */
  async function call(name: string, args: Record<string, unknown> = {}) {
    const { envelope } = await runToolCall(ctx, name, JSON.stringify(args));
    const state = /state="([^"]+)"/.exec(envelope)?.[1] ?? null;
    const body = envelope.slice(envelope.indexOf('\n') + 1, envelope.lastIndexOf('\n'));
    return { state, envelope, ...JSON.parse(body) };
  }

  /* ── the registry ───────────────────────────────────────────────────────── */

  describe('the registry', () => {
    it('implements every tool the catalogue declares, and nothing it does not', () => {
      expect(() => assertRegistryMatchesCatalogue()).not.toThrow();
      expect(Object.keys(READ_HANDLERS).sort()).toEqual(READ_TOOLS.map((t) => t.name).sort());
    });

    it('answers an unknown tool name instead of throwing', async () => {
      const result = await call('page_content', {});
      expect(result.state).toBe('error');
      expect(result.error).toContain('no tool called "page_content"');
    });

    it('returns the validator sentence for bad arguments, so the model can retry', async () => {
      const result = await call('top_queries', { days: 'last month' });
      expect(result.state).toBe('error');
      expect(result.error).toContain('must be a integer');
    });

    it('never lets a handler claim a table its definition does not declare', async () => {
      const result = await call('site_health');
      const declared = READ_TOOLS_BY_NAME.get('site_health')!.tables;
      for (const table of result.provenance.tables) expect(declared).toContain(table);
    });
  });

  /* ── §4.2 rule 3: three distinct empty answers ──────────────────────────── */

  describe('the three empty states', () => {
    it('reports not-connected when Search Console has never been connected', async () => {
      const result = await call('search_performance');
      expect(result.state).toBe('not-connected');
      expect(result.nextStep.action).toContain('Connect Google Search Console');
    });

    it('reports not-connected, with a reconnect step, when access has expired', async () => {
      await connectGoogle('gsc', { status: 'needs_reauth' });
      const result = await call('search_performance');
      expect(result.state).toBe('not-connected');
      expect(result.nextStep.action).toContain('Reconnect');
    });

    it('reports not-connected, with a property step, when connected but unassigned', async () => {
      await connectGoogle('gsc', { assign: false });
      const result = await call('search_performance');
      expect(result.state).toBe('not-connected');
      expect(result.nextStep.action).toContain('Choose which');
    });

    it('reports no-data-yet when connected and assigned but never synced', async () => {
      await connectGoogle('gsc', { syncedAt: null });
      const result = await call('search_performance');
      expect(result.state).toBe('no-data-yet');
      expect(result.nextStep.reason).toContain('first sync has not run');
    });

    it('reports no-data-yet when the last sync failed', async () => {
      await connectGoogle('gsc', { syncError: 'quota exceeded' });
      const result = await call('search_performance');
      expect(result.state).toBe('no-data-yet');
      expect(result.nextStep.reason).toContain('quota exceeded');
    });

    it('reports zero — a real measurement — when synced rows exist and total nothing', async () => {
      await connectGoogle('gsc');
      await addSiteDay(DAY(1), 0, 0, 0);
      const result = await call('search_performance');
      expect(result.state).toBe('zero');
      expect(result.data.totals.clicks).toBe(0);
      // The distinction the whole rule exists for.
      expect(result.nextStep.reason).not.toContain('not connected');
    });

    it('reports ok when there are figures', async () => {
      await connectGoogle('gsc');
      await addSiteDay(DAY(1), 40, 400, 6);
      await addSiteDay(DAY(2), 60, 600, 8);
      const result = await call('search_performance');
      expect(result.state).toBe('ok');
      expect(result.data.totals.clicks).toBe(100);
      expect(result.data.totals.impressions).toBe(1000);
      // ctr derived from clicks and impressions, not averaged from the stored column.
      expect(result.data.totals.ctr).toBeCloseTo(0.1, 6);
    });

    it('keeps all four states distinguishable in the envelope attribute alone', async () => {
      const states = new Set<string | null>();
      states.add((await call('search_performance')).state);
      await connectGoogle('gsc', { syncedAt: null });
      states.add((await call('search_performance')).state);
      await db`update integration_assignments set last_synced_at = now() where project_id::text = ${projectId}`;
      await addSiteDay(DAY(1), 0, 0, 0);
      states.add((await call('search_performance')).state);
      await addSiteDay(DAY(1), 5, 50, 4);
      states.add((await call('search_performance')).state);
      expect(states).toEqual(new Set(['not-connected', 'no-data-yet', 'zero', 'ok']));
    });
  });

  /* ── periods ────────────────────────────────────────────────────────────── */

  describe('periods end on the latest synced day, not today', () => {
    it('does not report a collapse when the sync is a week behind', async () => {
      await connectGoogle('gsc');
      await addSiteDay(DAY(10), 50, 500, 5);
      await addSiteDay(DAY(11), 50, 500, 5);
      const result = await call('search_performance', { days: 7 });
      expect(result.state).toBe('ok');
      expect(result.data.period.to).toBe(DAY(10));
      expect(result.data.totals.clicks).toBe(100);
    });

    it('omits the comparison when the preceding period is not fully synced', async () => {
      await connectGoogle('gsc');
      await addSiteDay(DAY(1), 10, 100, 5);
      const result = await call('search_performance', { days: 28, compare: true });
      expect(result.data.previous).toBeNull();
      expect(result.data.comparisonOmittedBecause).toContain('not fully synced');
    });

    it('offers the comparison once the preceding period is covered', async () => {
      await connectGoogle('gsc');
      for (const offset of [1, 5, 9, 13]) await addSiteDay(DAY(offset), 10, 100, 5);
      const result = await call('search_performance', { days: 3, compare: true });
      expect(result.data.previous).not.toBeNull();
      expect(result.data.previous.period.to < result.data.period.from).toBe(true);
    });
  });

  /* ── brand split ────────────────────────────────────────────────────────── */

  describe('top_queries', () => {
    beforeEach(async () => {
      await connectGoogle('gsc');
      await addQuery(DAY(1), 'drivertest pricing', 50, 200, 2);
      await addQuery(DAY(1), 'seo audit tool', 30, 900, 7);
      await addQuery(DAY(1), 'schema markup checker', 10, 400, 12);
    });

    it('splits brand from non-brand using the shared brand definition', async () => {
      const only = await call('top_queries', { brand: 'only' });
      expect(only.data.queries.map((q: { query: string }) => q.query)).toEqual(['drivertest pricing']);

      const exclude = await call('top_queries', { brand: 'exclude' });
      expect(exclude.data.queries.map((q: { query: string }) => q.query)).toEqual([
        'seo audit tool',
        'schema markup checker',
      ]);
    });

    it('honours the model limit after the brand filter, not before', async () => {
      const result = await call('top_queries', { brand: 'exclude', limit: 1 });
      expect(result.data.queries).toHaveLength(1);
      expect(result.data.queries[0].query).toBe('seo audit tool');
    });

    it('says the queries exist when the brand filter is what emptied the list', async () => {
      await db`delete from gsc_query_daily where project_id::text = ${projectId} and query = 'drivertest pricing'`;
      const result = await call('top_queries', { brand: 'only' });
      expect(result.state).toBe('zero');
      expect(result.nextStep.action).toContain('brand set to "all"');
    });
  });

  describe('queries_within_reach', () => {
    it('applies the shared thresholds and excludes brand queries', async () => {
      await connectGoogle('gsc');
      await addQuery(DAY(1), 'in reach term', 0, 300, 11); // position 4-20, >= 10 impressions
      await addQuery(DAY(1), 'already winning', 90, 900, 2); // too high
      await addQuery(DAY(1), 'far away term', 0, 300, 45); // too low
      await addQuery(DAY(1), 'barely seen term', 0, 4, 11); // too few impressions
      await addQuery(DAY(1), 'drivertest term', 0, 500, 11); // brand

      const result = await call('queries_within_reach');
      expect(result.state).toBe('ok');
      expect(result.data.queries.map((q: { query: string }) => q.query)).toEqual(['in reach term']);
      expect(result.data.criteria.positionBetween).toEqual([4, 20]);
      expect(result.data.criteria.minimumImpressions).toBe(10);
    });
  });

  /* ── AI referral traffic ────────────────────────────────────────────────── */

  describe('ai_referral_traffic', () => {
    beforeEach(() => connectGoogle('ga4'));

    async function addChannel(group: string, source: string, sessions: number): Promise<void> {
      await db`
        insert into ga4_channel_daily (project_id, date, channel_group, source, sessions, engaged_sessions, conversions)
        values (${projectId}, ${DAY(1)}, ${group}, ${source}, ${sessions}, ${sessions}, 0)
        on conflict (project_id, date, channel_group, source) do update set sessions = excluded.sessions
      `;
    }

    it('recognises an assistant GA4 filed under Referral, and says Engine classified it', async () => {
      await addChannel('Referral', 'chatgpt.com', 40);
      await addChannel('Organic Search', 'google', 500);
      const result = await call('ai_referral_traffic');
      expect(result.state).toBe('ok');
      expect(result.data.sources).toHaveLength(1);
      expect(result.data.sources[0].source).toBe('chatgpt.com');
      expect(result.data.sources[0].classifiedBy).toBe('engine');
      expect(result.data.totals.shareOfAllSessions).toBeCloseTo(40 / 540, 6);
    });

    it("credits GA4 when the property has its own AI Assistant channel", async () => {
      await addChannel('AI Assistant', 'some-new-assistant.example', 12);
      const result = await call('ai_referral_traffic');
      expect(result.data.sources[0].classifiedBy).toBe('ga4');
    });

    it('separates "traffic but none from assistants" from "no traffic at all"', async () => {
      await addChannel('Organic Search', 'google', 500);
      const realZero = await call('ai_referral_traffic');
      expect(realZero.state).toBe('zero');
      expect(realZero.nextStep.reason).toContain('none of them came from a recognised AI assistant');

      await db`delete from ga4_channel_daily where project_id::text = ${projectId}`;
      await addChannel('Organic Search', 'google', 0);
      const noTraffic = await call('ai_referral_traffic');
      expect(noTraffic.state).toBe('zero');
      expect(noTraffic.nextStep.reason).toContain('no sessions at all');
    });
  });

  /* ── §4.2 rule 4: bands stay bands ──────────────────────────────────────── */

  describe('ai_citations keeps the confidence band', () => {
    it('returns low, point and high with the sample count, never a bare percentage', async () => {
      for (const cited of [true, true, true, false]) await addCitation(cited);
      const result = await call('ai_citations');

      expect(result.state).toBe('ok');
      expect(result.data.samples).toBe(4);
      expect(result.data.cited).toBe(3);
      expect(result.data.citationRate.point).toBeCloseTo(0.75, 6);
      // A band, with real width. A point estimate dressed as a band is the failure.
      expect(result.data.citationRate.low).toBeLessThan(result.data.citationRate.point);
      expect(result.data.citationRate.high).toBeGreaterThan(result.data.citationRate.point);
      expect(result.provenance.sampleCount).toBe(4);
    });

    it('widens the band when there are fewer samples for the same proportion', async () => {
      await addCitation(true);
      await addCitation(false);
      const few = await call('ai_citations');
      const narrow = few.data.citationRate;

      for (let i = 0; i < 9; i += 1) {
        await addCitation(true);
        await addCitation(false);
      }
      const many = await call('ai_citations');
      const wide = many.data.citationRate;

      expect(narrow.high - narrow.low).toBeGreaterThan(wide.high - wide.low);
    });

    it('reports zero citations as a measurement that still carries its band', async () => {
      for (let i = 0; i < 3; i += 1) await addCitation(false);
      const result = await call('ai_citations');
      expect(result.state).toBe('zero');
      expect(result.data.cited).toBe(0);
      // The honest part: three samples cannot rule out a high true rate.
      expect(result.data.citationRate.high).toBeGreaterThan(0.3);
      expect(result.nextStep.reason).toContain('could still be as high as');
    });

    it('separates "never sampled" from "sampled and never cited"', async () => {
      const never = await call('ai_citations');
      expect(never.state).toBe('no-data-yet');
      expect(never.data.samples).toBe(0);
      expect(never.nextStep.reason).toContain('No AI answers have been sampled');
    });

    it('breaks the band down per engine', async () => {
      await addCitation(true, { engine: 'openai' });
      await addCitation(false, { engine: 'openai' });
      await addCitation(true, { engine: 'gemini' });
      const result = await call('ai_citations');
      const engines = Object.fromEntries(
        result.data.byEngine.map((e: { engine: string; samples: number }) => [e.engine, e.samples]),
      );
      expect(engines).toEqual({ openai: 2, gemini: 1 });
      for (const e of result.data.byEngine) expect(e.citationRate).toHaveProperty('low');
    });

    it('names the other brands the answers mentioned', async () => {
      const id = await addCitation(true);
      await db`
        insert into answer_mentions (citation_event_id, brand, brand_key, is_self, source)
        values (${id}, 'Rival Co', 'rivalco', false, 'extracted'),
               (${id}, 'Driver Test Co', 'drivertestco', true, 'known')
      `;
      const result = await call('ai_citations');
      expect(result.data.brandsNamedAlongside).toEqual([
        { brand: 'Rival Co', timesNamed: 1, matchedBy: 'extracted' },
      ]);
    });
  });

  describe('cited_domains', () => {
    it('reduces cited source URLs to hosts and counts them', async () => {
      await addCitation(true, { sources: ['https://www.g2.com/products/x', 'https://reddit.com/r/seo'] });
      await addCitation(true, { sources: ['https://g2.com/products/y'] });
      const result = await call('cited_domains');
      expect(result.state).toBe('ok');
      expect(result.data.domains[0]).toEqual({ domain: 'g2.com', timesCited: 2, inAnswers: 2 });
    });

    it('separates "no answers sampled" from "answers cited nothing"', async () => {
      const never = await call('cited_domains');
      expect(never.state).toBe('no-data-yet');

      await addCitation(false, { sources: [] });
      const noSources = await call('cited_domains');
      expect(noSources.state).toBe('zero');
      expect(noSources.data.answersSampled).toBe(1);
    });
  });

  /* ── keywords ───────────────────────────────────────────────────────────── */

  describe('keyword_positions', () => {
    async function trackKeyword(keyword: string): Promise<void> {
      await db`
        insert into keyword_configs (entity_id, keyword, geo_country, device, language, engine)
        values (${entityId}, ${keyword}, 'us', 'desktop', 'en', 'google')
      `;
    }

    async function poll(keyword: string, position: number | null, daysAgo = 1): Promise<void> {
      await db`
        insert into serp_positions (entity_id, keyword, geo_country, device, language, engine, position, url, raw_snapshot_ref, polled_at)
        values (${entityId}, ${keyword}, 'us', 'desktop', 'en', 'google', ${position},
                ${position ? 'https://drivertest.example/p' : null}, 'ref', ${DAY(daysAgo)})
      `;
    }

    it('keeps ranked, not-found and never-polled apart', async () => {
      await trackKeyword('ranked term');
      await trackKeyword('missing term');
      await trackKeyword('unpolled term');
      await poll('ranked term', 4);
      await poll('missing term', null);

      const result = await call('keyword_positions');
      const byKeyword = Object.fromEntries(
        result.data.positions.map((p: { keyword: string; outcome: string }) => [p.keyword, p.outcome]),
      );
      expect(byKeyword).toEqual({
        'ranked term': 'ranked',
        'missing term': 'not-found',
        'unpolled term': 'never-polled',
      });
    });

    it('takes the most recent poll, not the best one', async () => {
      await trackKeyword('moving term');
      await poll('moving term', 3, 30);
      await poll('moving term', 19, 1);
      const result = await call('keyword_positions');
      expect(result.data.positions[0].position).toBe(19);
    });

    it('says nothing is tracked rather than nothing is ranking', async () => {
      const result = await call('keyword_positions');
      expect(result.state).toBe('no-data-yet');
      expect(result.nextStep.reason).toContain('No keywords are being tracked');
    });

    it('reports no-data-yet when keywords are tracked but never polled', async () => {
      await trackKeyword('unpolled term');
      const result = await call('keyword_positions');
      expect(result.state).toBe('no-data-yet');
      expect(result.nextStep.reason).toContain('none has been polled');
    });

    it('filters to one keyword, case-insensitively', async () => {
      await trackKeyword('Exact Term');
      await trackKeyword('other term');
      await poll('Exact Term', 5);
      const result = await call('keyword_positions', { keyword: 'exact term' });
      expect(result.data.positions).toHaveLength(1);
      expect(result.data.positions[0].keyword).toBe('Exact Term');
    });
  });

  /* ── site ───────────────────────────────────────────────────────────────── */

  describe('findings', () => {
    it('excludes resolved findings by default and includes them on request', async () => {
      await addFinding({ issueType: 'open_one' });
      await addFinding({ issueType: 'closed_one', resolved: true });

      const open = await call('findings');
      expect(open.data.findings.map((f: { issueType: string }) => f.issueType)).toEqual(['open_one']);

      const all = await call('findings', { includeResolved: true });
      expect(all.data.findings).toHaveLength(2);
    });

    it('separates "never audited" from "audited and clean" from "filtered to nothing"', async () => {
      const neverAudited = await call('findings');
      expect(neverAudited.state).toBe('no-data-yet');
      expect(neverAudited.nextStep.reason).toContain('never been audited');

      await db`insert into audit_runs (project_id, pages_audited, findings_count, health_score) values (${projectId}, 12, 0, 95)`;
      const clean = await call('findings');
      expect(clean.state).toBe('zero');
      expect(clean.nextStep.reason).toContain('no findings at all');

      await addFinding({ issueType: 'missing_schema' });
      const filtered = await call('findings', { issueType: 'something_else' });
      expect(filtered.state).toBe('zero');
      expect(filtered.nextStep.reason).toContain('none matched the filters');
    });

    it('filters by source and minimum severity', async () => {
      await addFinding({ source: 'technical', severity: 90 });
      await addFinding({ source: 'entity', severity: 20 });
      expect((await call('findings', { source: 'entity' })).data.findings).toHaveLength(1);
      expect((await call('findings', { minSeverity: 50 })).data.findings).toHaveLength(1);
      expect((await call('findings', { minSeverity: 95 })).state).toBe('zero');
    });

    it('carries the finding ids as provenance, so an answer can be traced to rows', async () => {
      const id = await addFinding();
      const result = await call('findings');
      expect(result.provenance.rowIds).toEqual([id]);
    });
  });

  describe('crawl_coverage', () => {
    it('says a crawl that stopped at its limit produced floors, not totals', async () => {
      await db`
        insert into audit_runs (project_id, pages_audited, findings_count, health_score, stopped_at_limit, max_pages, robots_found)
        values (${projectId}, 250, 40, 60, true, 250, true)
      `;
      const result = await call('crawl_coverage');
      expect(result.state).toBe('ok');
      expect(result.data.countsAreComplete).toBe(false);
      expect(result.data.note).toContain('floor, not a total');
    });

    it('says the counts are complete when the crawl finished on its own', async () => {
      await db`
        insert into audit_runs (project_id, pages_audited, findings_count, health_score, stopped_at_limit, max_pages)
        values (${projectId}, 42, 3, 88, false, 250)
      `;
      const result = await call('crawl_coverage');
      expect(result.data.countsAreComplete).toBe(true);
      expect(result.data.note).toContain('without hitting its page limit');
    });

    it('reports never-crawled rather than an empty site', async () => {
      const result = await call('crawl_coverage');
      expect(result.state).toBe('no-data-yet');
      expect(result.nextStep.reason).toContain('never been crawled');
    });
  });

  describe('fix_verification', () => {
    it('keeps never-checked apart from checked-and-not-found', async () => {
      const findingId = await addFinding();
      const actionId = await addAction(findingId, 'deployed');

      const unchecked = await call('fix_verification', { actionId });
      expect(unchecked.state).toBe('no-data-yet');
      expect(unchecked.data.outcome).toBe('never-checked');

      await db`
        insert into audit_requests (project_id, entity_id, root_url, requested_by, kind, action_id, status, verified)
        values (${projectId}, ${entityId}, 'https://drivertest.example', 'tester', 'verify', ${actionId}, 'done', false)
      `;
      const checked = await call('fix_verification', { actionId });
      expect(checked.state).toBe('ok');
      expect(checked.data.outcome).toBe('not-found-on-page');
    });

    it('reports a confirmed fix', async () => {
      const actionId = await addAction(await addFinding(), 'deployed');
      await db`
        insert into audit_requests (project_id, entity_id, root_url, requested_by, kind, action_id, status, verified)
        values (${projectId}, ${entityId}, 'https://drivertest.example', 'tester', 'verify', ${actionId}, 'done', true)
      `;
      const result = await call('fix_verification', { actionId });
      expect(result.data.outcome).toBe('verified');
    });

    it('explains that an undeployed fix has nothing to verify', async () => {
      const actionId = await addAction(await addFinding(), 'proposed');
      const result = await call('fix_verification', { actionId });
      expect(result.data.outcome).toBe('never-checked');
      expect(result.nextStep.reason).toContain('nothing deployed to verify');
    });

    it('rejects a malformed id without touching the database', async () => {
      const result = await call('fix_verification', { actionId: 'not-a-uuid' });
      expect(result.state).toBe('zero');
      expect(result.nextStep.reason).toContain('not a valid fix id');
    });
  });

  describe('fix_queue', () => {
    it('separates an empty queue from a filter that matched nothing', async () => {
      const empty = await call('fix_queue');
      expect(empty.state).toBe('zero');
      expect(empty.nextStep.reason).toContain('Nothing has been proposed');

      await addAction(await addFinding(), 'proposed');
      const filtered = await call('fix_queue', { status: 'deployed' });
      expect(filtered.state).toBe('zero');
      expect(filtered.nextStep.reason).toContain('none of them in the "deployed" state');
    });

    it('returns fixes with the finding they answer', async () => {
      await addAction(await addFinding({ issueType: 'missing_schema' }), 'approved');
      const result = await call('fix_queue');
      expect(result.state).toBe('ok');
      expect(result.data.fixes[0].answersIssue).toBe('missing_schema');
      expect(result.data.fixes[0].status).toBe('approved');
    });
  });

  describe('site_health', () => {
    it('reports the score with the severity and source breakdown', async () => {
      await db`insert into audit_runs (project_id, pages_audited, findings_count, health_score) values (${projectId}, 30, 3, 72)`;
      await addFinding({ severity: 90, source: 'technical' });
      await addFinding({ severity: 50, source: 'technical' });
      await addFinding({ severity: 10, source: 'entity' });

      const result = await call('site_health');
      expect(result.state).toBe('ok');
      expect(result.data.healthScore).toBe(72);
      expect(result.data.openFindings).toBe(3);
      expect(result.data.bySeverity).toEqual({ high: 1, medium: 1, low: 1 });
      expect(result.data.bySource).toEqual({ technical: 2, entity: 1 });
    });

    it('says never-audited rather than reporting a null score as health', async () => {
      const result = await call('site_health');
      expect(result.state).toBe('no-data-yet');
      expect(result.data.healthScore).toBeNull();
    });
  });

  /* ── brand ──────────────────────────────────────────────────────────────── */

  describe('local_visibility', () => {
    it('keeps a null review component out of zero', async () => {
      await db`
        insert into local_audits (entity_id, project_id, score, gbp_score, nap_score, review_score, reviews_considered)
        values (${entityId}, ${projectId}, 61, 70, 80, null, 0)
      `;
      const result = await call('local_visibility');
      expect(result.state).toBe('ok');
      expect(result.data.audits[0].components.reviews).toBeNull();
      expect(result.data.audits[0].components.googleBusinessProfile).toBe(70);
    });
  });

  describe('competitor_gaps', () => {
    it('says no competitors are configured rather than reporting no gaps', async () => {
      const result = await call('competitor_gaps');
      expect(result.state).toBe('no-data-yet');
      expect(result.nextStep.reason).toContain('No competitors are configured');
    });

    it('reports a genuine absence of gaps once competitors exist', async () => {
      const [rival] = await db<{ id: string }[]>`
        insert into entities (project_id, canonical_name) values (${projectId}, 'Rival') returning id
      `;
      await db`
        insert into competitor_sets (project_id, self_entity_id, competitor_entity_id)
        values (${projectId}, ${entityId}, ${rival.id})
      `;
      const result = await call('competitor_gaps');
      expect(result.state).toBe('zero');
      expect(result.nextStep.reason).toContain('found no gaps');
    });
  });

  describe('integration_status', () => {
    it('names the next step for each provider separately', async () => {
      await connectGoogle('gsc', { syncedAt: null });
      await connectGoogle('ga4', { assign: false });

      const result = await call('integration_status');
      const byProvider = Object.fromEntries(
        result.data.providers.map((p: { provider: string; nextStep: string | null }) => [p.provider, p.nextStep]),
      );
      expect(byProvider.gsc).toContain('Waiting for the first sync');
      expect(byProvider.ga4).toContain('Choose which');
      expect(byProvider.gbp).toContain('Connect Google Business Profile');
      expect(result.state).toBe('zero');
      expect(result.data.readyCount).toBe(0);
    });

    it('reports ok once one provider is connected, assigned and synced', async () => {
      await connectGoogle('gsc');
      const result = await call('integration_status');
      expect(result.state).toBe('ok');
      expect(result.data.readyCount).toBe(1);
      expect(result.data.providers.find((p: { provider: string }) => p.provider === 'gsc').nextStep).toBeNull();
    });
  });

  /* ── tenancy ────────────────────────────────────────────────────────────── */

  describe('tenancy — no tool returns another project\'s rows', () => {
    it('has a populated second tenant, so the assertions below are not vacuous', async () => {
      // Without this, every test in this block would pass against an empty
      // database and prove nothing about the joins it exists to check.
      const counts = await Promise.all(
        [
          db`select count(*)::int as n from gsc_site_daily where project_id::text = ${otherProjectId}`,
          db`select count(*)::int as n from gsc_query_daily where project_id::text = ${otherProjectId}`,
          db`select count(*)::int as n from ga4_channel_daily where project_id::text = ${otherProjectId}`,
          db`select count(*)::int as n from keyword_configs where entity_id::text = ${otherEntityId}`,
          db`select count(*)::int as n from serp_positions where entity_id::text = ${otherEntityId}`,
          db`select count(*)::int as n from citation_events where entity_id::text = ${otherEntityId}`,
          db`select count(*)::int as n from findings where entity_id::text = ${otherEntityId}`,
          db`select count(*)::int as n from audit_runs where project_id::text = ${otherProjectId}`,
          db`select count(*)::int as n from entity_graph_audits where project_id::text = ${otherProjectId}`,
          db`select count(*)::int as n from competitor_gaps where project_id::text = ${otherProjectId}`,
          db`select count(*)::int as n from local_audits where project_id::text = ${otherProjectId}`,
          db`select count(*)::int as n from integration_connections where account_id::text = ${otherAccountId}`,
        ] as Promise<{ n: number }[]>[],
      );
      for (const [i, rows] of counts.entries()) {
        expect(rows[0]!.n, `other tenant table ${i} is empty`).toBeGreaterThan(0);
      }
    });

    it('never leaks the other tenant, through any tool, with this project empty', async () => {
      // Every table the other tenant occupies has a row; this project has none.
      // A tool whose join is wrong would return the other tenant's data here.
      for (const tool of READ_TOOLS) {
        const args = tool.name === 'fix_verification' ? { actionId: crypto.randomUUID() } : {};
        const { envelope } = await call(tool.name, args);
        expect(envelope, `${tool.name} leaked the other tenant`).not.toContain(OTHER_MARK);
        expect(envelope, `${tool.name} leaked the other tenant`).not.toContain('othertenant.example');
      }
    });

    it('never leaks the other tenant while this project has its own data', async () => {
      await connectGoogle('gsc');
      await connectGoogle('ga4');
      await addSiteDay(DAY(1), 10, 100, 5);
      await addQuery(DAY(1), 'our own query', 10, 100, 5);
      await addCitation(true, { sources: ['https://ours.example/x'] });
      const findingId = await addFinding();
      await addAction(findingId);
      await db`insert into audit_runs (project_id, pages_audited, findings_count, health_score) values (${projectId}, 5, 1, 80)`;

      for (const tool of READ_TOOLS) {
        const args = tool.name === 'fix_verification' ? { actionId: crypto.randomUUID() } : {};
        const { envelope } = await call(tool.name, args);
        expect(envelope, `${tool.name} leaked the other tenant`).not.toContain(OTHER_MARK);
      }
    });

    it('refuses another project\'s action id by id, rather than returning it', async () => {
      const [foreign] = await db<{ id: string }[]>`
        select a.id from actions a
        join findings f on f.id = a.finding_id
        join entities e on e.id = f.entity_id
        where e.project_id::text = ${otherProjectId} limit 1
      `;
      const result = await call('fix_verification', { actionId: foreign.id });
      expect(result.state).toBe('zero');
      expect(result.data.fix).toBeNull();
      expect(result.nextStep.reason).toContain('exists in this project');
    });

    it('scopes integration_status to this account, not to every account', async () => {
      await connectGoogle('gsc');
      const result = await call('integration_status');
      // The other tenant also has a gsc connection; exactly one must be reported.
      const gsc = result.data.providers.find((p: { provider: string }) => p.provider === 'gsc');
      expect(gsc.connected).toBe(true);
      expect(result.data.providers).toHaveLength(3);
    });
  });

  /* ── the envelope, end to end ───────────────────────────────────────────── */

  describe('every tool answers through the envelope', () => {
    it('returns a well-formed, single-delimiter envelope for all nineteen', async () => {
      for (const tool of READ_TOOLS) {
        const args = tool.name === 'fix_verification' ? { actionId: crypto.randomUUID() } : {};
        const { envelope } = await runToolCall(ctx, tool.name, JSON.stringify(args));
        expect(envelope.match(/<tool_result/g), tool.name).toHaveLength(1);
        expect(envelope.match(/<\/tool_result>/g), tool.name).toHaveLength(1);
        expect(envelope.startsWith(`<tool_result name="${tool.name}"`), tool.name).toBe(true);
      }
    });

    it('carries provenance on every result, including empty ones', async () => {
      for (const tool of READ_TOOLS) {
        const args = tool.name === 'fix_verification' ? { actionId: crypto.randomUUID() } : {};
        const result = await call(tool.name, args);
        expect(result.provenance.tables.length, tool.name).toBeGreaterThan(0);
      }
    });

    it('gives a reason and an action on every non-ok state', async () => {
      for (const tool of READ_TOOLS) {
        const args = tool.name === 'fix_verification' ? { actionId: crypto.randomUUID() } : {};
        const result = await call(tool.name, args);
        if (result.state === 'ok') continue;
        expect(result.nextStep, `${tool.name} (${result.state}) gave no next step`).toBeTruthy();
        expect(result.nextStep.reason.length, tool.name).toBeGreaterThan(10);
        expect(result.nextStep.action.length, tool.name).toBeGreaterThan(10);
      }
    });
  });

  /* ── the render specs, against real data ────────────────────────────────── */

  describe('every render spec points at data that exists', () => {
    /**
     * Enough data for every tool to answer `ok`.
     *
     * The describes above each seed only what their own assertion needs, so by
     * the time this one runs the tables are empty again. A path check against
     * an empty result checks nothing, so this seeds the lot.
     */
    beforeEach(async () => {
      await connectGoogle('gsc');
      await connectGoogle('ga4');

      await addSiteDay(DAY(1), 40, 900, 8);
      await addQuery(DAY(1), 'driver test co', 30, 300, 2);
      // A non-brand query in the 11-20 band with enough impressions, which is
      // the only shape `queries_within_reach` reports.
      await addQuery(DAY(1), 'seo monitoring tool', 2, 400, 14);
      await db`
        insert into gsc_page_daily (project_id, date, page, clicks, impressions, ctr, position)
        values (${projectId}, ${DAY(1)}, 'https://drivertest.example/pricing', 12, 200, 0.06, 6)
        on conflict (project_id, date, page) do nothing
      `;
      await db`
        insert into ga4_channel_daily (project_id, date, channel_group, source, sessions, engaged_sessions, conversions)
        values (${projectId}, ${DAY(1)}, 'Referral', 'chatgpt.com', 40, 30, 2),
               (${projectId}, ${DAY(1)}, 'Organic Search', 'google', 500, 400, 9)
        on conflict (project_id, date, channel_group, source) do nothing
      `;

      await db`
        insert into keyword_configs (entity_id, keyword, geo_country, device, language, engine)
        values (${entityId}, 'seo monitoring tool', 'us', 'desktop', 'en', 'google')
      `;
      await db`
        insert into serp_positions (entity_id, keyword, geo_country, device, language, engine, position, url, raw_snapshot_ref, polled_at)
        values (${entityId}, 'seo monitoring tool', 'us', 'desktop', 'en', 'google', 4,
                'https://drivertest.example/p', 'ref', ${DAY(1)})
      `;

      await addCitation(true, { sources: ['wikipedia.org', 'drivertest.example'] });
      await addCitation(false);

      const findingId = await addFinding({ severity: 90 });
      const actionId = await addAction(findingId, 'deployed');
      await db`
        insert into audit_requests (project_id, entity_id, root_url, requested_by, kind, action_id, status, verified)
        values (${projectId}, ${entityId}, 'https://drivertest.example', 'tester', 'verify', ${actionId}, 'done', true)
      `;
      verifiableActionId = actionId;

      await db`
        insert into audit_runs (project_id, pages_audited, findings_count, health_score, robots_found)
        values (${projectId}, 30, 3, 72, true)
      `;
      await db`
        insert into crawled_pages (project_id, url, status_code)
        values (${projectId}, 'https://drivertest.example/pricing', 200)
        on conflict do nothing
      `;

      await db`
        insert into entity_graph_audits (entity_id, project_id, score, wikidata_score, schema_score, sameas_score, corroboration_score, corroborating_domains)
        values (${entityId}, ${projectId}, 64, 40, 80, 70, 60, 3)
        on conflict (entity_id) do nothing
      `;
      await db`
        insert into local_audits (entity_id, project_id, score, gbp_score, nap_score, review_score, reviews_considered)
        values (${entityId}, ${projectId}, 61, 70, 80, null, 0)
      `;

      const [rival] = await db<{ id: string }[]>`
        insert into entities (project_id, canonical_name) values (${projectId}, 'Rival') returning id
      `;
      await db`
        insert into competitor_sets (project_id, self_entity_id, competitor_entity_id)
        values (${projectId}, ${entityId}, ${rival.id})
      `;
      await db`
        insert into competitor_gaps (project_id, self_entity_id, gap_type, item, held_by_count, held_by, impact)
        values (${projectId}, ${entityId}, 'schema', 'FAQPage', 2, '["Rival"]'::jsonb, 30)
      `;
    });

    /** The action `fix_verification` can actually report on, set by the seed. */
    let verifiableActionId = '';

    /** `fix_verification` needs a real action id; everything else takes no arguments. */
    function argsFor(name: string): Record<string, unknown> {
      return name === 'fix_verification' ? { actionId: verifiableActionId } : {};
    }

    /** Every dotted path a spec declares, paired with where it is read from. */
    function declaredPaths(render: ToolRender): { at: string; within: 'data' | 'row' | 'point' }[] {
      const paths: { at: string; within: 'data' | 'row' | 'point' }[] = [];
      for (const m of render.metrics ?? []) {
        paths.push({ at: m.at, within: 'data' });
        if (m.bandAt) paths.push({ at: m.bandAt, within: 'data' });
      }
      if (render.table) {
        paths.push({ at: render.table.at, within: 'data' });
        for (const c of render.table.columns) paths.push({ at: c.at, within: 'row' });
      }
      if (render.series) {
        paths.push({ at: render.series.at, within: 'data' });
        paths.push({ at: render.series.xAt, within: 'point' });
        paths.push({ at: render.series.yAt, within: 'point' });
      }
      if (render.component) paths.push({ at: render.component.at, within: 'data' });
      return paths;
    }

    /**
     * The test that closes the one weakness of declarative paths.
     *
     * `RENDER_SPECS` addresses handler output with dotted strings, so nothing
     * at compile time catches `totals.click` for `totals.clicks`. This runs
     * every spec against the seeded fixtures and fails on any path that
     * resolves to `undefined` on an `ok` result.
     *
     * `null` passes on purpose. A review score of null means "there were no
     * reviews to score", which is a measurement; `undefined` means the path is
     * wrong. Keeping those apart is the whole point.
     */
    it('resolves every declared path on a live ok result', async () => {
      const covered: string[] = [];

      for (const tool of READ_TOOLS) {
        const result = await call(tool.name, argsFor(tool.name));
        if (result.state !== 'ok') continue;
        covered.push(tool.name);

        const render = RENDER_SPECS[tool.name]!;
        for (const { at, within } of declaredPaths(render)) {
          if (within === 'data') {
            expect(pick(result.data, at), `${tool.name}: data.${at} does not exist`).not.toBeUndefined();
            continue;
          }
          // A row or point path is read against the first element of the
          // collection the spec already named.
          const collection = within === 'row'
            ? pick(result.data, render.table!.at)
            : pick(result.data, render.series!.at);
          const first = Array.isArray(collection) ? collection[0] : undefined;
          if (first === undefined) continue;
          expect(pick(first, at), `${tool.name}: row.${at} does not exist`).not.toBeUndefined();
        }
      }

      // The seed reaches `ok` on all nineteen, so every declared path is
      // checked against live data. Asserted as a number rather than left
      // implicit: without it this test passes by checking nothing on the day a
      // fixture stops producing data, which is exactly when it is needed.
      expect(covered.length, `only ${covered.length} tools reached ok: ${covered.join(', ')}`)
        .toBe(READ_TOOLS.length);
    });

    it('renders something for every tool that has data', async () => {
      for (const tool of READ_TOOLS) {
        const result = await call(tool.name, argsFor(tool.name));
        const parts = buildParts(tool.name, RENDER_SPECS[tool.name]!, result);

        // Either evidence, or one notice saying why there is none. Never
        // nothing: a blank answer to a question that worked is the failure
        // this whole file guards against.
        expect(parts.length, `${tool.name} (${result.state}) rendered no parts`).toBeGreaterThan(0);
        if (result.state !== 'ok') {
          expect(parts.map((p) => p.kind), tool.name).toEqual(['notice']);
        }
      }
    });
  });
});
