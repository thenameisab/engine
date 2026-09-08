/**
 * Audit requests — the queue between "Run audit" and the crawl runner.
 *
 * Status moves queued → running → done | failed, and only forward. The claim
 * and finish updates are conditional on the current status, so two runners
 * cannot take one request and a late "finish" cannot overwrite a newer state.
 */
import type { Db } from '../db.js';

export type AuditRequestStatus = 'queued' | 'running' | 'done' | 'failed';

export interface AuditRequest {
  id: string;
  projectId: string;
  entityId: string;
  rootUrl: string;
  maxPages: number;
  status: AuditRequestStatus;
  requestedBy: string;
  error: string | null;
  auditRunId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

interface Row {
  id: string;
  project_id: string;
  entity_id: string;
  root_url: string;
  max_pages: number;
  status: AuditRequestStatus;
  requested_by: string;
  error: string | null;
  audit_run_id: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

const COLUMNS = `id, project_id, entity_id, root_url, max_pages, status, requested_by, error,
  audit_run_id, created_at, started_at, finished_at`;

function toRequest(row: Row): AuditRequest {
  return {
    id: row.id,
    projectId: row.project_id,
    entityId: row.entity_id,
    rootUrl: row.root_url,
    maxPages: row.max_pages,
    status: row.status,
    requestedBy: row.requested_by,
    error: row.error,
    auditRunId: row.audit_run_id,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
  };
}

/** Postgres unique_violation. */
const UNIQUE_VIOLATION = '23505';

/**
 * Queue a request. Returns null when the project already has one queued or
 * running: the partial unique index is the arbiter, so two tabs racing still
 * produce one row.
 */
export async function createAuditRequest(
  db: Db,
  input: { projectId: string; entityId: string; rootUrl: string; maxPages: number; requestedBy: string },
): Promise<AuditRequest | null> {
  try {
    const [row] = await db<Row[]>`
      insert into audit_requests (project_id, entity_id, root_url, max_pages, requested_by)
      values (${input.projectId}, ${input.entityId}, ${input.rootUrl}, ${input.maxPages}, ${input.requestedBy})
      returning ${db.unsafe(COLUMNS)}
    `;
    return toRequest(row);
  } catch (err) {
    if ((err as { code?: string }).code === UNIQUE_VIOLATION) return null;
    throw err;
  }
}

export async function latestAuditRequest(db: Db, projectId: string): Promise<AuditRequest | null> {
  const rows = await db<Row[]>`
    select ${db.unsafe(COLUMNS)} from audit_requests
    where project_id = ${projectId}
    order by created_at desc
    limit 1
  `;
  return rows[0] ? toRequest(rows[0]) : null;
}

/** How long a running request may go silent before it is failed and unblocks the project. */
const STALE_RUNNING_MINUTES = 120;

/**
 * Queued requests, oldest first. Also fails any request that has been running
 * longer than the stale limit: a runner that died mid-crawl must not hold the
 * project's one live slot forever.
 */
export async function listQueuedAuditRequests(db: Db, limit = 20): Promise<AuditRequest[]> {
  await db`
    update audit_requests
    set status = 'failed',
        error = ${'The runner did not report back within ' + STALE_RUNNING_MINUTES + ' minutes.'},
        finished_at = now()
    where status = 'running' and started_at < now() - make_interval(mins => ${STALE_RUNNING_MINUTES})
  `;
  const rows = await db<Row[]>`
    select ${db.unsafe(COLUMNS)} from audit_requests
    where status = 'queued'
    order by created_at
    limit ${limit}
  `;
  return rows.map(toRequest);
}

/** queued → running, only if still queued. Null means someone else got it, or it is not queued. */
export async function claimAuditRequest(db: Db, id: string): Promise<AuditRequest | null> {
  const rows = await db<Row[]>`
    update audit_requests
    set status = 'running', started_at = now()
    where id = ${id} and status = 'queued'
    returning ${db.unsafe(COLUMNS)}
  `;
  return rows[0] ? toRequest(rows[0]) : null;
}

export type AuditRequestOutcome = { auditRunId: string } | { error: string };

/** running → done | failed, only if still running. */
export async function finishAuditRequest(db: Db, id: string, outcome: AuditRequestOutcome): Promise<AuditRequest | null> {
  const done = 'auditRunId' in outcome;
  const rows = await db<Row[]>`
    update audit_requests
    set status = ${done ? 'done' : 'failed'},
        audit_run_id = ${done ? outcome.auditRunId : null},
        error = ${done ? null : outcome.error},
        finished_at = now()
    where id = ${id} and status = 'running'
    returning ${db.unsafe(COLUMNS)}
  `;
  return rows[0] ? toRequest(rows[0]) : null;
}
