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
    returning id, finding_id, type, target, diff, status, audit_log
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
      a.id, a.finding_id, a.type, a.target, a.diff, a.status, a.audit_log,
      f.predicted_impact
    from actions a
    join findings f on f.id = a.finding_id
    join entities e on e.id = f.entity_id
    where e.project_id = ${projectId}
    order by a.created_at desc
  `;
  return rows.map((row) => ({ ...toAction(row), predictedImpact: Number(row.predicted_impact) }));
}

export async function getAction(db: Db, id: string): Promise<Action | null> {
  const rows = await db<ActionRow[]>`
    select id, finding_id, type, target, diff, status, audit_log from actions where id = ${id}
  `;
  return rows[0] ? toAction(rows[0]) : null;
}

/** Persist a Fix Queue state transition produced by @engine/actions' `transition()`. */
export async function saveActionTransition(db: Db, action: Action): Promise<Action> {
  const [row] = await db<ActionRow[]>`
    update actions
    set status = ${action.status}, audit_log = ${toJsonb(db, action.auditLog)}, updated_at = now()
    where id = ${action.id}
    returning id, finding_id, type, target, diff, status, audit_log
  `;
  return toAction(row);
}
