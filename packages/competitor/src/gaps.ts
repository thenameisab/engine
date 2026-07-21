/**
 * A5 gap computations. Each is a deterministic set-difference between the
 * customer's entity ("self") and a set of competitor entities, over one facet
 * of the entity model. Kept separate from `audit.ts` (which maps gaps ->
 * Findings) so the diff + impact math is unit-testable in isolation.
 */
import type { CompetitorFacts, Gap, GapType } from './types.js';

/** Normalize a set-item for comparison: trimmed, lowercased, empties dropped. */
function norm(items: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const raw of items) {
    const s = raw.trim().toLowerCase();
    if (s) out.add(s);
  }
  return out;
}

/**
 * Membership gap over one dimension: every item some competitor has that self
 * lacks, weighted by how many competitors share it (co-occurrence). An item
 * two competitors rank for is a bigger hole than one only a single competitor
 * touches — that ordering is the whole point of the gap table.
 */
function membershipGaps(
  type: GapType,
  self: CompetitorFacts,
  competitors: readonly CompetitorFacts[],
  pick: (f: CompetitorFacts) => string[],
): Gap[] {
  const mine = norm(pick(self));
  const total = competitors.length || 1;

  // item -> { competitors holding it, original casing to display }
  const holders = new Map<string, { ids: Set<string>; display: string }>();
  for (const comp of competitors) {
    for (const raw of pick(comp)) {
      const key = raw.trim().toLowerCase();
      if (!key || mine.has(key)) continue; // self already has it — not a gap
      const entry = holders.get(key) ?? { ids: new Set<string>(), display: raw.trim() };
      entry.ids.add(comp.entityId);
      holders.set(key, entry);
    }
  }

  const gaps: Gap[] = [];
  for (const [, entry] of holders) {
    const heldByCount = entry.ids.size;
    gaps.push({
      type,
      item: entry.display,
      heldByCount,
      heldBy: [...entry.ids],
      // Share of the competitor set that holds it: 1 competitor of 4 -> 0.25,
      // all 4 -> 1.0. A gap the whole field has beaten you on ranks highest.
      impact: heldByCount / total,
      evidence: { heldByCount, competitorSetSize: total },
    });
  }
  return gaps;
}

/** How far below a threshold self should be flagged as an entity-strength gap. */
export const ENTITY_GAP_MIN_DELTA = 0.1;

/**
 * Entity gap (A5.4): the one continuous differential. For each competitor whose
 * B3 strength meaningfully exceeds self's, emit a gap sized by the delta. Self
 * with no strength yet (null) is treated as 0 — "they are understood, you are
 * not" is exactly the gap to surface.
 */
function entityGaps(self: CompetitorFacts, competitors: readonly CompetitorFacts[]): Gap[] {
  const mine = self.entityStrength ?? 0;
  const gaps: Gap[] = [];
  for (const comp of competitors) {
    if (comp.entityStrength === null) continue; // no audit -> nothing to compare
    const delta = comp.entityStrength - mine;
    if (delta < ENTITY_GAP_MIN_DELTA) continue;
    gaps.push({
      type: 'entity-gap',
      item: comp.canonicalName,
      heldByCount: 1,
      heldBy: [comp.entityId],
      impact: Math.min(1, delta),
      evidence: { selfStrength: mine, competitorStrength: comp.entityStrength, delta },
    });
  }
  return gaps;
}

export interface ComputeGapsResult {
  gaps: Gap[];
  byType: Record<GapType, Gap[]>;
}

/**
 * Compute all five gap dimensions for one self-entity against its competitor
 * set. Returns the flat ranked list (biggest impact first, then most-held,
 * then item for stable ordering) plus a per-type grouping for the four gap
 * tables in the UX (spec §8).
 */
export function computeGaps(self: CompetitorFacts, competitors: readonly CompetitorFacts[]): ComputeGapsResult {
  const gaps: Gap[] = [
    ...membershipGaps('keyword-gap', self, competitors, (f) => f.keywords),
    ...membershipGaps('citation-gap', self, competitors, (f) => f.prompts),
    ...membershipGaps('content-gap', self, competitors, (f) => f.topics),
    ...entityGaps(self, competitors),
    ...membershipGaps('backlink-gap', self, competitors, (f) => f.referringDomains),
  ];

  gaps.sort(
    (a, b) => b.impact - a.impact || b.heldByCount - a.heldByCount || a.item.localeCompare(b.item),
  );

  const byType: Record<GapType, Gap[]> = {
    'keyword-gap': [],
    'citation-gap': [],
    'content-gap': [],
    'entity-gap': [],
    'backlink-gap': [],
  };
  for (const g of gaps) byType[g.type].push(g);

  return { gaps, byType };
}
