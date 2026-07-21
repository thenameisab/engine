/**
 * B3 — Entity & Knowledge Graph Audit. Operationalizes the entity-first data
 * model as a diagnosis: is the customer's entity consistent, corroborated, and
 * correctly mapped across the web? Every check runs deterministically over
 * data the system already holds on the `entities` row (the crawler-resolved
 * on-site JSON-LD, the A6 mentions, the A2 citations, the Wikidata mapping) —
 * no live external call, so the audit is reproducible and unit-testable, the
 * same contract B1 (`@engine/diagnosis`) and B2 (`@engine/content`) hold.
 */

/** The five B3 issue types (spec §7). Each owns its `entity`-source vocabulary. */
export type EntityIssueType =
  | 'missing-wikidata-mapping' // B3.1: no canonical Wikidata id resolved
  | 'missing-entity-schema' // B3.2: no on-site JSON-LD identifies the entity
  | 'inconsistent-sameas' // B3.1: on-site sameAs omits known official profiles
  | 'weak-corroboration'; // B3.4: too few independent sources corroborate the entity

/**
 * Everything B3 audits for one entity — all already persisted on the row, so
 * the audit reads the graph the rest of Engine joins through rather than
 * re-deriving it.
 */
export interface EntityGraphFacts {
  id: string;
  canonicalName: string;
  wikidataId: string | null;
  /** Official/owned profile URLs (site, socials, directories) the entity claims. */
  urls: string[];
  /** Cross-web mentions of the entity (the A6 feed) — corroboration sources. */
  mentions: string[];
  /** AI-answer citations of the entity (the A2 feed) — corroboration sources. */
  citations: string[];
  /** On-site JSON-LD blocks the crawler resolved for this entity's pages. */
  schema: object[];
}

/**
 * The lead metric (spec §8): a 0–1 entity strength with its component
 * sub-scores, so the UX can show *why* an entity is weak, not just that it is.
 * Continuous, like B2's extractability — the number is the honesty signal.
 */
export interface EntityStrength {
  entityId: string;
  canonicalName: string;
  /** Blended 0–1 overall strength. */
  score: number;
  components: {
    /** 1 if a canonical Wikidata id is resolved, else 0. */
    wikidata: number;
    /** 1 if on-site schema correctly identifies the entity, else 0. */
    schema: number;
    /** 0–1 fraction of known official profiles present in on-site sameAs. */
    sameAsConsistency: number;
    /** 0–1 corroboration from distinct independent sources. */
    corroboration: number;
  };
  /** Distinct corroborating source domains counted for the corroboration score. */
  corroboratingDomains: number;
}
