/**
 * Scheduled crawls (issue 10): queue an audit for every project whose crawl
 * cadence says one is due.
 *
 * Until now a crawl happened only when someone pressed "Run audit". The
 * runner drains the queue on its own schedule, so making crawls periodic is a
 * matter of putting requests in the queue on time, which is what the nightly
 * pass does here. `on_demand` accounts are skipped entirely.
 *
 * "Due" is measured from the last audit run *or* the last request, whichever
 * is newer, so a request that is queued or still running does not get a twin
 * — and `createAuditRequest` refuses a second live request anyway.
 */
import { CADENCE_WINDOW_HOURS, effectiveCadence, type CadenceOverride, type PlanTier } from '@engine/core';
import { createAuditRequest, type AuditRequest } from './auditRequests.js';
import type { Db } from '../db.js';

/** Who a scheduled request says asked for it. `requested_by` is free text, not a user id. */
export const CADENCE_REQUESTER = 'system:cadence';

export interface DueCrawl {
  projectId: string;
  accountId: string;
  entityId: string;
  domain: string;
  cadence: 'weekly' | 'monthly';
}

/**
 * Projects whose last crawl activity is older than their cadence window and
 * whose cadence is not on-demand. The window comes from the effective
 * policy, resolved here in SQL for the tier and override so one query answers
 * for every project.
 */
export async function listDueCrawls(db: Db, cap: number): Promise<DueCrawl[]> {
  const rows = await db<
    {
      project_id: string;
      account_id: string;
      entity_id: string;
      domain: string;
      plan_tier: PlanTier | null;
      rank_poll: CadenceOverride['rankPoll'] | null;
      ai_poll: CadenceOverride['aiPoll'] | null;
      crawl: CadenceOverride['crawl'] | null;
      has_override: boolean;
      last_activity: Date | null;
    }[]
  >`
    select p.id as project_id, p.account_id, e.id as entity_id, p.domain,
           s.plan_tier, c.rank_poll, c.ai_poll, c.crawl, (c.account_id is not null) as has_override,
           greatest(
             (select max(created_at) from audit_runs r where r.project_id = p.id),
             (select max(created_at) from audit_requests q where q.project_id = p.id)
           ) as last_activity
    from projects p
    join lateral (
      select id from entities e where e.project_id = p.id and e.role = 'self' order by e.created_at asc limit 1
    ) e on true
    left join subscriptions s on s.account_id = p.account_id
    left join account_cadence c on c.account_id = p.account_id
    order by last_activity asc nulls first
  `;
  const now = Date.now();
  const due: DueCrawl[] = [];
  for (const r of rows) {
    const override = r.has_override ? { rankPoll: r.rank_poll, aiPoll: r.ai_poll, crawl: r.crawl } : null;
    const cadence = effectiveCadence(r.plan_tier ?? 'free', override).policy.crawl;
    if (cadence === 'on_demand') continue;
    const windowMs = CADENCE_WINDOW_HOURS[cadence] * 3_600_000;
    if (r.last_activity && now - new Date(r.last_activity).getTime() < windowMs) continue;
    due.push({ projectId: r.project_id, accountId: r.account_id, entityId: r.entity_id, domain: r.domain, cadence });
    if (due.length >= cap) break;
  }
  return due;
}

export interface ScheduledCrawlSummary {
  attempted: number;
  queued: AuditRequest[];
  /** Projects skipped because a request was already live. */
  alreadyQueued: number;
  failed: { projectId: string; error: string }[];
}

/** One nightly pass: a cap on new requests, because each one is real runner minutes. */
export const DEFAULT_NIGHTLY_CRAWL_CAP = 10;

export async function queueDueCrawls(db: Db, maxPages: number, cap = DEFAULT_NIGHTLY_CRAWL_CAP): Promise<ScheduledCrawlSummary> {
  const due = await listDueCrawls(db, cap);
  const summary: ScheduledCrawlSummary = { attempted: 0, queued: [], alreadyQueued: 0, failed: [] };
  for (const item of due) {
    summary.attempted++;
    try {
      const request = await createAuditRequest(db, {
        projectId: item.projectId,
        entityId: item.entityId,
        rootUrl: `https://${item.domain}`,
        maxPages,
        requestedBy: CADENCE_REQUESTER,
      });
      if (request) summary.queued.push(request);
      else summary.alreadyQueued++;
    } catch (error) {
      summary.failed.push({ projectId: item.projectId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return summary;
}
