import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Finding } from '@engine/core';
import { createDb, type Db } from '../db.js';
import {
  upsertFindings,
  resolveFindingsAbsentFrom,
  listFindingsByProject,
  listFindingsByEntity,
  getFindingInProject,
} from './findings.js';

/**
 * Retraction, which is entirely SQL: whether the scoping predicates hold, and
 * whether a recurrence reopens the row it already had. A stubbed `db` proves
 * none of it.
 *
 * Runs only when `TEST_DATABASE_URL` points at a migrated database.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('finding resolution (Postgres)', () => {
  let db: Db;
  let accountId: string;

  /**
   * A fresh project per test, not just a fresh entity.
   *
   * Retraction is scoped by project, page and source — deliberately, since a
   * run covers a project — so a finding one test leaves open on purpose is a
   * finding the next test's retraction would legitimately close. Sharing a
   * project made the returned counts depend on test order, which is a property
   * of the tests and not of the code.
   */
  async function scope(): Promise<{ projectId: string; entityId: string }> {
    const [project] = await db<{ id: string }[]>`
      insert into projects (account_id, name, domain)
      values (${accountId}, 'res', 'acme.com') returning id
    `;
    const [entity] = await db<{ id: string }[]>`
      insert into entities (project_id, canonical_name)
      values (${project!.id}, 'Acme ' || gen_random_uuid()::text) returning id
    `;
    return { projectId: project!.id, entityId: entity!.id };
  }

  const finding = (entityId: string, over: Partial<Finding> = {}): Finding =>
    ({
      id: 'fnd_default',
      entityId,
      source: 'technical',
      issueType: 'schema-missing',
      severity: 0.7,
      predictedImpact: 10,
      evidence: { url: 'https://acme.com/' },
      actionTemplates: [],
      createdAt: new Date().toISOString(),
      ...over,
    }) as Finding;

  beforeAll(async () => {
    db = createDb(url!);
    const [account] = await db<{ id: string }[]>`
      insert into accounts (name) values ('resolution-test ' || gen_random_uuid()::text) returning id
    `;
    accountId = account!.id;
  });

  afterAll(async () => {
    await db?.end();
  });

  it('retracts a finding the new run no longer reports, and keeps the row', async () => {
    const { projectId, entityId } = await scope();
    const [stored] = await upsertFindings(db, [finding(entityId, { id: 'fnd_gone' })]);
    expect((await listFindingsByProject(db, projectId)).map((f) => f.id)).toContain(stored!.id);

    const resolved = await resolveFindingsAbsentFrom(db, projectId, {
      urls: ['https://acme.com/'],
      sources: ['technical'],
      seenFingerprints: [],
    });
    expect(resolved).toBe(1);

    // Gone from the inventory...
    expect((await listFindingsByProject(db, projectId)).map((f) => f.id)).not.toContain(stored!.id);
    // ...but still a row, with a timestamp, and still reachable by id — which
    // is what the verify path needs to check a fix that has been deployed.
    const [row] = await db<{ resolved_at: Date | null }[]>`
      select resolved_at from findings where id = ${stored!.id}
    `;
    expect(row!.resolved_at).toBeInstanceOf(Date);
    expect(await getFindingInProject(db, stored!.id, projectId)).not.toBeNull();
  });

  it('leaves a finding the run did report open', async () => {
    const { projectId, entityId } = await scope();
    const [stored] = await upsertFindings(db, [finding(entityId, { id: 'fnd_still_true' })]);
    const resolved = await resolveFindingsAbsentFrom(db, projectId, {
      urls: ['https://acme.com/'],
      sources: ['technical'],
      seenFingerprints: ['fnd_still_true'],
    });
    expect(resolved).toBe(0);
    expect((await listFindingsByProject(db, projectId)).map((f) => f.id)).toContain(stored!.id);
  });

  it('says nothing about a page the run never looked at', async () => {
    // The maxPages case, and the reason resolution is scoped by URL rather
    // than by project: tartanhq.com stops at the 50-page limit today, so a
    // project-wide retraction would clear every finding on the pages the crawl
    // never reached.
    const { projectId, entityId } = await scope();
    const [stored] = await upsertFindings(db, [
      finding(entityId, { id: 'fnd_uncrawled', evidence: { url: 'https://acme.com/page-51' } }),
    ]);
    const resolved = await resolveFindingsAbsentFrom(db, projectId, {
      urls: ['https://acme.com/'],
      sources: ['technical'],
      seenFingerprints: [],
    });
    expect(resolved).toBe(0);
    expect((await listFindingsByProject(db, projectId)).map((f) => f.id)).toContain(stored!.id);
  });

  it('says nothing about a source the run did not evaluate', async () => {
    // `POST /audit` runs B1 technical and B2 content. It does not run the B3
    // entity audit, so an entity finding on a page it crawled is not evidence
    // of anything it measured. This is the guard that stops a page audit
    // clearing `missing-entity-schema`.
    const { projectId, entityId } = await scope();
    const [stored] = await upsertFindings(db, [
      finding(entityId, { id: 'fnd_entity', source: 'entity', issueType: 'missing-entity-schema' }),
    ]);
    const resolved = await resolveFindingsAbsentFrom(db, projectId, {
      urls: ['https://acme.com/'],
      sources: ['technical', 'content'],
      seenFingerprints: [],
    });
    expect(resolved).toBe(0);
    expect((await listFindingsByEntity(db, entityId)).map((f) => f.id)).toContain(stored!.id);
  });

  it('reopens the same row when the problem comes back', async () => {
    const { projectId, entityId } = await scope();
    const [first] = await upsertFindings(db, [finding(entityId, { id: 'fnd_recurs' })]);
    await resolveFindingsAbsentFrom(db, projectId, {
      urls: ['https://acme.com/'],
      sources: ['technical'],
      seenFingerprints: [],
    });
    expect((await listFindingsByProject(db, projectId)).map((f) => f.id)).not.toContain(first!.id);

    const [again] = await upsertFindings(db, [finding(entityId, { id: 'fnd_recurs' })]);
    // The same database row, not a second one: `created_at` keeps meaning
    // "first seen" and any actions attached to it stay attached.
    expect(again!.id).toBe(first!.id);
    expect(again!.createdAt).toBe(first!.createdAt);
    expect((await listFindingsByProject(db, projectId)).map((f) => f.id)).toContain(first!.id);
  });

  it('retracts nothing when the run examined no pages', async () => {
    // A caller that posts an empty page list has looked at nothing. Without
    // this guard `= any('{}')` would still be evaluated, and an empty
    // `seenFingerprints` reads as "the run reported nothing" — the two
    // together would retract the whole project.
    const { projectId, entityId } = await scope();
    const [stored] = await upsertFindings(db, [finding(entityId, { id: 'fnd_no_pages' })]);
    expect(
      await resolveFindingsAbsentFrom(db, projectId, { urls: [], sources: ['technical'], seenFingerprints: [] }),
    ).toBe(0);
    expect((await listFindingsByProject(db, projectId)).map((f) => f.id)).toContain(stored!.id);
  });
});
