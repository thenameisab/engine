import { DEFAULT_ENTITY_KIND, DEFAULT_ENTITY_ROLE, type Entity, type EntityKind, type EntityRole } from '@engine/core';
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
  schema_type: string;
  role: EntityRole;
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
    schemaType: row.schema_type,
    role: row.role,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * A project's entities.
 *
 * `role` is not optional sugar. Most callers mean "the customer's own brands"
 * — every brand picker, the entity audit, the visibility rollup — and folding
 * a competitor into those produces a wrong number rather than an error.
 * Callers that genuinely mean *every* entity in the project (a tenancy check,
 * or the off-site audit's category, where a rival belongs by definition) pass
 * `'all'` and say so at the call site.
 */
export async function listEntitiesByProject(
  db: Db,
  projectId: string,
  role: EntityRole | 'all' = 'all',
): Promise<Entity[]> {
  const rows = await db<EntityRow[]>`
    select id, canonical_name, wikidata_id, urls, keywords, prompts, citations, mentions, schema, schema_type, role, created_at, updated_at
    from entities
    where project_id = ${projectId}
      ${role === 'all' ? db`` : db`and role = ${role}`}
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
    select id, canonical_name, wikidata_id, urls, keywords, prompts, citations, mentions, schema, schema_type, role, created_at, updated_at
    from entities
    where id::text = ${entityId} and project_id::text = ${projectId}
  `;
  return rows.length > 0 ? toEntity(rows[0]) : null;
}

export async function createEntity(
  db: Db,
  projectId: string,
  canonicalName: string,
  schemaType: EntityKind = DEFAULT_ENTITY_KIND,
  role: EntityRole = DEFAULT_ENTITY_ROLE,
): Promise<Entity> {
  const [row] = await db<EntityRow[]>`
    insert into entities (project_id, canonical_name, schema_type, role)
    values (${projectId}, ${canonicalName}, ${schemaType}, ${role})
    returning id, canonical_name, wikidata_id, urls, keywords, prompts, citations, mentions, schema, schema_type, role, created_at, updated_at
  `;
  return toEntity(row);
}

/**
 * Change what kind of thing a brand is. The schema generator reads this to
 * pick the `@type` of the JSON-LD it proposes, so a customer who set the kind
 * wrong (or left the default) can fix every future proposal in one place
 * rather than per fix.
 */
export async function setEntitySchemaType(
  db: Db,
  projectId: string,
  entityId: string,
  schemaType: EntityKind,
): Promise<Entity | null> {
  const rows = await db<EntityRow[]>`
    update entities
    set schema_type = ${schemaType}, updated_at = now()
    where id::text = ${entityId} and project_id::text = ${projectId}
    returning id, canonical_name, wikidata_id, urls, keywords, prompts, citations, mentions, schema, schema_type, role, created_at, updated_at
  `;
  return rows.length > 0 ? toEntity(rows[0]) : null;
}

/**
 * Replace the prompt bank a brand's AI visibility is sampled against.
 *
 * `entities.prompts` has existed since migration 0001 and no route ever wrote
 * to it, so the column was empty on every row — which is why the scheduled AI
 * poll had nothing to ask and `citation_events` stayed empty. Whole-list
 * replacement rather than add/remove routes: the editor sends the list it
 * shows, so two tabs cannot merge into a bank neither of them displayed.
 */
export async function setEntityPrompts(
  db: Db,
  projectId: string,
  entityId: string,
  prompts: readonly string[],
): Promise<Entity | null> {
  const rows = await db<EntityRow[]>`
    update entities
    set prompts = ${prompts as string[]}, updated_at = now()
    where id::text = ${entityId} and project_id::text = ${projectId}
    returning id, canonical_name, wikidata_id, urls, keywords, prompts, citations, mentions, schema, schema_type, role, created_at, updated_at
  `;
  return rows.length > 0 ? toEntity(rows[0]) : null;
}
