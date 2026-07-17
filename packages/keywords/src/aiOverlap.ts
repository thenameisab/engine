/**
 * A4.9 SERP ↔ AI-answer overlap — bridges A1 (rank tracking) and A2 (AI
 * visibility): a keyword whose SERP already surfaces an AI Overview/AI Mode
 * is a signal the same query space is worth polling as a prompt too.
 *
 * Deliberately takes `readonly string[]` rather than importing
 * `SerpFeature` from `@engine/connectors`: this package has no other
 * dependency on the connector layer, and pulling one in just for a string
 * union would be a heavier coupling than the two AI-surface literals below
 * are worth. The values mirror `SerpFeature` in
 * `packages/connectors/src/serp.ts` — keep them in sync if that type grows
 * another AI-surface member.
 */
const AI_SURFACE_FEATURES = new Set(['ai_overview', 'ai_mode']);

/** Whether a SERP's feature set includes an AI-generated answer surface. */
export function hasAiOverlap(features: readonly string[]): boolean {
  return features.some((f) => AI_SURFACE_FEATURES.has(f));
}
