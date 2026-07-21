/**
 * B2 rule engine: turn a page's extractability scores into `Finding`-shaped
 * raw issues, mirroring `@engine/diagnosis`'s rules.ts. A page below the
 * threshold on a dimension fires that finding; a page with no captured
 * content (`extractabilityScore` returns null) fires nothing — silence, not
 * a false "everything's fine" or a false "everything's broken".
 */
import type { CrawledPage } from '@engine/diagnosis';
import { extractabilityScore, type ExtractabilityScore, type EntityCoverageFacts } from './score.js';
import type { ContentIssueType } from './actions.js';

/** Below this on a 0-1 dimension, the page gets a finding for it. */
const THRESHOLD = 0.5;

/**
 * A page with real body content but fewer than this many internal links is
 * flagged for the C3 internal-link fix. Only evaluated when the crawler
 * captured a count (`internalLinkCount` is set) — an absent signal fires
 * nothing, same silence-not-false-pass contract as the scored dimensions.
 */
const MIN_INTERNAL_LINKS = 2;

export interface RawContentIssue {
  type: ContentIssueType;
  evidence: { url: string; score: number };
}

export function detectContentIssues(
  page: CrawledPage,
  entity?: EntityCoverageFacts,
): { issues: RawContentIssue[]; score: ExtractabilityScore | null } {
  const score = extractabilityScore(page, entity);
  if (!score) return { issues: [], score: null };

  const issues: RawContentIssue[] = [];
  if (score.breakdown.answerFirst < THRESHOLD) {
    issues.push({ type: 'not-answer-first', evidence: { url: page.url, score: score.breakdown.answerFirst } });
  }
  if (score.breakdown.selfContainment < THRESHOLD) {
    issues.push({ type: 'poor-self-containment', evidence: { url: page.url, score: score.breakdown.selfContainment } });
  }
  if (score.breakdown.eeat < THRESHOLD) {
    issues.push({ type: 'weak-eeat', evidence: { url: page.url, score: score.breakdown.eeat } });
  }
  if (typeof score.entityCoverage === 'number' && score.entityCoverage < THRESHOLD) {
    issues.push({ type: 'weak-entity-coverage', evidence: { url: page.url, score: score.entityCoverage } });
  }
  // C3 internal links: a page with real content but too few internal links.
  // Only evaluated when the crawler captured a count; the score recorded is
  // the link count normalized against the target, so severity reflects how
  // link-starved the page is (0 links → severity 1).
  if (typeof page.internalLinkCount === 'number' && page.internalLinkCount < MIN_INTERNAL_LINKS) {
    const linkScore = Math.max(0, Math.min(1, page.internalLinkCount / MIN_INTERNAL_LINKS));
    issues.push({ type: 'sparse-internal-linking', evidence: { url: page.url, score: linkScore } });
  }
  return { issues, score };
}
