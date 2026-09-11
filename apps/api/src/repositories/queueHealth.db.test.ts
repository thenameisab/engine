import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.js';
import { queueHealth } from './auditRequests.js';

/**
 * What the operator checklist's last row reads: is the crawl runner draining
 * the queue.
 *
 * Every assertion is a delta against a baseline taken first. `queueHealth`
 * counts across every project by design — a deployment fact, not a project's —
 * so a shared test database will always carry rows this test did not write, and
 * an absolute expectation would pass or fail depending on what ran before it.
 *
 * Runs only when `TEST_DATABASE_URL` points at a database migrated through 0035.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('queueHealth (Postgres)', () => {
  let db: Db;
  let accountId: string;
  const suffix = Math.random().toString(36).slice(2, 8);
  let n = 0;

  beforeAll(async () => {
    db = createDb(url!);
    const [account] = await db<{ id: string }[]>`
      insert into accounts (name) values (${'queue-' + suffix}) returning id
    `;
    accountId = account!.id;
  });

  afterAll(async () => {
    // The account cascades to its projects, their entities and every request.
    await db`delete from accounts where name = ${'queue-' + suffix}`;
    await db.end();
  });

  /**
   * One request, on a project of its own.
   *
   * `audit_requests_one_live_crawl_per_project` allows a single queued or
   * running crawl per project — the rule that stops a customer double-queueing
   * an expensive crawl. So a test that wants three live requests needs three
   * projects, not three inserts.
   */
  const queue = async (status: string, over: { createdAgoMinutes?: number; finished?: boolean } = {}) => {
    const tag = `${suffix}-${n++}`;
    const [project] = await db<{ id: string }[]>`
      insert into projects (account_id, name, domain) values (${accountId}, ${'queue ' + tag}, ${tag + '.example'}) returning id
    `;
    const [entity] = await db<{ id: string }[]>`
      insert into entities (project_id, canonical_name) values (${project!.id}, ${'Queue ' + tag}) returning id
    `;
    const ago = over.createdAgoMinutes ?? 0;
    const [row] = await db<{ id: string }[]>`
      insert into audit_requests (project_id, entity_id, root_url, requested_by, status, created_at, started_at, finished_at)
      values (
        ${project!.id}, ${entity!.id}, ${'https://' + tag + '.example/'}, ${'test-' + suffix}, ${status},
        now() - make_interval(mins => ${ago}),
        ${status === 'running' ? db`now() - make_interval(mins => ${ago})` : null},
        ${over.finished ? db`now()` : null}
      )
      returning id
    `;
    return row!.id;
  };

  it('counts queued and running apart', async () => {
    const before = await queueHealth(db);
    await queue('queued');
    await queue('queued');
    await queue('running');

    const after = await queueHealth(db);
    expect(after.queued - before.queued).toBe(2);
    expect(after.running - before.running).toBe(1);
  });

  it('ages the oldest queued request, which is what says the runner is stuck', async () => {
    await queue('queued', { createdAgoMinutes: 90 });
    const health = await queueHealth(db);
    // At least 90 minutes: another test's row could be older still, and the
    // checklist only asks whether the oldest has waited too long.
    expect(health.oldestQueuedAgeSeconds).not.toBeNull();
    expect(health.oldestQueuedAgeSeconds!).toBeGreaterThanOrEqual(90 * 60);
  });

  it('reports the last completion, so an idle queue is not read as a dead runner', async () => {
    await queue('done', { finished: true });
    const health = await queueHealth(db);
    expect(health.lastFinishedAt).not.toBeNull();
    expect(Date.now() - new Date(health.lastFinishedAt!).getTime()).toBeLessThan(60_000);
  });

  it('does not fail stale running requests as a side effect', async () => {
    // `listQueuedAuditRequests` deliberately does. A checklist that changed the
    // queue it reports would make reading the screen an action.
    const id = await queue('running', { createdAgoMinutes: 300 });
    await queueHealth(db);
    const [after] = await db<{ status: string }[]>`select status from audit_requests where id = ${id}`;
    expect(after!.status).toBe('running');
  });
});
