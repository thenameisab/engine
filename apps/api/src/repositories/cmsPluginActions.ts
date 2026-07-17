import type { Action, ActionType, Diff } from '@engine/core';
import type { Db } from '../db.js';

/** A pending cms-plugin Action plus the page URL its Finding was raised on. */
export type PendingCmsPluginAction = Pick<Action, 'id' | 'type' | 'diff'> & { pageUrl: string | null };

interface Row {
  id: string;
  type: ActionType;
  diff: Diff;
  page_url: string | null;
}

/**
 * The 'cms-plugin' DeployTarget's pull queue (C2.2): every `approved` Action
 * scoped to one plugin install (`plugin` + `siteId`), with the page URL its
 * diagnosis Finding was raised on (from `evidence.url` — same join
 * `listLiveEdgeActions` in apps/workers uses for the edge-worker target).
 *
 * Deliberately `approved`, not `deployed`/`verified` like the edge-worker
 * query: the edge-worker applies live actions on every request forever, so it
 * reads the *live* set. A CMS plugin instead does a one-time push — it polls
 * this queue, writes the diff into the CMS via the CMS's own API, then calls
 * the ordinary `POST .../actions/:id/deploy` transition to record that the
 * push happened. `deployed` actions therefore drop out of this query on their
 * own; there is no separate "mark seen" step.
 */
export async function listPendingCmsPluginActions(
  db: Db,
  projectId: string,
  plugin: 'wordpress' | 'shopify',
  siteId: string,
): Promise<PendingCmsPluginAction[]> {
  const rows = await db<Row[]>`
    select a.id, a.type, a.diff, f.evidence->>'url' as page_url
    from actions a
    join findings f on f.id = a.finding_id
    join entities e on e.id = f.entity_id
    where e.project_id = ${projectId}
      and a.status = 'approved'
      and a.target->>'kind' = 'cms-plugin'
      and a.target->>'plugin' = ${plugin}
      and a.target->>'siteId' = ${siteId}
  `;
  return rows.map((r) => ({ id: r.id, type: r.type, diff: r.diff, pageUrl: r.page_url }));
}
