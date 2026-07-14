/**
 * Local Share of Voice (A3.1, third input to the Unified Visibility Score),
 * derived from local-pack presence (A1.4 / B5). Like organic, it is directly
 * observed, so it is a deterministic point estimate.
 */

/** One tracked local query's standing for the measured business. */
export interface LocalPackRow {
  keyword: string;
  /** Rank within the local pack (1-3 typically), or null if absent from the pack. */
  packPosition: number | null;
  /** Local demand weight for this query. Must be >= 0. */
  volume: number;
}

/**
 * Local pack visibility weight by position. Pack has 3 visible slots; slot 1
 * dominates. Absent from the pack contributes 0.
 */
const DEFAULT_LOCAL_CURVE: readonly number[] = [1.0, 0.55, 0.35];

/** Visibility weight for a 1-indexed local-pack position. */
export function localWeightForPosition(
  packPosition: number | null,
  curve: readonly number[] = DEFAULT_LOCAL_CURVE,
): number {
  if (packPosition === null || packPosition < 1) return 0;
  const idx = Math.floor(packPosition) - 1;
  return idx < curve.length ? curve[idx] : 0;
}

/**
 * Local SoV as a 0-100 number: captured local visibility / total available
 * (every tracked query weighted by the top pack slot).
 */
export function localSov(
  rows: readonly LocalPackRow[],
  curve: readonly number[] = DEFAULT_LOCAL_CURVE,
): number {
  if (rows.length === 0) return 0;
  const topWeight = curve[0];
  let captured = 0;
  let available = 0;
  for (const row of rows) {
    const volume = Math.max(0, row.volume);
    captured += volume * localWeightForPosition(row.packPosition, curve);
    available += volume * topWeight;
  }
  if (available === 0) return 0;
  return (captured / available) * 100;
}

export { DEFAULT_LOCAL_CURVE };
