import type { Action, ActionStatus, ActionType, AuditEntry, DeployTarget, Diff } from '@engine/core';
import { toJsonb } from '../db.js';
import type { Db } from '../db.js';

interface ActionRow {
  id: string;
  finding_id: string;
  type: ActionType;
  target: DeployTarget;
  diff: Diff;
  status: ActionStatus;
  audit_log: AuditEntry[];
  reviewed_at: Date | null;
  reviewed_by: string | null;
}

function toAction(row: ActionRow): Action {
  return {
    id: row.id,
    findingId: row.finding_id,
    type: row.type,
    target: row.target,
    diff: row.diff,
    status: row.status,
    auditLog: row.audit_log,
    ...(row.reviewed_at ? { reviewedAt: row.reviewed_at.toISOString() } : {}),
    ...(row.reviewed_by ? { reviewedBy: row.reviewed_by } : {}),
  };
}

/**
 * Persist a freshly built (`proposed`) Action, letting Postgres assign the real id.
 *
 * jsonb columns go through `toJsonb(...)`, never `JSON.stringify(...)::jsonb`.
 * The cast makes Postgres infer the parameter as jsonb, so the driver then
 * JSON-encodes the string we already encoded — storing a jsonb *string* rather
 * than an object. It round-trips through this file well enough to look right,
 * but `target->>'kind'` is null and every jsonb query silently matches nothing.
 */
export async function createAction(db: Db, action: Action): Promise<Action> {
  const [row] = await db<ActionRow[]>`
    insert into actions (finding_id, type, target, diff, status, audit_log)
    values (
      ${action.findingId}, ${action.type}, ${toJsonb(db, action.target)},
      ${toJsonb(db, action.diff)}, ${action.status}, ${toJsonb(db, action.auditLog)}
    )
    returning id, finding_id, type, target, diff, status, audit_log, reviewed_at, reviewed_by
  `;
  return toAction(row);
}

/**
 * An Action as the Fix Queue needs to render it: the action itself plus the
 * predicted impact of the finding that caused it. Impact lives on the Finding
 * (it is a property of the problem, not of the fix), but a queue card is
 * unrankable without it, so the list projection carries it along.
 */
export interface QueuedAction extends Action {
  predictedImpact: number;
}

interface QueuedActionRow extends ActionRow {
  predicted_impact: string;
}

/**
 * Every Action in a project's Fix Queue, newest first.
 *
 * `actions` has no project_id: an action belongs to a project only *through*
 * findings -> entities. That indirection is the entity-first data model
 * (Architecture §3 / Roadmap sequencing rule 1) and is deliberately not
 * denormalized away — the entity is the join key for everything, and a
 * project_id column here would be a second, drift-prone source of that truth.
 */
export async function listActionsByProject(db: Db, projectId: string): Promise<QueuedAction[]> {
  const rows = await db<QueuedActionRow[]>`
    select
      a.id, a.finding_id, a.type, a.target, a.diff, a.status, a.audit_log, a.reviewed_at, a.reviewed_by,
      f.predicted_impact
    from actions a
    join findings f on f.id = a.finding_id
    join entities e on e.id = f.entity_id
    where e.project_id = ${projectId}
    order by a.created_at desc
  `;
  return rows.map((row) => ({ ...toAction(row), predictedImpact: Number(row.predicted_impact) }));
}

/**
 * Which of these findings already have at least one Action (any status) —
 * the guard `/audit`'s at-scale meta auto-propose (C3.2) needs so a re-audit
 * doesn't re-propose (and duplicate) a fix someone already has in their Fix
 * Queue, proposed or otherwise.
 */
export async function findingIdsWithActions(db: Db, findingIds: readonly string[]): Promise<Set<string>> {
  if (findingIds.length === 0) return new Set();
  const rows = await db<{ finding_id: string }[]>`
    select distinct finding_id from actions where finding_id in ${db(findingIds)}
  `;
  return new Set(rows.map((r) => r.finding_id));
}

export async function getAction(db: Db, id: string): Promise<Action | null> {
  const rows = await db<ActionRow[]>`
    select id, finding_id, type, target, diff, status, audit_log, reviewed_at, reviewed_by
    from actions where id = ${id}
  `;
  return rows[0] ? toAction(rows[0]) : null;
}

/** Persist a Fix Queue state transition produced by @engine/actions' `transition()`. */
export async function saveActionTransition(db: Db, action: Action): Promise<Action> {
  const [row] = await db<ActionRow[]>`
    update actions
    set status = ${action.status}, audit_log = ${toJsonb(db, action.auditLog)}, updated_at = now()
    where id = ${action.id}
    returning id, finding_id, type, target, diff, status, audit_log, reviewed_at, reviewed_by
  `;
  return toAction(row);
}

/**
 * Persist a review produced by @engine/actions' `reviewMarked()`: who read the
 * wording, when, and the text they settled on. The diff goes back too, because
 * a reviewer may edit before confirming and what deploys must be what they
 * read — writing the timestamp without the text would approve a version nobody
 * saw.
 */
export async function saveActionReview(db: Db, action: Action): Promise<Action> {
  const [row] = await db<ActionRow[]>`
    update actions
    set diff = ${toJsonb(db, action.diff)},
        audit_log = ${toJsonb(db, action.auditLog)},
        reviewed_at = ${action.reviewedAt ?? null},
        reviewed_by = ${action.reviewedBy ?? null},
        updated_at = now()
    where id = ${action.id}
    returning id, finding_id, type, target, diff, status, audit_log, reviewed_at, reviewed_by
  `;
  return toAction(row);
}
