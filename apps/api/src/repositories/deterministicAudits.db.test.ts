import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.js';
import {
  listDueAudits,
  recordDeterministicAuditRun,
  latestDeterministicAuditRun,
  runEntityAuditAfterCrawl,
  runScheduledDeterministicAudits,
} from './deterministicAudits.js';

/**
 * The nightly pass's due-check, against a real Postgres.
 *
 * Everything that decides *what runs tonight* lives inside one query: three
 * `exists` sub-selects that say which entity each audit can speak about, and a
 * lateral join onto the run history that says which of those are stale. A
 * stubbed `db` returns whatever it was told to and proves none of it. The two
 * failures that matter are silent ones — a candidate that is never selected
 * means an audit that never runs again, and a due-window that never matches
 * means the same thing with a passing unit test in front of it.
 *
 * Runs only when `TEST_DATABASE_URL` points at a migrated database; CI has
 * none and skips.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('deterministic audits (Postgres)', () => {
  let db: Db;
  let accountId: string;
  let projectId: string;
  let entityId: string;

  beforeAll(async () => {
    db = createDb(url!);
    const [account] = await db<{ id: string }[]>`
      insert into accounts (name) values ('audit-test ' || gen_random_uuid()::text) returning id
    `;
    accountId = account.id;
    const [project] = await db<{ id: string }[]>`
      insert into projects (account_id, name, domain)
      values (${accountId}, 'audit test', 'audit-test.example') returning id
    `;
    projectId = project.id;
    const [entity] = await db<{ id: string }[]>`
      insert into entities (project_id, canonical_name) values (${projectId}, 'Audit Test Co') returning id
    `;
    entityId = entity.id;
  });

  afterAll(async () => {
    await db`delete from accounts where id::text = ${accountId}`;
    await db.end();
  });

  beforeEach(async () => {
    await db`delete from deterministic_audit_runs where project_id = ${projectId}`;
    await db`delete from citation_events where entity_id = ${entityId}`;
    await db`delete from competitor_sets where self_entity_id = ${entityId}`;
    await db`delete from local_profiles where entity_id = ${entityId}`;
  });

  /** One citation sample, which is what makes the off-site audit have an input. */
  async function addCitationEvent(): Promise<void> {
    await db`
      insert into citation_events (entity_id, engine, prompt, cited, sources_cited, method, raw_answer_ref, sampled_at)
      values (${entityId}, 'sarvam', 'who is audit test co', false, '{}', 'api', 'ref', now())
    `;
  }

  /** A run of `kind`, `hoursAgo` in the past. */
  async function ranAt(kind: string, hoursAgo: number): Promise<void> {
    await db`
      insert into deterministic_audit_runs (project_id, entity_id, kind, trigger, findings_count, ran_at)
      values (${projectId}, ${entityId}, ${kind}, 'schedule', 0, now() - (${String(hoursAgo)} || ' hours')::interval)
    `;
  }

  function kindsFor(due: { entityId: string; kind: string }[]): string[] {
    return due.filter((d) => d.entityId === entityId).map((d) => d.kind).sort();
  }

  it('selects nothing for an entity with no citations, no competitors and no profile', async () => {
    expect(kindsFor(await listDueAudits(db))).toEqual([]);
  });

  it('selects off-site only once a citation sample exists', async () => {
    await addCitationEvent();
    expect(kindsFor(await listDueAudits(db))).toEqual(['offsite']);
  });

  it('selects local only once profile facts exist', async () => {
    await db`
      insert into local_profiles (entity_id, project_id, profile)
      values (${entityId}, ${projectId}, '{}'::jsonb)
    `;
    expect(kindsFor(await listDueAudits(db))).toEqual(['local']);
  });

  it('holds a kind back for 20 hours after it ran, then offers it again', async () => {
    await addCitationEvent();

    await ranAt('offsite', 2);
    expect(kindsFor(await listDueAudits(db))).toEqual([]);

    // 19 hours is still inside the window: a cron that fired a few minutes
    // early must not turn a nightly audit into an every-other-night one, and
    // must not run it twice in one night either.
    await db`delete from deterministic_audit_runs where project_id = ${projectId}`;
    await ranAt('offsite', 19);
    expect(kindsFor(await listDueAudits(db))).toEqual([]);

    await db`delete from deterministic_audit_runs where project_id = ${projectId}`;
    await ranAt('offsite', 21);
    expect(kindsFor(await listDueAudits(db))).toEqual(['offsite']);
  });

  it('holds back only the kind that ran, not the others', async () => {
    await addCitationEvent();
    await db`
      insert into local_profiles (entity_id, project_id, profile)
      values (${entityId}, ${projectId}, '{}'::jsonb)
    `;
    await ranAt('offsite', 2);
    expect(kindsFor(await listDueAudits(db))).toEqual(['local']);
  });

  it('reports the newest run per kind, and null for a kind that never ran', async () => {
    await recordDeterministicAuditRun(db, {
      projectId,
      entityId: null,
      kind: 'entity',
      trigger: 'crawl',
      findingsCount: 4,
    });

    const entityRun = await latestDeterministicAuditRun(db, projectId, 'entity');
    expect(entityRun).toMatchObject({ kind: 'entity', trigger: 'crawl', findingsCount: 4 });
    expect(await latestDeterministicAuditRun(db, projectId, 'local')).toBeNull();
  });

  it('records a clean run, so "found nothing" is distinguishable from "never ran"', async () => {
    // The whole reason this table exists: an audit that finds nothing writes no
    // result row anywhere, so without a run record the screen cannot tell a
    // clean result from an audit nobody ever started.
    await recordDeterministicAuditRun(db, {
      projectId,
      entityId,
      kind: 'competitor',
      trigger: 'schedule',
      findingsCount: 0,
    });
    const run = await latestDeterministicAuditRun(db, projectId, 'competitor');
    expect(run).not.toBeNull();
    expect(run!.findingsCount).toBe(0);
  });

  it('records an entity audit after a crawl, without a button', async () => {
    // The defect this replaces: `entity_graph_audits` held one row in
    // production, from one press, ever. A customer's first visit is the visit
    // that matters, and on it nobody has pressed anything.
    await runEntityAuditAfterCrawl(db, projectId);
    const run = await latestDeterministicAuditRun(db, projectId, 'entity');
    expect(run).toMatchObject({ kind: 'entity', trigger: 'crawl' });
  });

  it('runs a due audit on the nightly pass, then finds nothing due on the next', async () => {
    await addCitationEvent();

    const first = await runScheduledDeterministicAudits(db);
    expect(first.failed).toEqual([]);
    expect(first.ran).toBeGreaterThanOrEqual(1);
    expect(await latestDeterministicAuditRun(db, projectId, 'offsite')).toMatchObject({ trigger: 'schedule' });

    // Running twice in one night would double every audit's work for nothing.
    expect(kindsFor(await listDueAudits(db))).toEqual([]);
    const second = await runScheduledDeterministicAudits(db);
    expect(second.attempted).toBe(0);
  });
});