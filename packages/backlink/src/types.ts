/**
 * A6 — Backlink & Mention Index (v1.5). The insight that shapes this module:
 * for AI visibility, unlinked brand mentions and the *domains AI engines cite*
 * matter more than a raw link graph (spec §1). So the v1.5 deterministic core
 * is citation-domain intelligence — mined from the A2 answer archive already
 * in `citation_events.sources_cited` — plus mention/profile completeness, both
 * computed as reproducible set operations over data the system already holds
 * (no live external call), the same contract B1/B2/B3 hold.
 */

/** The three A6 v1.5 off-site issue types (spec §7). */
export type OffsiteIssueType =
  | 'absent-from-citation-domain' // high-value domain AI cites in the category, entity absent
  | 'incomplete-third-party-profile' // known directory/review profile the entity has no mention on
  | 'negative-mention-cluster'; // a cluster of negative-sentiment citations for the entity

/**
 * One AI-answer observation from the A2 archive: which registrable domains the
 * engine cited, for which entity, and the answer's sentiment. The category's
 * whole citation graph is just a stream of these.
 */
export interface CitationObservation {
  entityId: string;
  /** Registrable domains the engine cited in this answer. */
  citedDomains: string[];
  engine: string;
  sentiment: 'positive' | 'neutral' | 'negative' | null;
}

/**
 * One domain's citation intelligence across the category (spec §4.3): how often
 * AI engines cite it, across how many distinct entities, and whether the
 * self-entity is among them. `authority` saturates on the number of distinct
 * entities that cite it — a domain the whole category's answers lean on is an
 * authoritative citation source, not a one-off.
 */
export interface DomainIntel {
  domain: string;
  citationCount: number;
  distinctEntities: number;
  engines: string[];
  authority: number; // 0–1
  selfPresent: boolean;
}

/**
 * A citation opportunity (the lead metric, spec §8): a high-authority category
 * citation domain the self-entity is absent from — where digital PR (C6) would
 * most move AI citation. `impact` ranks the list.
 */
export interface CitationOpportunity {
  domain: string;
  authority: number;
  citationCount: number;
  distinctEntities: number;
  impact: number; // 0–1
}
