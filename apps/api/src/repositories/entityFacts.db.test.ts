import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.js';
import { entityFactsFromPages, recordCrawledEntityFacts, listEntitiesByProject } from './entities.js';

/**
 * What a crawl writes back onto the entity it covered.
 *
 * `entities.schema` and `entities.urls` have existed since migration 0001 and
 * nothing ever wrote either, so the B3 entity audit read an empty column and
 * reported "no on-site schema" for every entity whatever its site published.
 */
describe('entityFactsFromPages', () => {
  const page = (over: Partial<{ entityId: string; url: string; jsonLd: object[] }> = {}) => ({
    entityId: 'e1',
    url: 'https://www.acme.com/pricing',
    ...over,
  });

  it('reduces a crawl to one set of facts per entity', () => {
    const facts = entityFactsFromPages([
      page({ jsonLd: [{ '@type': 'Organization', name: 'Acme' }] }),
      page({ url: 'https://www.acme.com/about', jsonLd: [{ '@type': 'WebSite', name: 'Acme' }] }),
      page({ entityId: 'e2', url: 'https://rival.example/', jsonLd: [{ '@type': 'Organization', name: 'Rival' }] }),
    ]);

    expect(facts).toHaveLength(2);
    const acme = facts.find((f) => f.entityId === 'e1')!;
    expect(acme.siteUrls).toEqual(['https://www.acme.com']);
    expect(acme.schema).toHaveLength(2);
  });

  it('stores one copy of a block a site repeats on every page', () => {
    // A site's Organization block is usually identical site-wide. Storing 200
    // copies of it would say nothing 199 times.
    const block = { '@type': 'Organization', name: 'Acme', url: 'https://acme.com' };
    const facts = entityFactsFromPages([
      page({ url: 'https://www.acme.com/a', jsonLd: [block] }),
      page({ url: 'https://www.acme.com/b', jsonLd: [block] }),
      page({ url: 'https://www.acme.com/c', jsonLd: [block] }),
    ]);
    expect(facts[0]!.schema).toEqual([block]);
  });

  it('records every origin that served the entity, not just the seed', () => {
    const facts = entityFactsFromPages([
      page({ url: 'https://www.acme.com/' }),
      page({ url: 'https://docs.acme.com/start' }),
    ]);
    expect(facts[0]!.siteUrls.sort()).toEqual(['https://docs.acme.com', 'https://www.acme.com']);
  });

  it('reports an entity whose pages publish no JSON-LD at all', () => {
    // The real state of the one customer site in production: 25 pages, zero
    // blocks. An empty array is the finding; it must not become "not measured".
    const facts = entityFactsFromPages([page(), page({ url: 'https://www.acme.com/x' })]);
    expect(facts[0]!.schema).toEqual([]);
    expect(facts[0]!.siteUrls).toEqual(['https://www.acme.com']);
  });
});

/**
 * The write itself, which is SQL: whether `urls` merges rather than replaces,
 * whether `schema` replaces rather than merges, and whether the project
 * predicate holds. A stubbed `db` proves none of those.
 *
 * Runs only when `TEST_DATABASE_URL` points at a migrated database.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('recordCrawledEntityFacts (Postgres)', () => {
  let db: Db;
  let projectId: string;
  let otherProjectId: string;
  let entityId: string;

  beforeAll(async () => {
    db = createDb(url!);
    const [account] = await db<{ id: string }[]>`
      insert into accounts (name) values ('facts-test ' || gen_random_uuid()::text) returning id
    `;
    const [project] = await db<{ id: string }[]>`
      insert into projects (account_id, name, domain) values (${account!.id}, 'facts', 'acme.com') returning id
    `;
    const [other] = await db<{ id: string }[]>`
      insert into projects (account_id, name, domain) values (${account!.id}, 'other', 'other.com') returning id
    `;
    projectId = project!.id;
    otherProjectId = other!.id;
    const [entity] = await db<{ id: string }[]>`
      insert into entities (project_id, canonical_name, urls)
      values (${projectId}, 'Acme Corp', ${['https://twitter.com/acme']}) returning id
    `;
    entityId = entity!.id;
  });

  afterAll(async () => {
    await db?.end();
  });

  it('merges site URLs into what the row already had, and replaces the schema', async () => {
    const block = { '@context': 'https://schema.org', '@type': 'Organization', name: 'Acme Corp' };
    const written = await recordCrawledEntityFacts(db, projectId, [
      { entityId, siteUrls: ['https://www.acme.com'], schema: [block] },
    ]);
    expect(written).toBe(1);

    const [entity] = await listEntitiesByProject(db, projectId);
    // The profile URL set before the crawl survives it — the crawl sees the
    // entity's own site and nothing else, so replacing would drop the rest.
    expect(entity!.urls.sort()).toEqual(['https://twitter.com/acme', 'https://www.acme.com']);
    expect(entity!.schema).toEqual([block]);
  });

  it('lets a block the site has removed disappear', async () => {
    // `schema` is a statement about what the site publishes now. If a removed
    // block lingered, a fixed problem could never be seen to be fixed.
    await recordCrawledEntityFacts(db, projectId, [{ entityId, siteUrls: [], schema: [] }]);
    const [entity] = await listEntitiesByProject(db, projectId);
    expect(entity!.schema).toEqual([]);
    // The URLs are still there: only the schema is a full restatement.
    expect(entity!.urls).toContain('https://www.acme.com');
  });

  it('does not add the same site URL twice across re-crawls', async () => {
    await recordCrawledEntityFacts(db, projectId, [{ entityId, siteUrls: ['https://www.acme.com'], schema: [] }]);
    await recordCrawledEntityFacts(db, projectId, [{ entityId, siteUrls: ['https://www.acme.com'], schema: [] }]);
    const [entity] = await listEntitiesByProject(db, projectId);
    expect(entity!.urls.filter((u) => u === 'https://www.acme.com')).toHaveLength(1);
  });

  it('writes nothing for an entity that is not this project\'s', async () => {
    const written = await recordCrawledEntityFacts(db, otherProjectId, [
      { entityId, siteUrls: ['https://stolen.example'], schema: [] },
    ]);
    expect(written).toBe(0);
    const [entity] = await listEntitiesByProject(db, projectId);
    expect(entity!.urls).not.toContain('https://stolen.example');
  });
});
