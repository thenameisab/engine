/**
 * Organic Share of Voice (A3.1, first input to the Unified Visibility Score).
 *
 * SoV is the volume-weighted, CTR-curve-weighted share of clicks a domain is
 * estimated to capture across a tracked keyword set, relative to the total
 * available click demand. It is a deterministic point estimate (organic
 * rankings are directly observed, so there is no sampling band here -- the band
 * only enters via the AI surface, see ./ai.ts).
 *
 * Input keyword rows come from A1 (ClickHouse rankings); each row is one tracked
 * keyword with the domain's best observed organic position and the keyword's
 * search volume.
 */

/** One tracked keyword's organic standing for the measured domain. */
export interface OrganicKeywordRow {
  keyword: string;
  /** Best organic position held by the measured domain, 1-indexed. Null = not ranking in the tracked window. */
  position: number | null;
  /** Monthly search volume; used as the demand weight. Must be >= 0. */
  volume: number;
}

/**
 * Position -> estimated organic CTR. Grounded in widely-published SERP
 * click-curve studies (pos 1 ~ 28%, decaying fast). Positions past the tracked
 * depth contribute ~0. The exact curve is configurable so it can be re-fit
 * against a customer's own GSC data later without touching the SoV math.
 */
const DEFAULT_CTR_CURVE: readonly number[] = [
  0.283, 0.152, 0.098, 0.068, 0.05, 0.039, 0.031, 0.026, 0.022, 0.019,
];

/** CTR for a given 1-indexed position under a curve, 0 past the curve's tail. */
export function ctrForPosition(
  position: number | null,
  curve: readonly number[] = DEFAULT_CTR_CURVE,
): number {
  if (position === null || position < 1) return 0;
  const idx = Math.floor(position) - 1;
  return idx < curve.length ? curve[idx] : 0;
}

/**
 * Organic SoV as a 0-100 number: captured clicks / total available clicks.
 * "Total available" is the full demand of the tracked set (every keyword's
 * volume weighted by the best-possible CTR, i.e. position 1), so the score is
 * the fraction of *winnable* organic demand this domain actually wins.
 */
export function organicSov(
  rows: readonly OrganicKeywordRow[],
  curve: readonly number[] = DEFAULT_CTR_CURVE,
): number {
  if (rows.length === 0) return 0;
  const topCtr = curve[0];
  let captured = 0;
  let available = 0;
  for (const row of rows) {
    const volume = Math.max(0, row.volume);
    captured += volume * ctrForPosition(row.position, curve);
    available += volume * topCtr;
  }
  if (available === 0) return 0;
  return (captured / available) * 100;
}

export { DEFAULT_CTR_CURVE };
