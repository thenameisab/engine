/**
 * Unified Visibility Score (A3) -- "one number, then depth."
 *
 * Blends organic + AI + local SoV into a single 0-100 score, weighted by the
 * customer's actual channel mix. Per the spec (A3.3) the score is *always a band*
 * because the AI surface carries a confidence band; that uncertainty propagates
 * up and must never be hidden. Organic and local are point estimates, so they
 * contribute zero width -- the unified band is exactly as wide as the AI
 * surface's band scaled by the AI channel weight.
 *
 * The blend is fully deterministic and configurable (A3 §6: no LLM). It also
 * returns the full decomposition (A3.4) so the UI can render the ring/bars and
 * drill into each surface without recomputing.
 */
import type { ConfidenceBand } from '@engine/core';

/**
 * Customer channel mix (A3.2). Weights need not sum to 1 -- they are normalized
 * here -- so callers can pass raw traffic shares from GA4/GSC directly. Before
 * connector data exists, use `DEFAULT_CHANNEL_MIX`.
 */
export interface ChannelMix {
  organic: number;
  ai: number;
  local: number;
}

/**
 * Sensible default channel mix before GA4/GSC data exists (A3 open question:
 * per-vertical defaults come later). Organic still dominates most funnels;
 * AI is a fast-growing minority; local is small unless the business is local.
 */
export const DEFAULT_CHANNEL_MIX: ChannelMix = {
  organic: 0.6,
  ai: 0.3,
  local: 0.1,
};

/** Per-surface inputs to the blend. Organic/local are points; AI is a band. */
export interface SurfaceScores {
  organic: number;
  ai: ConfidenceBand;
  local: number;
}

/** One surface's contribution to the final score, for decomposition (A3.3). */
export interface SurfaceContribution {
  /** This surface's own 0-100 score (AI reported at its band midpoint). */
  score: number;
  /** Normalized weight applied to it (0-1). */
  weight: number;
  /** Points this surface adds to the unified point score (score * weight). */
  contribution: number;
}

export interface UnifiedVisibilityScore {
  /** The headline number *with its range*. `point` is the hero figure. */
  band: ConfidenceBand;
  /** Normalized weights actually used (sum to 1, or all 0 if mix was empty). */
  weights: ChannelMix;
  decomposition: {
    organic: SurfaceContribution;
    ai: SurfaceContribution;
    local: SurfaceContribution;
  };
}

function normalize(mix: ChannelMix): ChannelMix {
  const o = Math.max(0, mix.organic);
  const a = Math.max(0, mix.ai);
  const l = Math.max(0, mix.local);
  const total = o + a + l;
  if (total === 0) return { organic: 0, ai: 0, local: 0 };
  return { organic: o / total, ai: a / total, local: l / total };
}

/**
 * Blend the three surface scores into the Unified Visibility Score. The band is
 * computed by weighting each bound independently: organic and local have
 * low=point=high, so only the AI band contributes width, scaled by the AI
 * weight. This is the exact statistical propagation the spec calls for (A3.3).
 */
export function unifiedVisibilityScore(
  surfaces: SurfaceScores,
  mix: ChannelMix = DEFAULT_CHANNEL_MIX,
): UnifiedVisibilityScore {
  const w = normalize(mix);

  const blend = (aiBound: number): number =>
    w.organic * surfaces.organic + w.ai * aiBound + w.local * surfaces.local;

  return {
    band: {
      low: blend(surfaces.ai.low),
      point: blend(surfaces.ai.point),
      high: blend(surfaces.ai.high),
    },
    weights: w,
    decomposition: {
      organic: {
        score: surfaces.organic,
        weight: w.organic,
        contribution: surfaces.organic * w.organic,
      },
      ai: {
        score: surfaces.ai.point,
        weight: w.ai,
        contribution: surfaces.ai.point * w.ai,
      },
      local: {
        score: surfaces.local,
        weight: w.local,
        contribution: surfaces.local * w.local,
      },
    },
  };
}
