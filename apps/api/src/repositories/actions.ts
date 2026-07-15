import type { Action, ActionStatus, ActionType, AuditEntry, DeployTarget, Diff } from '@engine/core';
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

/** Persist a freshly built (`proposed`) Action, letting Postgres assign the real id. */
export async function createAction(db: Db, action: Action): Promise<Action> {
  const [row] = await db<ActionRow[]>`
    insert into actions (finding_id, type, target, diff, status, audit_log)
    values (
      ${action.findingId}, ${action.type}, ${JSON.stringify(action.target)}::jsonb,
      ${JSON.stringify(action.diff)}::jsonb, ${action.status}, ${JSON.stringify(action.auditLog)}::jsonb
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
    set status = ${action.status}, audit_log = ${JSON.stringify(action.auditLog)}::jsonb, updated_at = now()
    where id = ${action.id}
    returning id, finding_id, type, target, diff, status, audit_log
  `;
  return toAction(row);
}
