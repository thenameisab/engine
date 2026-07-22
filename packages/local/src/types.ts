/**
 * B5 — Local SEO Audit (v1.5). For the "Delhi kirana store to Fortune 500"
 * span, local visibility is core — especially the India SMB wedge (spec §1).
 * B5 audits Google Business Profile completeness, NAP (Name/Address/Phone)
 * consistency across directories, and review health, blends them into a local
 * visibility score, and emits `source:'local'` Findings that map to GBP
 * automation (C5, `gbp` actions) and citation-correction tasks. Deterministic
 * over the profile facts the system holds for a location — no live GBP call at
 * audit time — the same reproducibility contract B1/B2/B3 hold.
 *
 * A location is an entity (spec §5): multi-location = multiple linked entities,
 * so B5 joins entity-first like everything else.
 */

/** The B5 v1.5 local issue types (spec §7). */
export type LocalIssueType =
  | 'incomplete-gbp-field' // B5.1: a GBP profile field is missing/thin
  | 'nap-inconsistency' // B5.2: a directory lists a different Name/Address/Phone
  | 'unanswered-reviews' // B5.3: reviews without an owner response
  | 'low-review-velocity'; // B5.3: too few recent reviews to signal an active listing

/** One directory's listing of the location, for NAP consistency checking. */
export interface DirectoryListing {
  source: string; // e.g. 'justdial.com', 'g2.com'
  name: string;
  address: string;
  phone: string;
}

/** One review, for velocity + response + sentiment. */
export interface Review {
  rating: number; // 1–5
  respondedTo: boolean;
  sentiment: 'positive' | 'neutral' | 'negative' | null;
  /** ISO timestamp the review was left. */
  at: string;
}

/**
 * Everything B5 audits for one location. The canonical NAP is the profile's own
 * Name/Address/Phone; directory listings are checked against it.
 */
export interface LocalProfileFacts {
  entityId: string;
  canonicalName: string;
  name: string;
  address: string;
  phone: string;
  // GBP completeness fields.
  categories: string[];
  hoursSet: boolean;
  attributes: string[];
  photoCount: number;
  description: string | null;
  directoryListings: DirectoryListing[];
  reviews: Review[];
}

/**
 * The lead metric (spec §8): a 0–1 local visibility score with its component
 * sub-scores, so the owner sees *why* a location scores low — thin GBP profile,
 * inconsistent NAP, or an unhealthy review profile. Continuous, like B2/B3.
 */
export interface LocalVisibility {
  entityId: string;
  canonicalName: string;
  score: number;
  components: {
    /** 0–1 fraction of GBP profile fields adequately filled. */
    gbpCompleteness: number;
    /** 0–1 fraction of directory listings whose NAP matches the profile. */
    napConsistency: number;
    /** 0–1 blended review health (velocity + response rate + sentiment). */
    reviewHealth: number;
  };
  reviewsConsidered: number;
}
