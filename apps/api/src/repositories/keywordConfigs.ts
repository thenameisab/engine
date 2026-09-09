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

/** A tracked keyword with the last two observations behind it. */
export interface TrackedKeyword extends KeywordConfig {
  entityName: string;
  /** The tracked domain's position at the most recent poll; null when it did not appear. */
  position: number | null;
  /** The URL that held that position, so a customer can see which page ranks. */
  url: string | null;
  /** When that poll ran; null when the keyword has never been polled. */
  polledAt: string | null;
  /** The position at the poll before it, for the change column. Null when there is no second poll. */
  previousPosition: number | null;
}

interface TrackedRow extends KeywordConfigRow {
  canonical_name: string;
  position: number | null;
  url: string | null;
  polled_at: Date | null;
  previous_position: number | null;
}

/**
 * Every keyword tracked for a project, best-ranking first, with the last two
 * observations joined on so the screen can show a position and its change
 * without a request per row.
 *
 * Two lateral joins rather than a window function because the pair wanted is
 * "the newest, and the one before it" per keyword, and `limit 1 offset 1` says
 * that directly. Keywords never polled sort last with a null position, which
 * is the honest rendering of "tracked, waiting for the first poll".
 */
export async function listTrackedKeywords(db: Db, projectId: string): Promise<TrackedKeyword[]> {
  const rows = await db<TrackedRow[]>`
    select kc.id, kc.entity_id, kc.keyword, kc.geo_country, kc.geo_city, kc.geo_postcode,
           kc.device, kc.language, kc.engine, kc.cadence, kc.created_at,
           e.canonical_name,
           cur.position, cur.url, cur.polled_at,
           prev.position as previous_position
    from keyword_configs kc
    join entities e on e.id = kc.entity_id
    join projects p on p.id = e.project_id
    left join lateral (
      select sp.position, sp.url, sp.polled_at
      from serp_positions sp
      where sp.entity_id = kc.entity_id and sp.keyword = kc.keyword
        and sp.device = kc.device and sp.engine = kc.engine
      order by sp.polled_at desc
      limit 1
    ) cur on true
    left join lateral (
      select sp.position
      from serp_positions sp
      where sp.entity_id = kc.entity_id and sp.keyword = kc.keyword
        and sp.device = kc.device and sp.engine = kc.engine
      order by sp.polled_at desc
      limit 1 offset 1
    ) prev on true
    where p.id = ${projectId}
    order by cur.position asc nulls last, kc.keyword asc
  `;
  return rows.map((row) => ({
    ...toKeywordConfig(row),
    entityName: row.canonical_name,
    position: row.position,
    url: row.url,
    polledAt: row.polled_at ? row.polled_at.toISOString() : null,
    previousPosition: row.previous_position,
  }));
}

/**
 * Stop tracking a keyword. Scoped through the project so an id from another
 * customer's account cannot be deleted by guessing it — the same reason every
 * other id-taking route re-checks tenancy rather than trusting the path.
 *
 * The `serp_positions` rows stay: they are observations that happened, and the
 * history is worth keeping if the keyword is tracked again.
 */
export async function deleteKeywordConfig(db: Db, projectId: string, keywordId: string): Promise<boolean> {
  const rows = await db<{ id: string }[]>`
    delete from keyword_configs kc
    using entities e, projects p
    where kc.id = ${keywordId}
      and e.id = kc.entity_id
      and p.id = e.project_id
      and p.id = ${projectId}
    returning kc.id
  `;
  return rows.length > 0;
}
