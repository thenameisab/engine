import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.js';
import { addCompetitorByDomain, listCompetitors, recordCompetitorStandings } from './competitor.js';
import { listEntitiesByProject } from './entities.js';
import type { SerpResult } from '@engine/connectors';

/**
 * Adding a competitor by domain, and the standings harvest that gives one any
 * facts at all.
 *
 * Both are database-shaped. Whether a second "acme.com" reuses the first
 * entity, whether the role filter keeps a rival out of the customer's own
 * brand list, and whether the keyword union writes duplicates are all decided
 * by SQL, and a stubbed `db` proves none of them.
 *
 * Runs only when `TEST_DATABASE_URL` points at a migrated database.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('competitors by domain (Postgres)', () => {
  let db: Db;
  let accountId: string;
  let projectId: string;
  let selfEntityId: string;

  beforeAll(async () => {
    db = createDb(url!);
    const [account] = await db<{ id: string }[]>`
      insert into accounts (name) values ('comp-test ' || gen_random_uuid()::text) returning id
    `;
    accountId = account.id;
    const [project] = await db<{ id: string }[]>`
      insert into projects (account_id, name, domain)
      values (${accountId}, 'comp test', 'ourbrand.example') returning id
    `;
    projectId = project.id;
  });

  afterAll(async () => {
    await db`delete from accounts where id::text = ${accountId}`;
    await db.end();
  });

  beforeEach(async () => {
    await db`delete from entities where project_id = ${projectId}`;
    const [entity] = await db<{ id: string }[]>`
      insert into entities (project_id, canonical_name) values (${projectId}, 'Our Brand') returning id
    `;
    selfEntityId = entity.id;
  });

  it('creates the competitor entity, names it from the domain and links it', async () => {
    const res = await addCompetitorByDomain(db, projectId, selfEntityId, 'https://www.Acme-Corp.com/pricing');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.domain).toBe('acme-corp.com');
    expect(res.canonicalName).toBe('Acme Corp');

    const linked = await listCompetitors(db, projectId, selfEntityId);
    expect(linked.map((c) => c.canonicalName)).toEqual(['Acme Corp']);
  });

  it('reuses the entity when the same rival is named twice', async () => {
    // Two rows for one company would split its facts in half and halve every
    // gap it holds.
    const first = await addCompetitorByDomain(db, projectId, selfEntityId, 'acme.com');
    const second = await addCompetitorByDomain(db, projectId, selfEntityId, 'www.acme.com/');
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.entityId).toBe(first.entityId);

    const rivals = await listEntitiesByProject(db, projectId, 'competitor');
    expect(rivals).toHaveLength(1);
  });

  it('keeps competitors out of the customer’s own brand list', async () => {
    // The reason the role column exists: the visibility rollup sums every
    // entity it is given, so a rival here is a wrong number, not an error.
    await addCompetitorByDomain(db, projectId, selfEntityId, 'acme.com');
    const own = await listEntitiesByProject(db, projectId, 'self');
    expect(own.map((e) => e.canonicalName)).toEqual(['Our Brand']);
    expect(await listEntitiesByProject(db, projectId, 'all')).toHaveLength(2);
  });

  it('refuses the site’s own address and an unparseable one', async () => {
    expect(await addCompetitorByDomain(db, projectId, selfEntityId, 'https://ourbrand.example')).toEqual({
      ok: false,
      reason: 'own-domain',
    });
    expect(await addCompetitorByDomain(db, projectId, selfEntityId, 'not a domain')).toEqual({
      ok: false,
      reason: 'invalid-domain',
    });
  });

  /** One SERP where `acme.com` holds position 2 and we do not appear. */
  function serpResult(keyword: string, competitorRanks: boolean): SerpResult {
    return {
      query: { keyword, geo: { country: 'IN' }, device: 'desktop', language: 'en', engine: 'google' },
      organic: [
        { position: 1, url: 'https://someoneelse.example/a', title: 'a', snippet: '' },
        ...(competitorRanks ? [{ position: 2, url: 'https://acme.com/x', title: 'b', snippet: '' }] : []),
      ],
      features: [],
      rawSnapshotRef: 'ref',
      polledAt: new Date().toISOString(),
    } as SerpResult;
  }

  it('records where a rival stood in a SERP already paid for, and what it ranks for', async () => {
    const added = await addCompetitorByDomain(db, projectId, selfEntityId, 'acme.com');
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    await recordCompetitorStandings(db, projectId, selfEntityId, [
      serpResult('payslip ocr', true),
      serpResult('a keyword they do not hold', false),
    ]);

    const positions = await db<{ keyword: string; position: number | null }[]>`
      select keyword, position from serp_positions where entity_id = ${added.entityId} order by keyword
    `;
    expect(positions).toHaveLength(2);
    expect(positions.find((p) => p.keyword === 'payslip ocr')?.position).toBe(2);
    expect(positions.find((p) => p.keyword !== 'payslip ocr')?.position).toBeNull();

    // Only the keyword they actually rank for becomes a fact about them: a
    // keyword they missed says nothing, and the gap analysis reads this list.
    const [rival] = await db<{ keywords: string[] }[]>`select keywords from entities where id = ${added.entityId}`;
    expect(rival.keywords).toEqual(['payslip ocr']);
  });

  it('does not duplicate a keyword the rival already held', async () => {
    const added = await addCompetitorByDomain(db, projectId, selfEntityId, 'acme.com');
    if (!added.ok) return;
    await recordCompetitorStandings(db, projectId, selfEntityId, [serpResult('payslip ocr', true)]);
    await recordCompetitorStandings(db, projectId, selfEntityId, [serpResult('payslip ocr', true)]);
    const [rival] = await db<{ keywords: string[] }[]>`select keywords from entities where id = ${added.entityId}`;
    expect(rival.keywords).toEqual(['payslip ocr']);
  });
});
