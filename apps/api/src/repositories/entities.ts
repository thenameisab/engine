import { DEFAULT_ENTITY_KIND, DEFAULT_ENTITY_ROLE, type Entity, type EntityKind, type EntityRole } from '@engine/core';
import { toJsonb } from '../db.js';
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
 * Change a brand's name, its kind, or both.
 *
 * The kind is read by the schema generator to pick the `@type` of the JSON-LD
 * it proposes, so a customer who set it wrong (or left the default) can fix
 * every future proposal in one place rather than per fix. The name is what
 * Engine checks search engines and AI answers call the business, and setup
 * derives it from the domain — a derived name has to be correctable.
 *
 * `coalesce` rather than a built clause: an omitted field keeps the stored
 * value, so a caller sending one field cannot blank the other.
 */
export async function updateEntity(
  db: Db,
  projectId: string,
  entityId: string,
  patch: { canonicalName?: string; schemaType?: EntityKind },
): Promise<Entity | null> {
  const rows = await db<EntityRow[]>`
    update entities
    set canonical_name = coalesce(${patch.canonicalName ?? null}, canonical_name),
        schema_type = coalesce(${patch.schemaType ?? null}, schema_type),
        updated_at = now()
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

/** What one crawl observed about an entity's own site. */
export interface CrawledEntityFacts {
  entityId: string;
  /** Origins that served this entity's pages, e.g. `https://www.acme.com`. */
  siteUrls: string[];
  /** Every JSON-LD node found across those pages, deduplicated. */
  schema: object[];
}

/** Cap on stored JSON-LD nodes per entity — a large site repeats the same blocks on every page. */
const MAX_SCHEMA_BLOCKS = 200;

/**
 * Reduce a crawl's pages to one set of graph facts per entity.
 *
 * Deduplicated by serialized form, because a site's Organization block is
 * usually identical on every page and storing 200 copies of it would say
 * nothing 199 times.
 */
export function entityFactsFromPages(
  pages: readonly { entityId: string; url: string; jsonLd?: object[] }[],
): CrawledEntityFacts[] {
  const byEntity = new Map<string, { siteUrls: Set<string>; schema: Map<string, object> }>();
  for (const page of pages) {
    let facts = byEntity.get(page.entityId);
    if (!facts) {
      facts = { siteUrls: new Set(), schema: new Map() };
      byEntity.set(page.entityId, facts);
    }
    try {
      facts.siteUrls.add(new URL(page.url).origin);
    } catch {
      /* a page whose URL will not parse contributes no site URL */
    }
    for (const node of page.jsonLd ?? []) {
      if (facts.schema.size >= MAX_SCHEMA_BLOCKS) break;
      facts.schema.set(JSON.stringify(node), node);
    }
  }
  return [...byEntity].map(([entityId, f]) => ({
    entityId,
    siteUrls: [...f.siteUrls],
    schema: [...f.schema.values()],
  }));
}

/**
 * Write what a crawl observed onto the entity rows it covered.
 *
 * Both columns have existed since migration 0001 and nothing has ever written
 * either, so the B3 entity audit — whose whole contract is reading the
 * crawler-resolved on-site JSON-LD off the row — has been asserting
 * `missing-entity-schema` for every entity regardless of what its site
 * publishes, and scoring `sameAsConsistency` a free 1.0 for everyone because
 * there was nothing to compare against.
 *
 * `schema` is replaced, not merged: it is a statement about what the site
 * publishes *now*, and a block the site has removed must be able to disappear,
 * or a fixed problem could never be seen to be fixed.
 *
 * `urls` is merged: the crawl sees the entity's own site and nothing else,
 * while the column also holds profile URLs set elsewhere (a competitor added
 * by domain, anything a person entered). Replacing would silently drop them.
 *
 * The caller must already have checked these entities belong to the project;
 * `project_id` is in the predicate anyway, so a mistake writes nothing rather
 * than writing across a tenancy boundary.
 */
export async function recordCrawledEntityFacts(
  db: Db,
  projectId: string,
  facts: readonly CrawledEntityFacts[],
): Promise<number> {
  let written = 0;
  for (const f of facts) {
    const [row] = await db<{ id: string }[]>`
      update entities
      set urls = (
            select coalesce(array_agg(distinct u), '{}')
            from unnest(urls || ${f.siteUrls}::text[]) as u
          ),
          schema = ${toJsonb(db, f.schema)},
          updated_at = now()
      where id::text = ${f.entityId} and project_id::text = ${projectId}
      returning id
    `;
    if (row) written += 1;
  }
  return written;
}
