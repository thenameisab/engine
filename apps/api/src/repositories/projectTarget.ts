import type { DeployTarget } from '@engine/core';
import { toJsonb } from '../db.js';
import type { Db } from '../db.js';

/**
 * A project's configured deploy target — where every generated Action for it
 * lands. `ActionContext.target` is required, but until now a caller had to pass
 * one inline on every generate call; the dashboard had nowhere to read a
 * project's target from, which is why it could not offer a "propose a fix"
 * button. Stored as a jsonb `DeployTarget` (packages/core/src/contract.ts),
 * null until configured.
 */
export async function getProjectDeployTarget(db: Db, projectId: string): Promise<DeployTarget | null> {
  const rows = await db<{ deploy_target: DeployTarget | null }[]>`
    select deploy_target from projects where id::text = ${projectId} limit 1
  `;
  return rows.length > 0 ? rows[0].deploy_target : null;
}

/** Set (or replace) a project's deploy target. */
export async function setProjectDeployTarget(db: Db, projectId: string, target: DeployTarget): Promise<void> {
  await db`
    update projects set deploy_target = ${toJsonb(db, target)} where id::text = ${projectId}
  `;
}
