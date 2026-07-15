/**
 * Severity + predicted-impact scoring (B1.8). Deterministic, no LLM (§6):
 * severity is an intrinsic per-issue-type weight; predicted impact multiplies
 * that severity by the page's value so a broken canonical on a high-traffic
 * money page outranks the same issue on an orphan page.
 *
 * Both are normalized 0-1 to match the `Finding.severity` / `predictedImpact`
 * fields in the frozen core contract.
 */
import type { IssueType } from './actions.js';

/**
 * Intrinsic severity per issue type, 0-1. Ordering reflects the MVP thesis:
 * GEO-native and Fix-Queue-executable issues (blocked AI crawlers, missing
 * schema/meta) are weighted at or above classic technical issues, because they
 * are exactly the feedstock the execution wedge monetizes.
 */
const SEVERITY_WEIGHT: Record<IssueType, number> = {
  'ai-crawler-blocked': 0.95,
  'canonical-conflict': 0.85,
  'noindex-unexpected': 0.9,
  'schema-missing': 0.7,
  'schema-invalid': 0.65,
  'redirect-chain': 0.6,
  'meta-title-missing': 0.6,
  'cwv-poor': 0.55,
  'hreflang-missing': 0.5,
  'meta-description-missing': 0.4,
  'not-in-sitemap': 0.35,
};

export function severityFor(type: IssueType): number {
  return SEVERITY_WEIGHT[type];
}

/**
 * Predicted impact = severity x page value. `pageValue` is clamped to [0,1];
 * when the crawler has no signal it defaults to 0.5 (see CrawledPage.pageValue)
 * so impact never silently collapses to zero.
 */
export function predictedImpact(type: IssueType, pageValue: number | undefined): number {
  const value = clamp01(pageValue ?? 0.5);
  return SEVERITY_WEIGHT[type] * value;
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
