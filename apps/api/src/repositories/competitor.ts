import {
  runCompetitorAudit,
  type CompetitorAuditResult,
  type CompetitorFacts,
  type Gap,
  type GapType,
} from '@engine/competitor';
import { DEFAULT_ENTITY_KIND, type Entity } from '@engine/core';
import { hostOf, normalizeDomain, type SerpResult } from '@engine/connectors';
import { createEntity, getEntityInProject } from './entities.js';
import { upsertFindings } from './findings.js';
import { insertSerpPositions } from './rankPositions.js';
import { toJsonb, type Db } from '../db.js';

/**
 * A5 orchestration: manage a project's competitor set and run the deterministic
 * gap analysis of its self-entity against that set. Thin by design — every gap
 * computation lives in `@engine/competitor`, unit-tested without a database.
 * Both sides are entities in the entity-first model, so the same
 * keywords/prompts/citations/mentions columns feed both self and competitors;
 * B3 strength is joined in for the entity gap.
 */

/** Registrable domain of a mention/citation URL — the backlink-gap unit. */
function toDomain(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  const host = s.replace(/^[a-z]+:\/\//, '').split('/')[0].replace(/^www\./, '');
  const labels = host.split('.').filter(Boolean);
  return labels.length >= 2 ? labels.slice(-2).join('.') : host || null;
}

function uniqueDomains(urls: readonly string[]): string[] {
  const out = new Set<string>();
  for (const u of urls) {
    const d = toDomain(u);
    if (d) out.add(d);
  }
  return [...out];
}

/**
 * Map an entity row + its B3 strength to the facets A5 diffs on. v1.5 data
 * mapping (spec §5): keyword gap ← keywords (A1), citation gap ← prompts (A2),
 * content gap ← citations (content/sources the entity appears in — the
 * dedicated crawl-topic feed will replace this), backlink gap ← mentions
 * reduced to registrable domains (the A6 licensed-link feed will replace this).
 * Neither replacement touches the pure package or the frozen contract.
 */
function toFacts(e: Entity, strength: number | null): CompetitorFacts {
  return {
    entityId: e.id,
    canonicalName: e.canonicalName,
    keywords: e.keywords,
    prompts: e.prompts,
    topics: uniqueDomains(e.citations),
    referringDomains: uniqueDomains(e.mentions),
    entityStrength: strength,
  };
}

/** Current B3 strengths for a set of entity ids (empty map before any audit). */
async function strengthsFor(db: Db, entityIds: readonly string[]): Promise<Map<string, number>> {
  if (entityIds.length === 0) return new Map();
  const rows = await db<{ entity_id: string; score: string }[]>`
    select entity_id, score from entity_graph_audits
    where entity_id = any(${entityIds as string[]})
  `;
  return new Map(rows.map((r) => [r.entity_id, Number(r.score)]));
}

export interface CompetitorRef {
  competitorSetId: string;
  entityId: string;
  canonicalName: string;
}

/** Add a competitor entity to a project's set for a given self-entity. */
export async function addCompetitor(
  db: Db,
  projectId: string,
  selfEntityId: string,
  competitorEntityId: string,
): Promise<{ ok: true; id: string } | { ok: false; reason: 'self-not-found' | 'competitor-not-found' | 'same-entity' }> {
  if (selfEntityId === competitorEntityId) return { ok: false, reason: 'same-entity' };
  const self = await getEntityInProject(db, projectId, selfEntityId);
  if (!self) return { ok: false, reason: 'self-not-found' };
  const comp = await getEntityInProject(db, projectId, competitorEntityId);
  if (!comp) return { ok: false, reason: 'competitor-not-found' };

  const [row] = await db<{ id: string }[]>`
    insert into competitor_sets (project_id, self_entity_id, competitor_entity_id)
    values (${projectId}, ${selfEntityId}, ${competitorEntityId})
    on conflict (project_id, self_entity_id, competitor_entity_id)
      do update set project_id = excluded.project_id
    returning id
  `;
  return { ok: true, id: row.id };
}

/**
 * Add a competitor by the one thing a customer actually knows: their website.
 *
 * The screen has been unreachable since it shipped. Adding a competitor
 * required picking another *tracked entity*, and every entity a customer has
 * is one of their own brands, so there was never a second one to pick and
 * `competitor_sets` is empty in production. A domain is the seed that was
 * missing.
 *
 * An existing competitor entity for the same domain is reused rather than
 * duplicated: a customer who types the same rival twice, or types it for two
 * of their own brands, means one company both times, and two rows would split
 * its facts in half and halve every gap it holds.
 */
export async function addCompetitorByDomain(
  db: Db,
  projectId: string,
  selfEntityId: string,
  domainInput: string,
): Promise<
  | { ok: true; id: string; entityId: string; canonicalName: string; domain: string }
  | { ok: false; reason: 'self-not-found' | 'invalid-domain' | 'own-domain' }
> {
  const domain = normalizeDomain(domainInput);
  // A bare host with a dot and no whitespace. Deliberately not a full URL
  // parse: the customer types "competitor.com", not a URL, and accepting
  // something unparseable here would create an entity that can never match a
  // SERP result.
  if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return { ok: false, reason: 'invalid-domain' };

  const self = await getEntityInProject(db, projectId, selfEntityId);
  if (!self) return { ok: false, reason: 'self-not-found' };

  const project = await db<{ domain: string }[]>`select domain from projects where id::text = ${projectId}`;
  if (project[0] && normalizeDomain(project[0].domain) === domain) return { ok: false, reason: 'own-domain' };

  const existing = await db<{ id: string; canonical_name: string }[]>`
    select id, canonical_name from entities
    where project_id::text = ${projectId} and role = 'competitor' and ${`https://${domain}`} = any(urls)
    limit 1
  `;

  let entityId: string;
  let canonicalName: string;
  if (existing[0]) {
    entityId = existing[0].id;
    canonicalName = existing[0].canonical_name;
  } else {
    canonicalName = nameFromDomain(domain);
    const entity = await createEntity(db, projectId, canonicalName, DEFAULT_ENTITY_KIND, 'competitor');
    await db`update entities set urls = ${[`https://${domain}`]}, updated_at = now() where id = ${entity.id}`;
    entityId = entity.id;
  }

  const added = await addCompetitor(db, projectId, selfEntityId, entityId);
  if (!added.ok) {
    // `addCompetitor` can only fail here for reasons already ruled out above
    // (the self entity exists, the competitor was just created or read back,
    // and the two cannot be the same row because one is role 'competitor').
    return { ok: false, reason: 'self-not-found' };
  }
  return { ok: true, id: added.id, entityId, canonicalName, domain };
}

/**
 * A readable brand name from a domain: "acme-corp.co.uk" becomes "Acme Corp".
 *
 * A guess, and shown to the customer as editable text rather than hidden,
 * because a name is what they will read on every gap row and "acme-corp.co.uk"
 * is not a name.
 */
function nameFromDomain(domain: string): string {
  const label = domain.split('.')[0] ?? domain;
  return label
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ') || domain;
}

/** Remove a competitor link by id (tenancy-checked against the project). */
export async function removeCompetitor(db: Db, projectId: string, competitorSetId: string): Promise<boolean> {
  const rows = await db<{ id: string }[]>`
    delete from competitor_sets
    where id::text = ${competitorSetId} and project_id::text = ${projectId}
    returning id
  `;
  return rows.length > 0;
}

/**
 * Record where a self-entity's competitors stood in a SERP that was already
 * fetched, and remember which keywords they rank for.
 *
 * Without this, adding a competitor by domain produces nothing. The gap
 * analysis compares facts the two entities *hold* — keywords, prompts,
 * citation topics, referring domains — and a competitor created from a bare
 * domain holds none, so it can never be ahead on anything and the gap table
 * stays empty forever. The plan's "one typed domain produces gap rows the
 * next day" does not follow from the domain alone.
 *
 * The fix costs nothing. Every rank poll already buys a full SERP and throws
 * away every result that is not the customer's own; the rivals are sitting in
 * a response that has already been paid for. Reading them adds no vendor call
 * and no vendor bill.
 *
 * Competitor positions land in `serp_positions` under the competitor's own
 * entity id, which is safe only because `assembleSurfaceScores` counts
 * `role = 'self'` entities: before that filter existed, writing these rows
 * would have folded a rival's rankings into the customer's visibility score.
 */
export async function recordCompetitorStandings(
  db: Db,
  projectId: string,
  selfEntityId: string,
  results: readonly SerpResult[],
): Promise<number> {
  const rivals = await db<{ entity_id: string; urls: string[] }[]>`
    select cs.competitor_entity_id as entity_id, e.urls
    from competitor_sets cs
    join entities e on e.id = cs.competitor_entity_id
    where cs.project_id = ${projectId} and cs.self_entity_id = ${selfEntityId}
  `;
  if (rivals.length === 0) return 0;

  let recorded = 0;
  for (const rival of rivals) {
    const domain = rival.urls.map((u) => normalizeDomain(u)).find(Boolean);
    if (!domain) continue;

    await insertSerpPositions(db, rival.entity_id, results, domain);

    // A keyword the rival actually ranks for is a fact about them, and it is
    // what `runCompetitorAudit` reads. A keyword they did not rank for says
    // nothing and is not recorded.
    const ranked = results
      .filter((r) => r.organic.some((o) => {
        const host = hostOf(o.url);
        return host !== null && (host === domain || host.endsWith(`.${domain}`));
      }))
      .map((r) => r.query.keyword);

    if (ranked.length > 0) {
      await db`
        update entities
        set keywords = (
          select array_agg(distinct k) from unnest(keywords || ${ranked}::text[]) as k
        ),
        updated_at = now()
        where id = ${rival.entity_id}
      `;
      recorded += ranked.length;
    }
  }
  return recorded;
}

/** The competitor entities linked to a self-entity in a project. */
export async function listCompetitors(db: Db, projectId: string, selfEntityId: string): Promise<CompetitorRef[]> {
  const rows = await db<{ id: string; entity_id: string; canonical_name: string }[]>`
    select cs.id, cs.competitor_entity_id as entity_id, e.canonical_name
    from competitor_sets cs
    join entities e on e.id = cs.competitor_entity_id
    where cs.project_id = ${projectId} and cs.self_entity_id = ${selfEntityId}
    order by e.canonical_name asc
  `;
  return rows.map((r) => ({ competitorSetId: r.id, entityId: r.entity_id, canonicalName: r.canonical_name }));
}

export interface CompetitorAuditRunResult extends CompetitorAuditResult {
  selfEntityId: string;
  competitorsAudited: number;
}

/**
 * Run + persist a project's competitor gap analysis for one self-entity.
 * Persists the source:'content'/'entity' findings (into the same inventory
 * B1/B2/B3 write, so they propose through the existing fix flow) and the
 * ranked gap list (migration 0011). Returns null when the self-entity is not
 * in the project.
 */
export async function runProjectCompetitorAudit(
  db: Db,
  projectId: string,
  selfEntityId: string,
): Promise<CompetitorAuditRunResult | null> {
  const self = await getEntityInProject(db, projectId, selfEntityId);
  if (!self) return null;

  const competitorRefs = await listCompetitors(db, projectId, selfEntityId);
  const competitorEntities = (
    await Promise.all(competitorRefs.map((c) => getEntityInProject(db, projectId, c.entityId)))
  ).filter((e): e is Entity => e !== null);

  const strengths = await strengthsFor(db, [self.id, ...competitorEntities.map((e) => e.id)]);
  const selfFacts = toFacts(self, strengths.get(self.id) ?? null);
  const compFacts = competitorEntities.map((e) => toFacts(e, strengths.get(e.id) ?? null));

  const result = runCompetitorAudit(selfFacts, compFacts);

  if (result.findings.length > 0) await upsertFindings(db, result.findings);
  await replaceGaps(db, projectId, self.id, result.gaps);

  return { ...result, selfEntityId: self.id, competitorsAudited: compFacts.length };
}

/**
 * Replace the persisted gap list for a self-entity with the freshly computed
 * one: upsert the current gaps, then delete any stale rows a previous run left
 * that this run no longer produces (a keyword the customer has since started
 * ranking for should disappear from the table, not linger).
 */
async function replaceGaps(db: Db, projectId: string, selfEntityId: string, gaps: readonly Gap[]): Promise<void> {
  for (const g of gaps) {
    await db`
      insert into competitor_gaps
        (project_id, self_entity_id, gap_type, item, held_by_count, held_by, impact, evidence, updated_at)
      values (
        ${projectId}, ${selfEntityId}, ${g.type}, ${g.item}, ${g.heldByCount},
        ${toJsonb(db, g.heldBy)}, ${g.impact}, ${toJsonb(db, g.evidence)}, now()
      )
      on conflict (self_entity_id, gap_type, item) do update set
        held_by_count = excluded.held_by_count,
        held_by = excluded.held_by,
        impact = excluded.impact,
        evidence = excluded.evidence,
        updated_at = now()
    `;
  }
  // Prune rows this run did not (re)touch.
  await db`
    delete from competitor_gaps
    where self_entity_id = ${selfEntityId} and updated_at < now() - interval '1 second'
  `;
}

export interface GapRecord {
  type: GapType;
  item: string;
  heldByCount: number;
  heldBy: string[];
  impact: number;
  evidence: Record<string, unknown>;
  updatedAt: string;
}

/**
 * The project's persisted competitor gaps for a self-entity, biggest impact
 * first — the "biggest gaps to close" lead view (spec §8). Empty until an
 * analysis has run; an empty array is a real answer, not sample data.
 */
export async function listCompetitorGaps(db: Db, projectId: string, selfEntityId: string): Promise<GapRecord[]> {
  const rows = await db<
    {
      gap_type: string;
      item: string;
      held_by_count: number;
      held_by: string[];
      impact: string;
      evidence: Record<string, unknown>;
      updated_at: Date;
    }[]
  >`
    select gap_type, item, held_by_count, held_by, impact, evidence, updated_at
    from competitor_gaps
    where project_id = ${projectId} and self_entity_id = ${selfEntityId}
    order by impact desc, held_by_count desc, item asc
  `;
  return rows.map((r) => ({
    type: r.gap_type as GapType,
    item: r.item,
    heldByCount: r.held_by_count,
    heldBy: r.held_by,
    impact: Number(r.impact),
    evidence: r.evidence,
    updatedAt: r.updated_at.toISOString(),
  }));
}
