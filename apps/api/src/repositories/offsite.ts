import {
  runOffsiteAudit,
  type CitationObservation,
  type CitationOpportunity,
  type OffsiteAuditResult,
} from '@engine/backlink';
import { getEntityInProject, listEntitiesByProject } from './entities.js';
import { upsertFindings } from './findings.js';
import type { Db } from '../db.js';

/**
 * A6 orchestration: mine a project's A2 citation archive
 * (citation_events.sources_cited) into citation-domain intelligence +
 * opportunities for one self-entity, and persist the source:'content'
 * off-site findings (into the shared inventory) and the ranked opportunity
 * list (migration 0012). Thin by design — every computation lives in
 * `@engine/backlink`, unit-tested without a database.
 *
 * "Category" here is the project's tracked entities (self + peers): the set of
 * entities whose AI-answer citations define what domains are authoritative in
 * this customer's space. Independent of A5's competitor set, so A6 works before
 * any competitor is configured.
 */

/**
 * Default directory/review profiles worth a presence for AI/search
 * corroboration. Deliberately a small, category-agnostic seed (spec §7 names
 * G2/Capterra/JustDial); a per-project override lands with the connector work.
 */
const DEFAULT_PROFILE_DOMAINS = ['g2.com', 'capterra.com', 'trustpilot.com', 'justdial.com', 'crunchbase.com'];

interface CitationArchiveRow {
  entity_id: string;
  engine: string;
  sources_cited: string[];
  sentiment: 'positive' | 'neutral' | 'negative' | null;
}

/**
 * A2 citation observations for a set of entities within a lookback window.
 * Only rows that actually cited sources carry domain signal; sentiment is kept
 * for the negative-cluster check.
 */
async function citationObservations(db: Db, entityIds: readonly string[], sinceDays: number): Promise<CitationObservation[]> {
  if (entityIds.length === 0) return [];
  const rows = await db<CitationArchiveRow[]>`
    select entity_id, engine, sources_cited, sentiment
    from citation_events
    where entity_id = any(${entityIds as string[]})
      and sampled_at >= now() - (${sinceDays}::text || ' days')::interval
      and array_length(sources_cited, 1) is not null
  `;
  return rows.map((r) => ({
    entityId: r.entity_id,
    citedDomains: r.sources_cited,
    engine: r.engine,
    sentiment: r.sentiment,
  }));
}

export interface OffsiteAuditRunResult extends OffsiteAuditResult {
  selfEntityId: string;
  observationsAnalyzed: number;
  categorySize: number;
}

/** Run + persist a project's off-site audit for one self-entity. */
export async function runProjectOffsiteAudit(
  db: Db,
  projectId: string,
  selfEntityId: string,
  sinceDays = 90,
): Promise<OffsiteAuditRunResult | null> {
  const self = await getEntityInProject(db, projectId, selfEntityId);
  if (!self) return null;

  // Every entity, competitors included: the whole point is which domains AI
  // cites across the *category*, and a rival is part of the category.
  const category = await listEntitiesByProject(db, projectId, 'all');
  const observations = await citationObservations(db, category.map((e) => e.id), sinceDays);

  const result = runOffsiteAudit({
    selfEntityId: self.id,
    observations,
    knownProfileDomains: DEFAULT_PROFILE_DOMAINS,
    selfMentionUrls: self.mentions,
  });

  if (result.findings.length > 0) await upsertFindings(db, result.findings);
  await replaceOpportunities(db, projectId, self.id, result.opportunities);

  return { ...result, selfEntityId: self.id, observationsAnalyzed: observations.length, categorySize: category.length };
}

/** Replace the persisted opportunity list for a self-entity with the fresh one. */
async function replaceOpportunities(
  db: Db,
  projectId: string,
  selfEntityId: string,
  opportunities: readonly CitationOpportunity[],
): Promise<void> {
  for (const o of opportunities) {
    await db`
      insert into citation_opportunities
        (project_id, self_entity_id, domain, authority, citation_count, distinct_entities, impact, updated_at)
      values (${projectId}, ${selfEntityId}, ${o.domain}, ${o.authority}, ${o.citationCount}, ${o.distinctEntities}, ${o.impact}, now())
      on conflict (self_entity_id, domain) do update set
        authority = excluded.authority,
        citation_count = excluded.citation_count,
        distinct_entities = excluded.distinct_entities,
        impact = excluded.impact,
        updated_at = now()
    `;
  }
  await db`
    delete from citation_opportunities
    where self_entity_id = ${selfEntityId} and updated_at < now() - interval '1 second'
  `;
}

export interface OpportunityRecord {
  domain: string;
  authority: number;
  citationCount: number;
  distinctEntities: number;
  impact: number;
  updatedAt: string;
}

/**
 * The project's persisted citation opportunities for a self-entity, biggest
 * first — the "citation opportunities" lead view (spec §8). Empty until an
 * off-site audit has run; an empty array is a real answer, not sample data.
 */
export async function listCitationOpportunities(db: Db, projectId: string, selfEntityId: string): Promise<OpportunityRecord[]> {
  const rows = await db<
    { domain: string; authority: string; citation_count: number; distinct_entities: number; impact: string; updated_at: Date }[]
  >`
    select domain, authority, citation_count, distinct_entities, impact, updated_at
    from citation_opportunities
    where project_id = ${projectId} and self_entity_id = ${selfEntityId}
    order by impact desc, citation_count desc, domain asc
  `;
  return rows.map((r) => ({
    domain: r.domain,
    authority: Number(r.authority),
    citationCount: r.citation_count,
    distinctEntities: r.distinct_entities,
    impact: Number(r.impact),
    updatedAt: r.updated_at.toISOString(),
  }));
}
