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
