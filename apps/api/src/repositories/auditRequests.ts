/**
 * Audit requests — the queue between "Run audit" and the crawl runner.
 *
 * Status moves queued → running → done | failed, and only forward. The claim
 * and finish updates are conditional on the current status, so two runners
 * cannot take one request and a late "finish" cannot overwrite a newer state.
 */
import type { Db } from '../db.js';

export type AuditRequestStatus = 'queued' | 'running' | 'done' | 'failed';

export type AuditRequestKind = 'crawl' | 'verify';

export interface AuditRequest {
  id: string;
  projectId: string;
  kind: AuditRequestKind;
  /** The action being checked. Null for a crawl. */
  actionId: string | null;
  /**
   * The outcome of a verify request: true when the deployed page carried the
   * change, false when it did not. Null while queued, and null forever on a
   * crawl — "we have not looked" and "we looked and it is not there" are
   * different things to tell a customer.
   */
  verified: boolean | null;
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
  kind: AuditRequestKind;
  action_id: string | null;
  verified: boolean | null;
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

const COLUMNS = `id, project_id, kind, action_id, verified, entity_id, root_url, max_pages, status,
  requested_by, error, audit_run_id, created_at, started_at, finished_at`;

function toRequest(row: Row): AuditRequest {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    actionId: row.action_id,
    verified: row.verified,
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

/**
 * Queue a check that a deployed fix is actually on the live page.
 *
 * Returns null when one is already queued or running for this action — a
 * customer pressing "Check now" three times gets one check, not three.
 */
export async function createVerifyRequest(
  db: Db,
  input: { projectId: string; entityId: string; actionId: string; url: string; requestedBy: string },
): Promise<AuditRequest | null> {
  try {
    const [row] = await db<Row[]>`
      insert into audit_requests (project_id, kind, action_id, entity_id, root_url, max_pages, requested_by)
      values (${input.projectId}, 'verify', ${input.actionId}, ${input.entityId}, ${input.url}, 1, ${input.requestedBy})
      returning ${db.unsafe(COLUMNS)}
    `;
    return toRequest(row);
  } catch (err) {
    if ((err as { code?: string }).code === UNIQUE_VIOLATION) return null;
    throw err;
  }
}

/** One request by id — the runner's result call needs to read what it is finishing. */
export async function getAuditRequest(db: Db, id: string): Promise<AuditRequest | null> {
  const rows = await db<Row[]>`select ${db.unsafe(COLUMNS)} from audit_requests where id::text = ${id}`;
  return rows[0] ? toRequest(rows[0]) : null;
}

/** The newest verify request for one action, or null if it has never been checked. */
export async function latestVerifyRequest(db: Db, actionId: string): Promise<AuditRequest | null> {
  const rows = await db<Row[]>`
    select ${db.unsafe(COLUMNS)} from audit_requests
    where action_id::text = ${actionId} and kind = 'verify'
    order by created_at desc
    limit 1
  `;
  return rows[0] ? toRequest(rows[0]) : null;
}

/** Record what a verify pass found, and close the request. */
export async function finishVerifyRequest(db: Db, id: string, verified: boolean, error?: string): Promise<AuditRequest | null> {
  const rows = await db<Row[]>`
    update audit_requests
    set status = 'done', verified = ${verified}, error = ${error ?? null}, finished_at = now()
    where id::text = ${id} and kind = 'verify' and status = 'running'
    returning ${db.unsafe(COLUMNS)}
  `;
  return rows[0] ? toRequest(rows[0]) : null;
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

/**
 * Whether the crawl runner is alive and keeping up, for the operator checklist.
 *
 * An operator's real question is not "is a queue table present" but "is work
 * moving". Depth alone cannot answer it: an empty queue means either healthy or
 * nothing has ever been asked for, and a deep queue is fine ten seconds after a
 * batch and broken an hour later. So this returns the depth, how long the oldest
 * queued item has waited, and when a request last finished — the three facts a
 * stuck runner shows up in.
 *
 * Read-only, unlike `listQueuedAuditRequests`, which also fails stale running
 * requests as a side effect. The checklist must not change the queue it reports.
 */
export interface QueueHealth {
  queued: number;
  running: number;
  /** Seconds the oldest queued request has waited, or null when nothing is queued. */
  oldestQueuedAgeSeconds: number | null;
  /** When a request last reached done or failed, or null if none ever has. */
  lastFinishedAt: string | null;
}

export async function queueHealth(db: Db): Promise<QueueHealth> {
  const [row] = await db<
    { queued: string; running: string; oldest_age: number | null; last_finished: Date | null }[]
  >`
    select
      count(*) filter (where status = 'queued') as queued,
      count(*) filter (where status = 'running') as running,
      extract(epoch from (now() - min(created_at) filter (where status = 'queued'))) as oldest_age,
      max(finished_at) as last_finished
    from audit_requests
  `;
  return {
    // `count` comes back as a bigint, which postgres.js hands over as a string
    // to avoid a silent precision loss. A queue depth fits in a number.
    queued: Number(row!.queued),
    running: Number(row!.running),
    oldestQueuedAgeSeconds: row!.oldest_age === null ? null : Math.round(row!.oldest_age),
    lastFinishedAt: row!.last_finished?.toISOString() ?? null,
  };
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
