import type { OnboardingProgress } from '@engine/core';
import type { Db } from '../db.js';

interface Row {
  project_id: string;
  domain_connected_at: Date | null;
  gsc_connected_at: Date | null;
  first_crawl_at: Date | null;
  first_insight_at: Date | null;
  first_fix_proposed_at: Date | null;
  first_fix_deployed_at: Date | null;
}

function toProgress(row: Row): OnboardingProgress {
  return {
    projectId: row.project_id,
    domainConnectedAt: row.domain_connected_at?.toISOString() ?? null,
    gscConnectedAt: row.gsc_connected_at?.toISOString() ?? null,
    firstCrawlAt: row.first_crawl_at?.toISOString() ?? null,
    firstInsightAt: row.first_insight_at?.toISOString() ?? null,
    firstFixProposedAt: row.first_fix_proposed_at?.toISOString() ?? null,
    firstFixDeployedAt: row.first_fix_deployed_at?.toISOString() ?? null,
  };
}

export async function getOnboardingProgress(db: Db, projectId: string): Promise<OnboardingProgress> {
  const [row] = await db<Row[]>`
    insert into onboarding_progress (project_id) values (${projectId})
    on conflict (project_id) do update set project_id = excluded.project_id
    returning *
  `;
  return toProgress(row);
}

// One explicit query per milestone column — deliberately not a dynamic-column
// helper, so there's no identifier interpolation into SQL to reason about.
// `coalesce` makes each a set-once: a later call for an already-set milestone
// is a no-op, which is what makes these timestamps valid KPI instrumentation.

export async function markDomainConnected(db: Db, projectId: string): Promise<OnboardingProgress> {
  const [row] = await db<Row[]>`
    insert into onboarding_progress (project_id, domain_connected_at) values (${projectId}, now())
    on conflict (project_id) do update set domain_connected_at = coalesce(onboarding_progress.domain_connected_at, now())
    returning *
  `;
  return toProgress(row);
}

export async function markGscConnected(db: Db, projectId: string): Promise<OnboardingProgress> {
  const [row] = await db<Row[]>`
    insert into onboarding_progress (project_id, gsc_connected_at) values (${projectId}, now())
    on conflict (project_id) do update set gsc_connected_at = coalesce(onboarding_progress.gsc_connected_at, now())
    returning *
  `;
  return toProgress(row);
}

export async function markFirstCrawl(db: Db, projectId: string): Promise<OnboardingProgress> {
  const [row] = await db<Row[]>`
    insert into onboarding_progress (project_id, first_crawl_at) values (${projectId}, now())
    on conflict (project_id) do update set first_crawl_at = coalesce(onboarding_progress.first_crawl_at, now())
    returning *
  `;
  return toProgress(row);
}

export async function markFirstInsight(db: Db, projectId: string): Promise<OnboardingProgress> {
  const [row] = await db<Row[]>`
    insert into onboarding_progress (project_id, first_insight_at) values (${projectId}, now())
    on conflict (project_id) do update set first_insight_at = coalesce(onboarding_progress.first_insight_at, now())
    returning *
  `;
  return toProgress(row);
}

export async function markFirstFixProposed(db: Db, projectId: string): Promise<OnboardingProgress> {
  const [row] = await db<Row[]>`
    insert into onboarding_progress (project_id, first_fix_proposed_at) values (${projectId}, now())
    on conflict (project_id) do update set first_fix_proposed_at = coalesce(onboarding_progress.first_fix_proposed_at, now())
    returning *
  `;
  return toProgress(row);
}

export async function markFirstFixDeployed(db: Db, projectId: string): Promise<OnboardingProgress> {
  const [row] = await db<Row[]>`
    insert into onboarding_progress (project_id, first_fix_deployed_at) values (${projectId}, now())
    on conflict (project_id) do update set first_fix_deployed_at = coalesce(onboarding_progress.first_fix_deployed_at, now())
    returning *
  `;
  return toProgress(row);
}
