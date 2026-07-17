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

export interface AuditRun {
  id: string;
  projectId: string;
  pagesAudited: number;
  findingsCount: number;
  healthScore: number;
  createdAt: string;
}

interface AuditRunRow {
  id: string;
  project_id: string;
  pages_audited: number;
  findings_count: number;
  health_score: number;
  created_at: Date;
}

function toAuditRun(row: AuditRunRow): AuditRun {
  return {
    id: row.id,
    projectId: row.project_id,
    pagesAudited: row.pages_audited,
    findingsCount: row.findings_count,
    healthScore: row.health_score,
    createdAt: row.created_at.toISOString(),
  };
}

export async function recordAuditRun(
  db: Db,
  run: { projectId: string; pagesAudited: number; findingsCount: number; healthScore: number },
): Promise<AuditRun> {
  const [row] = await db<AuditRunRow[]>`
    insert into audit_runs (project_id, pages_audited, findings_count, health_score)
    values (${run.projectId}, ${run.pagesAudited}, ${run.findingsCount}, ${run.healthScore})
    returning id, project_id, pages_audited, findings_count, health_score, created_at
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
    select id, project_id, pages_audited, findings_count, health_score, created_at
    from audit_runs
    where project_id::text = ${projectId}
    order by created_at desc
    limit 1
  `;
  return rows[0] ? toAuditRun(rows[0]) : null;
}
