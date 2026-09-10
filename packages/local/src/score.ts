/**
 * B5 scoring: deterministic GBP completeness, NAP consistency, and review
 * health, blended into the local visibility score. Kept separate from
 * `audit.ts` (which maps the gaps -> Findings) so the thresholds are
 * unit-testable in isolation.
 */
import type { DirectoryListing, LocalProfileFacts, Review } from './types.js';

/** Normalize an NAP field for comparison: lowercase, collapse non-alphanumerics. */
export function normalizeNap(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Normalize a phone to its digits only (country-code-tolerant tail compare). */
export function normalizePhone(value: string): string {
  const digits = value.replace(/\D+/g, '');
  // Compare on the last 10 digits so +91 / 0-prefix / spacing differences don't
  // read as an inconsistency; a genuinely different number still differs.
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/** The GBP completeness fields and whether each is adequately filled. */
export interface GbpFieldStatus {
  field: 'categories' | 'hours' | 'attributes' | 'photos' | 'description';
  present: boolean;
}

/** Minimum photos for the photos field to count as filled. */
export const MIN_PHOTOS = 3;

export function gbpFieldStatuses(facts: LocalProfileFacts): GbpFieldStatus[] {
  return [
    { field: 'categories', present: facts.categories.length > 0 },
    { field: 'hours', present: facts.hoursSet },
    { field: 'attributes', present: facts.attributes.length > 0 },
    { field: 'photos', present: facts.photoCount >= MIN_PHOTOS },
    { field: 'description', present: !!facts.description && facts.description.trim().length >= 50 },
  ];
}

export function gbpCompleteness(facts: LocalProfileFacts): number {
  const statuses = gbpFieldStatuses(facts);
  const filled = statuses.filter((s) => s.present).length;
  return filled / statuses.length;
}

/** Does a directory listing's NAP match the canonical profile? */
export function listingMatches(facts: LocalProfileFacts, listing: DirectoryListing): boolean {
  return (
    normalizeNap(listing.name) === normalizeNap(facts.name) &&
    normalizeNap(listing.address) === normalizeNap(facts.address) &&
    normalizePhone(listing.phone) === normalizePhone(facts.phone)
  );
}

export interface NapResult {
  consistency: number;
  inconsistent: DirectoryListing[];
}

/**
 * NAP consistency across directories. 1 when there are no listings to check
 * (nothing to be inconsistent with) or all match; lower as listings diverge.
 */
export function napConsistency(facts: LocalProfileFacts): NapResult {
  const listings = facts.directoryListings;
  if (listings.length === 0) return { consistency: 1, inconsistent: [] };
  const inconsistent = listings.filter((l) => !listingMatches(facts, l));
  return { consistency: (listings.length - inconsistent.length) / listings.length, inconsistent };
}

/** Reviews within this many days count toward "recent" velocity. */
export const REVIEW_VELOCITY_WINDOW_DAYS = 90;
/** Recent-review count at/above which velocity is considered healthy (score 1). */
export const REVIEW_VELOCITY_TARGET = 5;

export interface ReviewResult {
  health: number;
  recentCount: number;
  unanswered: number;
  negativeShare: number;
}

/**
 * Review health blends three signals, each 0–1: recent velocity (saturating at
 * the target), response rate (answered / total), and sentiment (1 − negative
 * share). Equal-weighted. `now` is injectable so the window is testable.
 */
export function reviewHealth(reviews: readonly Review[], now: () => number): ReviewResult {
  if (reviews.length === 0) return { health: 0, recentCount: 0, unanswered: 0, negativeShare: 0 };

  const cutoff = now() - REVIEW_VELOCITY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const recentCount = reviews.filter((r) => Date.parse(r.at) >= cutoff).length;
  const velocity = Math.min(1, recentCount / REVIEW_VELOCITY_TARGET);

  const unanswered = reviews.filter((r) => !r.respondedTo).length;
  const responseRate = (reviews.length - unanswered) / reviews.length;

  const withSentiment = reviews.filter((r) => r.sentiment !== null);
  const negative = withSentiment.filter((r) => r.sentiment === 'negative').length;
  const negativeShare = withSentiment.length === 0 ? 0 : negative / withSentiment.length;
  const sentimentScore = 1 - negativeShare;

  const health = (velocity + responseRate + sentimentScore) / 3;
  return { health, recentCount, unanswered, negativeShare };
}

/** Weighted blend of the three components into the 0–1 local visibility score. */
export function blendedScore(gbp: number, nap: number, review: number | null): number {
  // GBP completeness and NAP consistency are the deterministic ranking signals
  // Google leans on hardest; reviews support them.
  //
  // `review === null` means review health was never *measured*, which is not
  // the same as measuring it and finding nothing. A profile typed in by hand
  // carries no reviews because nobody could type them, and folding a 0 in
  // would tell that owner their local presence is weak when the truth is that
  // a quarter of the score has no input. The remaining weights are
  // renormalized instead — the same thing `unifiedVisibilityScore` already
  // does when local's weight is 0.
  if (review === null) return (0.4 * gbp + 0.35 * nap) / 0.75;
  return 0.4 * gbp + 0.35 * nap + 0.25 * review;
}
