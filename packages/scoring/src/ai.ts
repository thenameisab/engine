/**
 * AI Share of Voice / "Share of Model" (A3.1, second input to the Unified
 * Visibility Score) -- derived from A2's citation measurements.
 *
 * This is the surface that carries the honesty signature: every A2 measurement
 * is a `ConfidenceBand` from n=3-5 samples, never a point. So AI SoV is itself a
 * band, and that band is what later widens the unified score's band
 * (see ./unified.ts). We never collapse it to a point here.
 */
import type { CitationMeasurement, ConfidenceBand } from '@engine/core';

/**
 * Aggregate a set of per-engine/per-prompt citation measurements into a single
 * AI SoV band on a 0-100 scale.
 *
 * Each measurement's `citationRate` band (0-1) is averaged across the set,
 * low/point/high independently, then scaled to 0-100. Averaging the bounds
 * independently is deliberate: it preserves the *width* of uncertainty rather
 * than hiding it behind a single blended midpoint.
 *
 * `weights` optionally weights measurements (e.g. by engine market share or
 * prompt importance); defaults to equal weight. A weight <= 0 drops the row.
 */
export function aiSov(
  measurements: readonly CitationMeasurement[],
  weights?: (m: CitationMeasurement, index: number) => number,
): ConfidenceBand {
  if (measurements.length === 0) return { low: 0, point: 0, high: 0 };

  let wSum = 0;
  let low = 0;
  let point = 0;
  let high = 0;
  measurements.forEach((m, i) => {
    const w = Math.max(0, weights ? weights(m, i) : 1);
    if (w === 0) return;
    wSum += w;
    low += w * m.citationRate.low;
    point += w * m.citationRate.point;
    high += w * m.citationRate.high;
  });
  if (wSum === 0) return { low: 0, point: 0, high: 0 };

  return {
    low: (low / wSum) * 100,
    point: (point / wSum) * 100,
    high: (high / wSum) * 100,
  };
}
