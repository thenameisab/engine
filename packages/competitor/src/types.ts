/**
 * A5 — Competitor Intelligence. Visibility is relative: the job is to show
 * where competitors beat you across *both* classic SEO and GEO on one entity
 * model (spec §1). Every gap is a deterministic set-difference over dimensions
 * the entity-first data model already holds — the keywords it ranks for (A1),
 * the prompts it is cited for (A2), the topics/pages it covers, the entity
 * strength (B3), and the referring domains behind it (A6) — so the analysis is
 * reproducible and unit-testable, the same contract B1/B2/B3 hold, and no gap
 * needs a live external call to recompute.
 */

/**
 * The five A5 gap dimensions (spec §3). Each is a set-difference on one facet
 * of the entity model; `entity` is the one continuous differential (strength),
 * the rest are membership gaps.
 */
export type GapType =
  | 'keyword-gap' // A5.1: keywords competitors rank for that you don't (A1)
  | 'citation-gap' // A5.2: prompts competitors are cited for that you aren't (A2) — the GEO-native gap
  | 'content-gap' // A5.3: topics/pages they cover that you don't (crawl + entity model)
  | 'entity-gap' // A5.4: entity coverage/strength differential (B3)
  | 'backlink-gap'; // A5.5: referring domains they have that you don't (A6, licensed)

/**
 * One competitor's facets, as the entity-first model already stores them. The
 * `self` side of the analysis has the same shape — a gap is simply an item a
 * competitor has that self lacks, weighted by how many competitors share it.
 */
export interface CompetitorFacts {
  entityId: string;
  canonicalName: string;
  /** A1 ranking terms. */
  keywords: string[];
  /** A2 prompts the entity is cited for. */
  prompts: string[];
  /** Topics/pages the entity covers (crawl + entity model). */
  topics: string[];
  /** Referring/mentioning source domains (A6 licensed links + mentions). */
  referringDomains: string[];
  /** 0–1 B3 entity strength; null when no entity audit has run for it. */
  entityStrength: number | null;
}

/**
 * One gap the customer should close. `item` is the specific missing thing (a
 * keyword, a prompt, a topic, a referring domain) or — for the entity gap —
 * the competitor whose entity is stronger. `heldByCount` is how many
 * competitors in the set have it: the co-occurrence signal that ranks a gap's
 * predicted impact (spec §4.7, §12).
 */
export interface Gap {
  type: GapType;
  item: string;
  /** Number of competitors in the set that hold this item (1..N). */
  heldByCount: number;
  /** Competitor entity ids that hold it, for drill-down + evidence. */
  heldBy: string[];
  /** 0–1 predicted impact used to rank "biggest gaps to close". */
  impact: number;
  evidence: Record<string, unknown>;
}
