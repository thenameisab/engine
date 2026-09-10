import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Action } from '@engine/core';
import { createDb, type Db } from '../db.js';
import { createAction, listDeployedPrActions, saveActionTransition } from './actions.js';

/**
 * The work list for the scheduled PR merge check.
 *
 * Verification never read a pull request's state. A `github-pr` deploy means
 * the PR is open, so a fix could sit in the Deployed lane forever — and the
 * check that did fire at deploy time fetched a page that had not changed and
 * reported "not found on the page yet" about a fix nobody had rejected.
 *
 * The PR's number and repository come from the deploy transition's own audit
 * entry, not a column, so what this proves is that the read finds them there.
 *
 * Runs only when `TEST_DATABASE_URL` points at a database migrated through 0035.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('listDeployedPrActions (Postgres)', () => {
  let db: Db;
  let projectId: string;
  let entityId: string;
  const suffix = Math.random().toString(36).slice(2, 8);

  const PR_TARGET = { kind: 'github-pr', repo: 'acme/site', branch: 'main', path: 'index.html' } as const;

  beforeAll(async () => {
    db = createDb(url!);
    const [account] = await db<{ id: string }[]>`
      insert into accounts (name) values (${'pr-' + suffix}) returning id
    `;
    const [project] = await db<{ id: string }[]>`
      insert into projects (account_id, name, domain) values (${account!.id}, 'pr', ${suffix + '.example'}) returning id
    `;
    projectId = project!.id;
    const [entity] = await db<{ id: string }[]>`
      insert into entities (project_id, canonical_name) values (${projectId}, ${'PR ' + suffix}) returning id
    `;
    entityId = entity!.id;
  });

  afterAll(async () => {
    await db`delete from accounts where name = ${'pr-' + suffix}`;
    await db.end();
  });

  const finding = async () => {
    const [row] = await db<{ id: string }[]>`
      insert into findings (entity_id, source, severity, predicted_impact, evidence, fingerprint, issue_type)
      values (${entityId}, 'technical', 0.8, 3, ${db.json({ url: `https://${suffix}.example/` })},
              ${'fp-' + suffix + '-' + Math.random().toString(36).slice(2, 8)}, 'missing-title')
      returning id
    `;
    return row!.id;
  };

  /** An action in `status`, with `auditLog` as given. */
  const action = async (
    status: Action['status'],
    auditLog: Action['auditLog'],
    target: Action['target'] = PR_TARGET,
  ) => {
    const created = await createAction(db, {
      id: '',
      findingId: await finding(),
      type: 'meta',
      target,
      diff: { before: 'a', after: 'b', format: 'text', field: 'title' },
      status: 'proposed',
      auditLog: [],
    });
    return saveActionTransition(db, { ...created, status, auditLog });
  };

  const entry = (detail: object) => ({ timestamp: new Date().toISOString(), actor: 'test', event: 'deployed', detail });
  const ids = async () => (await listDeployedPrActions(db)).map((p) => p.actionId);

  it('finds a deployed PR fix with the repo and number from its audit log', async () => {
    const deployed = await action('deployed', [entry({ prUrl: 'https://github.com/acme/site/pull/7', prNumber: 7 })]);
    const found = (await listDeployedPrActions(db)).find((p) => p.actionId === deployed.id);
    expect(found).toEqual({ actionId: deployed.id, projectId, repo: 'acme/site', prNumber: 7 });
  });

  it('ignores a fix that is not deployed, and one that already verified', async () => {
    const proposed = await action('proposed', []);
    const verified = await action('verified', [entry({ prNumber: 9 })]);
    const found = await ids();
    expect(found).not.toContain(proposed.id);
    expect(found).not.toContain(verified.id);
  });

  it('ignores a deployed fix on a target that is not a PR', async () => {
    // An edge-worker deploy changed the page already; it was verified at deploy
    // time and has no pull request to look up.
    const edge = await action('deployed', [entry({})], { kind: 'edge-worker', workerName: 'acme-edge' });
    expect(await ids()).not.toContain(edge.id);
  });

  it('skips a deployed PR fix whose audit log records no number', async () => {
    // It predates the export recording one. There is nothing to look up, and
    // guessing a number would check a stranger's pull request.
    const old = await action('deployed', [entry({ prUrl: 'https://github.com/acme/site/pull/3' })]);
    expect(await ids()).not.toContain(old.id);
  });

  it('takes the newest number when a retried deploy opened a second PR', async () => {
    const retried = await action('deployed', [entry({ prNumber: 11 }), entry({ prNumber: 12 })]);
    const found = (await listDeployedPrActions(db)).find((p) => p.actionId === retried.id);
    expect(found?.prNumber).toBe(12);
  });
});
