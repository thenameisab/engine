/**
 * The four deterministic audits, on a schedule instead of a button.
 *
 * Entity, off-site, competitor and local each read facts the system already
 * holds and call nothing external, so each is idempotent and cheap. Every one
 * of them was reachable only through a button on its own screen, and the
 * production data says what that means: `entity_graph_audits` held one row,
 * from one press, ever. A customer's first visit is the visit that matters,
 * and on that visit nobody has pressed anything.
 *
 * Two triggers replace the button. The entity audit runs when a crawl
 * finishes, because a crawl is the moment the facts changed. The other three
 * run nightly, folded into the existing 03:15 pass after the Google sync,
 * because their inputs (citation samples, competitor sets, profile facts)
 * change on their own schedules and not on the customer's.
 *
 * The buttons stay. They are now a way to ask for a fresh answer, not the only
 * way to get one.
 */
import { runProjectEntityAudit } from './entityAudit.js';
import { runProjectOffsiteAudit } from './offsite.js';
import { runProjectCompetitorAudit } from './competitor.js';
import { runProjectLocalAudit } from './local.js';
import type { Db } from '../db.js';

export type DeterministicAuditKind = 'entity' | 'offsite' | 'competitor' | 'local';
export type DeterministicAuditTrigger = 'crawl' | 'schedule' | 'manual';

/** The three kinds the nightly pass owns. `entity` is driven by the crawl. */
export const NIGHTLY_AUDIT_KINDS: readonly DeterministicAuditKind[] = ['offsite', 'competitor', 'local'];

/**
 * A cap on audits per nightly run. None of these spends a vendor credit, so
 * the cap is about the Worker's own wall clock, not money: a scheduled handler
 * that runs past its limit is killed mid-pass, and the work it had already
 * committed is indistinguishable from the work it never reached. Stopping on
 * purpose leaves a record that says so.
 */
export const DEFAULT_NIGHTLY_AUDIT_CAP = 100;

/**
 * How stale a run must be before the nightly pass repeats it. 20 hours rather
 * than 24 for the reason the rank poll uses the same figure: a cron fires with
 * drift, so demanding a full day would turn a nightly audit into an
 * every-other-night one. The slack is far smaller than the gap between runs,
 * so nothing is audited twice in a night either.
 */
const DUE_AFTER_HOURS = 20;

export interface DueAudit {
  projectId: string;
  entityId: string;
  kind: DeterministicAuditKind;
}

/** Record that an audit ran, whatever it found. */
export async function recordDeterministicAuditRun(
  db: Db,
  run: {
    projectId: string;
    entityId: string | null;
    kind: DeterministicAuditKind;
    trigger: DeterministicAuditTrigger;
    findingsCount: number;
  },
): Promise<void> {
  await db`
    insert into deterministic_audit_runs (project_id, entity_id, kind, trigger, findings_count)
    values (${run.projectId}, ${run.entityId}, ${run.kind}, ${run.trigger}, ${run.findingsCount})
  `;
}

export interface DeterministicAuditRunRecord {
  kind: DeterministicAuditKind;
  trigger: DeterministicAuditTrigger;
  findingsCount: number;
  ranAt: string;
}

/**
 * The newest run of one kind for a project — the "last run" line each screen
 * shows. Null means it has genuinely never run, which is a different statement
 * from "it ran and found nothing", and the two must not look alike.
 */
export async function latestDeterministicAuditRun(
  db: Db,
  projectId: string,
  kind: DeterministicAuditKind,
): Promise<DeterministicAuditRunRecord | null> {
  const rows = await db<{ kind: DeterministicAuditKind; trigger: DeterministicAuditTrigger; findings_count: number; ran_at: Date }[]>`
    select kind, trigger, findings_count, ran_at
    from deterministic_audit_runs
    where project_id = ${projectId} and kind = ${kind}
    order by ran_at desc
    limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  return { kind: row.kind, trigger: row.trigger, findingsCount: row.findings_count, ranAt: row.ran_at.toISOString() };
}

/**
 * Everything the nightly pass should run, least recently audited first.
 *
 * Each kind selects only the entities it can say something about, because an
 * audit with no input is not a clean result — it is no result, and recording
 * it would make "last run" a promise the screen cannot keep. Off-site mines
 * citation samples, so it needs at least one; the competitor audit needs a
 * competitor set; the local audit needs profile facts.
 */
export async function listDueAudits(db: Db, cap = DEFAULT_NIGHTLY_AUDIT_CAP): Promise<DueAudit[]> {
  const rows = await db<{ project_id: string; entity_id: string; kind: DeterministicAuditKind }[]>`
    with candidates as (
      select e.project_id, e.id as entity_id, 'offsite'::text as kind
      from entities e
      where exists (select 1 from citation_events ce where ce.entity_id = e.id)
      union all
      select e.project_id, e.id, 'competitor'
      from entities e
      where exists (select 1 from competitor_sets cs where cs.self_entity_id = e.id)
      union all
      select e.project_id, e.id, 'local'
      from entities e
      where exists (select 1 from local_profiles lp where lp.entity_id = e.id)
    )
    select c.project_id, c.entity_id, c.kind
    from candidates c
    left join lateral (
      select max(r.ran_at) as ran_at
      from deterministic_audit_runs r
      where r.project_id = c.project_id and r.entity_id = c.entity_id and r.kind = c.kind
    ) last on true
    where last.ran_at is null
        or last.ran_at < now() - (${DUE_AFTER_HOURS} * interval '1 hour')
    order by last.ran_at asc nulls first, c.entity_id asc
    limit ${cap}
  `;
  return rows.map((r) => ({ projectId: r.project_id, entityId: r.entity_id, kind: r.kind }));
}

export interface ScheduledAuditSummary {
  attempted: number;
  ran: number;
  failed: { projectId: string; entityId: string; kind: DeterministicAuditKind; error: string }[];
  /** True when the pass stopped at `cap` with more audits still due. */
  capped: boolean;
}

/**
 * Run one due audit and return how many findings it produced, or null when it
 * had nothing to audit after all (a profile deleted between the due query and
 * here, say). Null is not an error and is not recorded as a run.
 */
async function runOne(db: Db, due: DueAudit): Promise<number | null> {
  if (due.kind === 'offsite') {
    const result = await runProjectOffsiteAudit(db, due.projectId, due.entityId);
    return result ? result.findings.length : null;
  }
  if (due.kind === 'competitor') {
    const result = await runProjectCompetitorAudit(db, due.projectId, due.entityId);
    return result ? result.findings.length : null;
  }
  const result = await runProjectLocalAudit(db, due.projectId, due.entityId);
  if (result === null || result === 'no-profile') return null;
  return result.findings.length;
}

/**
 * Run every due audit.
 *
 * One failure does not abort the pass. These share a database and nothing
 * else, so one project's broken row must not cost every other project its
 * night — which is exactly what an uncaught throw in a scheduled handler does.
 */
export async function runScheduledDeterministicAudits(
  db: Db,
  cap = DEFAULT_NIGHTLY_AUDIT_CAP,
): Promise<ScheduledAuditSummary> {
  const due = await listDueAudits(db, cap);
  const summary: ScheduledAuditSummary = { attempted: 0, ran: 0, failed: [], capped: due.length === cap };

  for (const item of due) {
    summary.attempted++;
    try {
      const findingsCount = await runOne(db, item);
      if (findingsCount === null) continue;
      await recordDeterministicAuditRun(db, {
        projectId: item.projectId,
        entityId: item.entityId,
        kind: item.kind,
        trigger: 'schedule',
        findingsCount,
      });
      summary.ran++;
    } catch (error) {
      summary.failed.push({
        projectId: item.projectId,
        entityId: item.entityId,
        kind: item.kind,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return summary;
}

/**
 * The entity audit that follows a crawl.
 *
 * Called from the runner's `finish` route rather than from the runner itself:
 * the runner is a public GitHub Action holding one service token, and giving
 * it a second call to make would mean a second way for the pass to be half
 * done. The API already knows the crawl finished, so it is the API that acts.
 *
 * Never throws. A crawl that produced findings must be recorded as finished
 * even if the entity audit that follows it fails.
 */
export async function runEntityAuditAfterCrawl(db: Db, projectId: string): Promise<void> {
  try {
    const result = await runProjectEntityAudit(db, projectId);
    await recordDeterministicAuditRun(db, {
      projectId,
      entityId: null,
      kind: 'entity',
      trigger: 'crawl',
      findingsCount: result.findings.length,
    });
  } catch (error) {
    console.warn(`entity audit after crawl failed for project ${projectId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
