/**
 * Audit runs — where the §8 technical health score lives.
 *
 * The score is normalized by pages audited, which makes it a property of a
 * *run* rather than of the finding inventory. Crawled pages are not persisted
 * (the rule engine takes `CrawledPage[]` and keeps only its conclusions), so a
 * score cannot be recomputed later from findings alone. Recording the run is
 * what lets the Audit view show a real number instead of a plausible one.
 */
import type { Db } from '../db.js';

/**
 * What the crawl behind a run could reach. Null throughout for runs recorded
 * before migration 0027: "we did not record this" is a different statement
 * from "there was no sitemap", and only one of them is true of an old row.
 */
export interface AuditRunCoverage {
  robotsFound: boolean | null;
  sitemapUrls: number | null;
  linksDiscovered: number | null;
  blockedByRobots: number | null;
  stoppedAtLimit: boolean | null;
  maxPages: number | null;
}

export interface AuditRun {
  id: string;
  projectId: string;
  pagesAudited: number;
  findingsCount: number;
  healthScore: number;
  coverage: AuditRunCoverage | null;
  createdAt: string;
}

interface AuditRunRow {
  id: string;
  project_id: string;
  pages_audited: number;
  findings_count: number;
  health_score: number;
  robots_found: boolean | null;
  sitemap_urls: number | null;
  links_discovered: number | null;
  blocked_by_robots: number | null;
  stopped_at_limit: boolean | null;
  max_pages: number | null;
  created_at: Date;
}

function toAuditRun(row: AuditRunRow): AuditRun {
  return {
    id: row.id,
    projectId: row.project_id,
    pagesAudited: row.pages_audited,
    findingsCount: row.findings_count,
    healthScore: row.health_score,
    // A run has coverage or it does not; a half-filled object would invite a
    // caller to read a null as a zero.
    coverage:
      row.max_pages === null
        ? null
        : {
            robotsFound: row.robots_found,
            sitemapUrls: row.sitemap_urls,
            linksDiscovered: row.links_discovered,
            blockedByRobots: row.blocked_by_robots,
            stoppedAtLimit: row.stopped_at_limit,
            maxPages: row.max_pages,
          },
    createdAt: row.created_at.toISOString(),
  };
}

export async function recordAuditRun(
  db: Db,
  run: {
    projectId: string;
    pagesAudited: number;
    findingsCount: number;
    healthScore: number;
    coverage?: AuditRunCoverage | null;
  },
): Promise<AuditRun> {
  const c = run.coverage ?? null;
  const [row] = await db<AuditRunRow[]>`
    insert into audit_runs
      (project_id, pages_audited, findings_count, health_score,
       robots_found, sitemap_urls, links_discovered, blocked_by_robots, stopped_at_limit, max_pages)
    values (
      ${run.projectId}, ${run.pagesAudited}, ${run.findingsCount}, ${run.healthScore},
      ${c?.robotsFound ?? null}, ${c?.sitemapUrls ?? null}, ${c?.linksDiscovered ?? null},
      ${c?.blockedByRobots ?? null}, ${c?.stoppedAtLimit ?? null}, ${c?.maxPages ?? null}
    )
    returning id, project_id, pages_audited, findings_count, health_score,
              robots_found, sitemap_urls, links_discovered, blocked_by_robots, stopped_at_limit, max_pages, created_at
  `;
  return toAuditRun(row);
}

/**
 * The newest run for a project, or null if it has never been audited. Null is a
 * real answer the caller must handle — a project with no crawl has no health
 * score, and defaulting to 100 would tell a new user their site is perfect.
 */
export async function latestAuditRun(db: Db, projectId: string): Promise<AuditRun | null> {
  const rows = await db<AuditRunRow[]>`
    select id, project_id, pages_audited, findings_count, health_score,
           robots_found, sitemap_urls, links_discovered, blocked_by_robots, stopped_at_limit, max_pages, created_at
    from audit_runs
    where project_id::text = ${projectId}
    order by created_at desc
    limit 1
  `;
  return rows[0] ? toAuditRun(rows[0]) : null;
}
