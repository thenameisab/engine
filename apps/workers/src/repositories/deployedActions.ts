import type { Action, ActionStatus, ActionType, DeployTarget, Diff } from '@engine/core';
import type { Db } from '../db.js';

/** A live Action plus the page URL its Finding was raised on (schema/meta actions are page-scoped). */
export type DeployedAction = Action & { pageUrl: string | null };

interface Row {
  id: string;
  finding_id: string;
  type: ActionType;
  target: DeployTarget;
  diff: Diff;
  status: ActionStatus;
  page_url: string | null;
}

function toDeployedAction(row: Row): DeployedAction {
  return {
    id: row.id,
    findingId: row.finding_id,
    type: row.type,
    target: row.target,
    diff: row.diff,
    status: row.status,
    auditLog: [],
    pageUrl: row.page_url,
  };
}

/**
 * Every live (`deployed` or `verified`) edge-worker Action for a project,
 * with the page URL its diagnosis Finding was raised on (from `evidence.url`).
 * The worker applies these per-request; a rolled-back action stops applying
 * as soon as its status flips, with no separate un-deploy step.
 */
export async function listLiveEdgeActions(db: Db, projectId: string): Promise<DeployedAction[]> {
  const rows = await db<Row[]>`
    select a.id, a.finding_id, a.type, a.target, a.diff, a.status, f.evidence->>'url' as page_url
    from actions a
    join findings f on f.id = a.finding_id
    join entities e on e.id = f.entity_id
    where e.project_id = ${projectId}
      and a.status in ('deployed', 'verified')
      and a.target->>'kind' = 'edge-worker'
  `;
  return rows.map(toDeployedAction);
}
