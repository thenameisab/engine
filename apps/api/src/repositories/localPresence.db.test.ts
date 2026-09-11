import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.js';
import { hasLocalPresence } from './local.js';

/**
 * The gate behind the Visibility screen's Local tab, against a real Postgres.
 *
 * It is one query with two `exists` sub-selects, and both failure modes are
 * silent. Dropping the assignment arm hides Local for as long as the gap
 * between connecting Business Profile and the first sync lasts; dropping the
 * profile arm hides it forever from the customer who has no Google connection
 * and typed the facts in. Neither shows up as an error — only as a tab that is
 * not there — so the OR is asserted arm by arm.
 *
 * Runs only when `TEST_DATABASE_URL` points at a migrated database; CI has
 * none and skips.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('hasLocalPresence (Postgres)', () => {
  let db: Db;
  let accountId: string;
  let projectId: string;
  let entityId: string;
  let connectionId: string;

  beforeAll(async () => {
    db = createDb(url!);
    const [account] = await db<{ id: string }[]>`
      insert into accounts (name) values ('local-gate ' || gen_random_uuid()::text) returning id
    `;
    accountId = account.id;
    const [project] = await db<{ id: string }[]>`
      insert into projects (account_id, name, domain)
      values (${accountId}, 'local gate test', 'local-gate.example') returning id
    `;
    projectId = project.id;
    const [entity] = await db<{ id: string }[]>`
      insert into entities (project_id, canonical_name) values (${projectId}, 'Local Gate Co') returning id
    `;
    entityId = entity.id;
    const [connection] = await db<{ id: string }[]>`
      insert into integration_connections (account_id, provider) values (${accountId}, 'gbp') returning id
    `;
    connectionId = connection.id;
  });

  afterAll(async () => {
    await db`delete from accounts where id::text = ${accountId}`;
    await db.end();
  });

  beforeEach(async () => {
    await db`delete from local_profiles where project_id = ${projectId}`;
    await db`delete from integration_assignments where project_id = ${projectId}`;
  });

  /** A gbp assignment, which is what connecting Business Profile leaves behind. */
  async function assignGbp(): Promise<void> {
    await db`
      insert into integration_assignments
        (connection_id, provider, project_id, entity_id, resource_id, resource_label, resource_scope)
      values (${connectionId}, 'gbp', ${projectId}, ${entityId}, 'locations/1', 'Local Gate Co', 'entity')
    `;
  }

  /** Profile facts, as the form on Integrations writes them. */
  async function typeInFacts(): Promise<void> {
    await db`
      insert into local_profiles (entity_id, project_id, profile)
      values (${entityId}, ${projectId}, '{}'::jsonb)
    `;
  }

  it('is false for a project with neither a connection nor facts', async () => {
    expect(await hasLocalPresence(db, projectId)).toBe(false);
  });

  it('is true on typed-in facts alone, for the customer with no Google connection', async () => {
    await typeInFacts();
    expect(await hasLocalPresence(db, projectId)).toBe(true);
  });

  it('is true on a gbp assignment alone, before any sync has written a profile', async () => {
    await assignGbp();
    expect(await hasLocalPresence(db, projectId)).toBe(true);
  });

  it('is true with both, which is the state after a sync', async () => {
    await assignGbp();
    await typeInFacts();
    expect(await hasLocalPresence(db, projectId)).toBe(true);
  });

  it('does not read another project’s location, so one site cannot open another’s tab', async () => {
    const [other] = await db<{ id: string }[]>`
      insert into projects (account_id, name, domain)
      values (${accountId}, 'other', 'other-local-gate.example') returning id
    `;
    await typeInFacts();
    expect(await hasLocalPresence(db, other.id)).toBe(false);
    await db`delete from projects where id::text = ${other.id}`;
  });
});
