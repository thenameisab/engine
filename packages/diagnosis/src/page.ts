/**
 * The `CrawledPage` input model (B1.1 crawler output, one record per URL).
 *
 * This is the *contract between the crawler and the rule engine*: the Playwright
 * crawl (B1.1, out of scope for this package) produces these records; the rule
 * engine in ./rules.ts consumes them and emits `Finding` objects. Keeping the
 * detectors pure over this struct means they are trivially unit-testable and
 * carry no I/O — the crawler can run anywhere and feed the same rules.
 *
 * Every field is what a single rendered crawl of one URL can observe. Anything
 * requiring cross-page state (redirect chains, sitemap coverage, crawl diff) is
 * modelled explicitly so a detector never has to reach outside its input.
 */

/** One of the GEO-relevant AI crawler user agents we audit (B1.6). */
export type AiCrawler = 'GPTBot' | 'ClaudeBot' | 'PerplexityBot' | 'Google-Extended';

/** robots.txt / header verdict for a given user agent. */
export type CrawlerAccess = 'allowed' | 'blocked';

/** Core Web Vitals field or lab measurement (B1.2). Units: ms except CLS. */
export interface CoreWebVitals {
  /** Largest Contentful Paint, milliseconds. */
  lcpMs: number;
  /** Interaction to Next Paint, milliseconds. */
  inpMs: number;
  /** Cumulative Layout Shift, unitless. */
  cls: number;
  /** Whether these are CrUX field values (true) or lab-only fallback (false). */
  field: boolean;
}

/** A single structured-data (schema.org) block found on the page (B1.4). */
export interface StructuredDataBlock {
  type: string;
  valid: boolean;
  /** Validator error messages; empty when valid. */
  errors: string[];
}

/** A crawled URL and everything one rendered fetch observed about it. */
export interface CrawledPage {
  url: string;
  /** Entity this URL resolves to (§5 entity linkage). */
  entityId: string;
  /** Final HTTP status after following redirects. */
  statusCode: number;
  /** Ordered redirect hops that led here (B1.5); empty if none. */
  redirectChain: string[];
  /** Canonical URL the page declares, if any (B1.3/B1.5). */
  canonical?: string;
  /** True if the page is self-canonical or has no canonical conflict. */
  indexable: boolean;
  /** Present when noindex is set, with its source (B1.3). */
  noindex?: { source: 'meta' | 'header' | 'robots' };
  /** Whether this URL is covered by a submitted sitemap (B1.3). */
  inSitemap: boolean;

  /** <title> text; empty string when missing (B1 → C3.2 meta action). */
  title: string;
  /** meta description; empty string when missing. */
  metaDescription: string;

  vitals: CoreWebVitals;
  structuredData: StructuredDataBlock[];

  /** AI-crawler access verdicts parsed from robots.txt + headers (B1.6). */
  aiCrawlerAccess: Record<AiCrawler, CrawlerAccess>;

  /** Declared hreflang alternates (B1.9); empty when none. */
  hreflang: { lang: string; href: string }[];
  /** True when this page is part of an i18n cluster and thus *should* declare hreflang. */
  expectsHreflang: boolean;

  /**
   * A relative measure of how much this URL matters (traffic, conversions,
   * link equity), normalized 0-1. Drives predicted impact (B1.8). Defaults to
   * 0.5 when the crawler has no signal.
   */
  pageValue?: number;
}
