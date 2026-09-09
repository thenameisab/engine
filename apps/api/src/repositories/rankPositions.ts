import { hostOf, normalizeDomain, type SerpResult } from '@engine/connectors';
import type { Db } from '../db.js';

/**
 * Persist A1 rank-poll results (migration 0005). Before this, `POST
 * /rank/poll` fetched live SERP data and returned it without storing
 * anything — M1.1's "ingestion -> warehouse" half never happened.
 *
 * `position` is the best (lowest) organic rank held by `targetDomain`, or
 * null if that domain didn't appear in the tracked result depth — matching
 * how `organicSov`/`ctrForPosition` in @engine/scoring already treat "not
 * ranking." One row per polled query, not per organic result: the row is a
 * poll observation, not a SERP snapshot (the full organic list stays in the
 * raw lake via `rawSnapshotRef`).
 *
 * The domain filter is the whole point and was missing: this took the lowest
 * position in the SERP regardless of whose result it was, so every stored row
 * recorded whoever ranked first — position 1, with a competitor's URL — as the
 * tracked entity's own standing, and `latestPositionsByEntity` fed that into
 * the visibility score. Two rows written that way exist in the scratch
 * database from the day this was found.
 */
export async function insertSerpPositions(
  db: Db,
  entityId: string,
  results: readonly SerpResult[],
  targetDomain: string,
): Promise<void> {
  const target = normalizeDomain(targetDomain);
  for (const r of results) {
    const mine = r.organic.filter((o) => {
      const host = hostOf(o.url);
      return host !== null && (host === target || host.endsWith(`.${target}`));
    });
    const best = mine.length > 0 ? mine.reduce((a, b) => (b.position < a.position ? b : a)) : null;
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
