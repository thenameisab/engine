import type { Entity } from '@engine/core';
import type { Db } from '../db.js';

interface EntityRow {
  id: string;
  canonical_name: string;
  wikidata_id: string | null;
  urls: string[];
  keywords: string[];
  prompts: string[];
  citations: string[];
  mentions: string[];
  schema: object[];
  created_at: Date;
  updated_at: Date;
}

function toEntity(row: EntityRow): Entity {
  return {
    id: row.id,
    canonicalName: row.canonical_name,
    wikidataId: row.wikidata_id,
    urls: row.urls,
    keywords: row.keywords,
    prompts: row.prompts,
    citations: row.citations,
    mentions: row.mentions,
    schema: row.schema,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function listEntitiesByProject(db: Db, projectId: string): Promise<Entity[]> {
  const rows = await db<EntityRow[]>`
    select id, canonical_name, wikidata_id, urls, keywords, prompts, citations, mentions, schema, created_at, updated_at
    from entities
    where project_id = ${projectId}
    order by created_at desc
  `;
  return rows.map(toEntity);
}

/**
 * One entity, tenancy-checked against its project in the same query — the
 * `entities.project_id` comparison the Copilot summary route needs before it
 * spends a second query on data that isn't the caller's to see.
 */
export async function getEntityInProject(db: Db, projectId: string, entityId: string): Promise<Entity | null> {
  const rows = await db<EntityRow[]>`
    select id, canonical_name, wikidata_id, urls, keywords, prompts, citations, mentions, schema, created_at, updated_at
    from entities
    where id::text = ${entityId} and project_id::text = ${projectId}
  `;
  return rows.length > 0 ? toEntity(rows[0]) : null;
}

export async function createEntity(
  db: Db,
  projectId: string,
  canonicalName: string,
): Promise<Entity> {
  const [row] = await db<EntityRow[]>`
    insert into entities (project_id, canonical_name)
    values (${projectId}, ${canonicalName})
    returning id, canonical_name, wikidata_id, urls, keywords, prompts, citations, mentions, schema, created_at, updated_at
  `;
  return toEntity(row);
}
