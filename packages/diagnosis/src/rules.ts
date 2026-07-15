/**
 * The B1 rule engine (§4, §6 "mostly deterministic rule engine"). Each detector
 * is a pure function of a single `CrawledPage` that yields zero or more raw
 * issues; ./audit.ts scores them into `Finding` objects. No I/O, no LLM.
 */
import type { AiCrawler, CrawledPage } from './page.js';
import type { IssueType } from './actions.js';

/** A detected issue before severity scoring / action attachment. */
export interface RawIssue {
  type: IssueType;
  /** Structured evidence stored on the Finding (§4.9, becomes Finding.evidence). */
  evidence: Record<string, unknown>;
}

/** CrUX "poor" thresholds (B1.2). At or beyond these, the metric is poor. */
export const CWV_POOR = { lcpMs: 4000, inpMs: 500, cls: 0.25 } as const;

const AI_CRAWLERS: AiCrawler[] = ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended'];

/** B1.4 structured-data validation: missing entirely, or present-but-invalid. */
export function checkStructuredData(page: CrawledPage): RawIssue[] {
  if (page.structuredData.length === 0) {
    return [{ type: 'schema-missing', evidence: { url: page.url } }];
  }
  const invalid = page.structuredData.filter((b) => !b.valid);
  if (invalid.length > 0) {
    return [
      {
        type: 'schema-invalid',
        evidence: {
          url: page.url,
          blocks: invalid.map((b) => ({ type: b.type, errors: b.errors })),
        },
      },
    ];
  }
  return [];
}

/** B1 → C3.2: missing title / meta description. */
export function checkMeta(page: CrawledPage): RawIssue[] {
  const issues: RawIssue[] = [];
  if (page.title.trim() === '') issues.push({ type: 'meta-title-missing', evidence: { url: page.url } });
  if (page.metaDescription.trim() === '') {
    issues.push({ type: 'meta-description-missing', evidence: { url: page.url } });
  }
  return issues;
}

/** B1.6 AI-crawler access audit — the GEO-native check. One issue per blocked bot. */
export function checkAiCrawlerAccess(page: CrawledPage): RawIssue[] {
  const blocked = AI_CRAWLERS.filter((c) => page.aiCrawlerAccess[c] === 'blocked');
  if (blocked.length === 0) return [];
  return [{ type: 'ai-crawler-blocked', evidence: { url: page.url, blocked } }];
}

/** B1.5 redirect chains (>1 hop) and conflicting canonicals. */
export function checkRedirectsAndCanonical(page: CrawledPage): RawIssue[] {
  const issues: RawIssue[] = [];
  if (page.redirectChain.length > 1) {
    issues.push({ type: 'redirect-chain', evidence: { url: page.url, chain: page.redirectChain } });
  }
  // A canonical pointing away from the page's own URL on an indexable page is a
  // conflicting signal (self-canonical or absent is fine).
  if (page.canonical && page.canonical !== page.url && page.indexable) {
    issues.push({
      type: 'canonical-conflict',
      evidence: { url: page.url, canonical: page.canonical },
    });
  }
  return issues;
}

/** B1.9 hreflang audit: an i18n-cluster page that declares no alternates. */
export function checkHreflang(page: CrawledPage): RawIssue[] {
  if (page.expectsHreflang && page.hreflang.length === 0) {
    return [{ type: 'hreflang-missing', evidence: { url: page.url } }];
  }
  return [];
}

/** B1.2 Core Web Vitals: flag when any metric is in the poor band. */
export function checkCoreWebVitals(page: CrawledPage): RawIssue[] {
  const { lcpMs, inpMs, cls, field } = page.vitals;
  const poor: string[] = [];
  if (lcpMs >= CWV_POOR.lcpMs) poor.push('LCP');
  if (inpMs >= CWV_POOR.inpMs) poor.push('INP');
  if (cls >= CWV_POOR.cls) poor.push('CLS');
  if (poor.length === 0) return [];
  return [{ type: 'cwv-poor', evidence: { url: page.url, poor, field, lcpMs, inpMs, cls } }];
}

/** B1.3 indexability: unexpected noindex, or an indexable page missing from the sitemap. */
export function checkIndexability(page: CrawledPage): RawIssue[] {
  const issues: RawIssue[] = [];
  if (page.noindex && page.indexable) {
    // noindex present yet the crawler still treated it as an index target — a
    // contradictory signal worth a human's eyes.
    issues.push({
      type: 'noindex-unexpected',
      evidence: { url: page.url, source: page.noindex.source },
    });
  }
  if (page.indexable && !page.inSitemap && page.statusCode === 200) {
    issues.push({ type: 'not-in-sitemap', evidence: { url: page.url } });
  }
  return issues;
}

/** All detectors, run in order. */
export const DETECTORS: ((page: CrawledPage) => RawIssue[])[] = [
  checkStructuredData,
  checkMeta,
  checkAiCrawlerAccess,
  checkRedirectsAndCanonical,
  checkHreflang,
  checkCoreWebVitals,
  checkIndexability,
];

/** Run every detector over one page. */
export function detectIssues(page: CrawledPage): RawIssue[] {
  return DETECTORS.flatMap((d) => d(page));
}
