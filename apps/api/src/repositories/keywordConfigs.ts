import type { Db } from '../db.js';

/** A tracked {keyword, geo, device, language} tuple (A1.1-A1.3, migration 0001). */
export interface KeywordConfig {
  id: string;
  entityId: string;
  keyword: string;
  geo: { country: string; city: string | null; postcode: string | null };
  device: 'desktop' | 'mobile' | 'tablet';
  language: string;
  engine: 'google' | 'bing';
  cadence: 'weekly' | 'daily' | 'on_demand';
  createdAt: string;
}

interface KeywordConfigRow {
  id: string;
  entity_id: string;
  keyword: string;
  geo_country: string;
  geo_city: string | null;
  geo_postcode: string | null;
  device: KeywordConfig['device'];
  language: string;
  engine: KeywordConfig['engine'];
  cadence: KeywordConfig['cadence'];
  created_at: Date;
}

function toKeywordConfig(row: KeywordConfigRow): KeywordConfig {
  return {
    id: row.id,
    entityId: row.entity_id,
    keyword: row.keyword,
    geo: { country: row.geo_country, city: row.geo_city, postcode: row.geo_postcode },
    device: row.device,
    language: row.language,
    engine: row.engine,
    cadence: row.cadence,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * A4's "one-click push into A1 tracking" (spec §4.8): before this, nothing
 * created a `keyword_configs` row at all — `apps/api/src/repositories/billing.ts`
 * already counts them for the plan's tracked-keyword limit, but no route ever
 * inserted one, so that count was permanently zero.
 */
export async function createKeywordConfig(
  db: Db,
  entityId: string,
  input: {
    keyword: string;
    geoCountry: string;
    geoCity?: string;
    geoPostcode?: string;
    device: KeywordConfig['device'];
    language: string;
    engine: KeywordConfig['engine'];
    cadence?: KeywordConfig['cadence'];
  },
): Promise<KeywordConfig> {
  const [row] = await db<KeywordConfigRow[]>`
    insert into keyword_configs (entity_id, keyword, geo_country, geo_city, geo_postcode, device, language, engine, cadence)
    values (
      ${entityId}, ${input.keyword}, ${input.geoCountry}, ${input.geoCity ?? null}, ${input.geoPostcode ?? null},
      ${input.device}, ${input.language}, ${input.engine}, ${input.cadence ?? 'weekly'}
    )
    returning id, entity_id, keyword, geo_country, geo_city, geo_postcode, device, language, engine, cadence, created_at
  `;
  return toKeywordConfig(row);
}

export async function listKeywordConfigsByEntity(db: Db, entityId: string): Promise<KeywordConfig[]> {
  const rows = await db<KeywordConfigRow[]>`
    select id, entity_id, keyword, geo_country, geo_city, geo_postcode, device, language, engine, cadence, created_at
    from keyword_configs
    where entity_id = ${entityId}
    order by created_at desc
  `;
  return rows.map(toKeywordConfig);
}
