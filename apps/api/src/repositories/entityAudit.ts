import { runEntityAudit, type EntityAuditResult, type EntityGraphFacts, type EntityStrength } from '@engine/entity-audit';
import { listEntitiesByProject } from './entities.js';
import { upsertFindings } from './findings.js';
import type { Db } from '../db.js';

/**
 * B3 orchestration: read a project's entities, run the deterministic
 * entity-graph audit over the graph facts already on each row (schema,
 * mentions, citations, Wikidata mapping), persist the resulting findings
 * (source `'entity'`) and the per-entity strength, and return both. Thin by
 * design — every check lives in `@engine/entity-audit`, unit-tested without a
 * database.
 */

function toFacts(e: {
  id: string;
  canonicalName: string;
  wikidataId: string | null;
  urls: string[];
  mentions: string[];
  citations: string[];
  schema: object[];
}): EntityGraphFacts {
  return {
    id: e.id,
    canonicalName: e.canonicalName,
    wikidataId: e.wikidataId,
    urls: e.urls,
    mentions: e.mentions,
    citations: e.citations,
    schema: e.schema,
  };
}

export interface EntityAuditRunResult extends EntityAuditResult {
  entitiesAudited: number;
}

/** Run + persist a project's entity-graph audit. */
export async function runProjectEntityAudit(db: Db, projectId: string): Promise<EntityAuditRunResult> {
  const entities = await listEntitiesByProject(db, projectId);
  const result = runEntityAudit(entities.map(toFacts));

  if (result.findings.length > 0) await upsertFindings(db, result.findings);
  for (const s of result.strengths) await upsertEntityStrength(db, projectId, s);

  return { ...result, entitiesAudited: entities.length };
}

/** Upsert one entity's current strength breakdown (migration 0010). */
export async function upsertEntityStrength(db: Db, projectId: string, s: EntityStrength): Promise<void> {
  await db`
    insert into entity_graph_audits
      (entity_id, project_id, score, wikidata_score, schema_score, sameas_score, corroboration_score, corroborating_domains, updated_at)
    values (
      ${s.entityId}, ${projectId}, ${s.score}, ${s.components.wikidata}, ${s.components.schema},
      ${s.components.sameAsConsistency}, ${s.components.corroboration}, ${s.corroboratingDomains}, now()
    )
    on conflict (entity_id) do update set
      score = excluded.score,
      wikidata_score = excluded.wikidata_score,
      schema_score = excluded.schema_score,
      sameas_score = excluded.sameas_score,
      corroboration_score = excluded.corroboration_score,
      corroborating_domains = excluded.corroborating_domains,
      updated_at = now()
  `;
}

interface StrengthRow {
  entity_id: string;
  canonical_name: string;
  score: string;
  wikidata_score: string;
  schema_score: string;
  sameas_score: string;
  corroboration_score: string;
  corroborating_domains: number;
  updated_at: Date;
}

export interface EntityStrengthRecord extends EntityStrength {
  updatedAt: string;
}

/**
 * The project's persisted entity strengths, newest first, joined to the entity
 * name. Numeric columns arrive as strings from postgres.js (arbitrary
 * precision), so they're narrowed here in one place — same reason
 * `findings.ts` does it.
 */
export async function listEntityStrengths(db: Db, projectId: string): Promise<EntityStrengthRecord[]> {
  const rows = await db<StrengthRow[]>`
    select a.entity_id, e.canonical_name, a.score, a.wikidata_score, a.schema_score,
           a.sameas_score, a.corroboration_score, a.corroborating_domains, a.updated_at
    from entity_graph_audits a
    join entities e on e.id = a.entity_id
    where a.project_id = ${projectId}
    order by a.score asc
  `;
  return rows.map((r) => ({
    entityId: r.entity_id,
    canonicalName: r.canonical_name,
    score: Number(r.score),
    components: {
      wikidata: Number(r.wikidata_score),
      schema: Number(r.schema_score),
      sameAsConsistency: Number(r.sameas_score),
      corroboration: Number(r.corroboration_score),
    },
    corroboratingDomains: r.corroborating_domains,
    updatedAt: r.updated_at.toISOString(),
  }));
}
