/**
 * B1.1: crawl one URL with a rendered browser and assemble the `CrawledPage`
 * record that `@engine/diagnosis`'s rule engine consumes. This is the single
 * point where every B1.x sub-check's raw signal gets captured for one page.
 */
import type { Browser, Response } from 'playwright';
import type { CrawledPage } from '@engine/diagnosis';
import { installVitalsInstrumentation, collectCoreWebVitals } from './vitals.js';
import { extractStructuredData } from './structuredData.js';
import { computeAiCrawlerAccessFromRobots, isAllowed, type RobotsRules } from './robots.js';
import { normalizeUrl } from './sitemap.js';

export interface CrawlPageOptions {
  /** Entity this URL resolves to (§5 entity linkage). */
  entityId: string;
  /** Parsed robots.txt for the site (B1.6 + robots-level noindex signal). */
  robotsRules: RobotsRules;
  /** Every URL declared across the site's sitemap(s) (B1.3), pre-fetched once per crawl. */
  sitemapUrls: Set<string>;
  /** Whether this URL is expected to declare hreflang alternates (B1.9) — caller's i18n config, not observable from one fetch. */
  expectsHreflang?: boolean;
  /** Relative page-value signal (B1.8), if the caller has one (traffic/conversions/link equity). */
  pageValue?: number;
  /** Navigation timeout, ms. */
  timeoutMs?: number;
}

interface DomSignals {
  title: string;
  metaDescription: string;
  canonical: string | null;
  metaNoindex: boolean;
  hreflang: { lang: string; href: string }[];
  jsonLdScripts: string[];
}

function extractDomSignals(): DomSignals {
  const canonicalEl = document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;
  const descEl = document.querySelector('meta[name="description"]') as HTMLMetaElement | null;
  const robotsEl = document.querySelector('meta[name="robots"]') as HTMLMetaElement | null;
  const hreflangEls = Array.from(
    document.querySelectorAll('link[rel="alternate"][hreflang]'),
  ) as HTMLLinkElement[];
  const jsonLdEls = Array.from(
    document.querySelectorAll('script[type="application/ld+json"]'),
  ) as HTMLScriptElement[];

  return {
    title: document.title ?? '',
    metaDescription: descEl?.content ?? '',
    canonical: canonicalEl?.href ?? null,
    metaNoindex: (robotsEl?.content ?? '').toLowerCase().includes('noindex'),
    hreflang: hreflangEls.map((el) => ({ lang: el.hreflang, href: el.href })),
    jsonLdScripts: jsonLdEls.map((el) => el.textContent ?? ''),
  };
}

/** Walk Playwright's `redirectedFrom()` chain back to the origin, oldest-first. */
function buildRedirectChain(response: Response): string[] {
  const chain: string[] = [];
  let redirected = response.request().redirectedFrom();
  while (redirected) {
    chain.unshift(redirected.url());
    redirected = redirected.redirectedFrom();
  }
  return chain;
}

export async function crawlPage(
  browser: Browser,
  url: string,
  options: CrawlPageOptions,
): Promise<CrawledPage> {
  const page = await browser.newPage({ userAgent: 'EngineBot/1.0 (+https://engine.dev/bot)' });
  await installVitalsInstrumentation(page);

  try {
    const response = await page.goto(url, {
      waitUntil: 'load',
      timeout: options.timeoutMs ?? 30_000,
    });
    if (!response) {
      throw new Error(`No response received for ${url}`);
    }

    const statusCode = response.status();
    const redirectChain = buildRedirectChain(response);
    const headers = response.headers();
    const finalUrl = normalizeUrl(page.url());

    const dom = await page.evaluate(extractDomSignals);
    const vitals = await collectCoreWebVitals(page);

    const canonical = dom.canonical ? normalizeUrl(dom.canonical) : undefined;
    const indexable = !canonical || canonical === finalUrl;

    const headerNoindex = (headers['x-robots-tag'] ?? '').toLowerCase().includes('noindex');
    const path = new URL(finalUrl).pathname;
    const robotsDisallowsGeneric = !isAllowed(options.robotsRules, '*', path);

    const noindex: CrawledPage['noindex'] = headerNoindex
      ? { source: 'header' }
      : dom.metaNoindex
        ? { source: 'meta' }
        : robotsDisallowsGeneric
          ? { source: 'robots' }
          : undefined;

    return {
      url: finalUrl,
      entityId: options.entityId,
      statusCode,
      redirectChain,
      canonical,
      indexable,
      noindex,
      inSitemap: options.sitemapUrls.has(finalUrl),
      title: dom.title,
      metaDescription: dom.metaDescription,
      vitals,
      structuredData: extractStructuredData(dom.jsonLdScripts),
      aiCrawlerAccess: computeAiCrawlerAccessFromRobots(options.robotsRules, path),
      hreflang: dom.hreflang,
      expectsHreflang: options.expectsHreflang ?? dom.hreflang.length > 0,
      pageValue: options.pageValue,
    };
  } finally {
    await page.close();
  }
}
