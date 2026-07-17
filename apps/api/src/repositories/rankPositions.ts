import type { SerpResult } from '@engine/connectors';
import type { Db } from '../db.js';

/**
 * Persist A1 rank-poll results (migration 0005). Before this, `POST
 * /rank/poll` fetched live SERP data and returned it without storing
 * anything — M1.1's "ingestion -> warehouse" half never happened.
 *
 * `position` is the best (lowest) organic rank the connector returned, or
 * null if the domain didn't appear in the tracked result depth — matching
 * how `organicSov`/`ctrForPosition` in @engine/scoring already treat "not
 * ranking." One row per polled query, not per organic result: the row is a
 * poll observation, not a SERP snapshot (the full organic list stays in the
 * raw lake via `rawSnapshotRef`).
 */
export async function insertSerpPositions(
  db: Db,
  entityId: string,
  results: readonly SerpResult[],
): Promise<void> {
  for (const r of results) {
    const best = r.organic.length > 0 ? r.organic.reduce((a, b) => (b.position < a.position ? b : a)) : null;
    await db`
      insert into serp_positions
        (entity_id, keyword, geo_country, geo_city, geo_postcode, device, language, engine,
         position, url, features, raw_snapshot_ref, polled_at)
      values (
        ${entityId}, ${r.query.keyword}, ${r.query.geo.country}, ${r.query.geo.city ?? null},
        ${r.query.geo.postcode ?? null}, ${r.query.device}, ${r.query.language}, ${r.query.engine},
        ${best?.position ?? null}, ${best?.url ?? null}, ${r.features}, ${r.rawSnapshotRef}, ${r.polledAt}
      )
    `;
  }
}

/** One tracked keyword's most recent observed position, for the A3 organic rollup. */
export interface LatestPositionRow {
  keyword: string;
  position: number | null;
  volume: number | null;
}

/**
 * The most recent position per distinct keyword tracked for an entity, within
 * a lookback window. `distinct on` picks the newest `polled_at` row per
 * keyword — organicSov wants the domain's *current* standing, not history.
 */
export async function latestPositionsByEntity(
  db: Db,
  entityId: string,
  sinceDays = 30,
): Promise<LatestPositionRow[]> {
  const rows = await db<LatestPositionRow[]>`
    select distinct on (keyword) keyword, position, volume
    from serp_positions
    where entity_id = ${entityId} and polled_at >= now() - (${sinceDays}::text || ' days')::interval
    order by keyword, polled_at desc
  `;
  return rows;
}
