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
  headings: { level: number; text: string }[];
  bodyText: string;
  bodyHtml: string;
  internalLinkCount: number;
}

function extractDomSignals(): DomSignals {
  // Cap on captured body text — B2's heuristics only need the lead content,
  // not the whole page. Inlined rather than a module-scope const:
  // `page.evaluate` serializes only this function's source, not the
  // closure it would otherwise capture — a `ReferenceError` in the browser
  // context that a Node-side unit test would never catch.
  const BODY_TEXT_MAX_CHARS = 20_000;
  // Cap on captured body markup — the internal-link fix (C3) weaves anchors
  // into it, so a few tens of KB of the lead content is plenty; the full page
  // is not worth storing.
  const BODY_HTML_MAX_CHARS = 40_000;
  const canonicalEl = document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;
  const descEl = document.querySelector('meta[name="description"]') as HTMLMetaElement | null;
  const robotsEl = document.querySelector('meta[name="robots"]') as HTMLMetaElement | null;
  const hreflangEls = Array.from(
    document.querySelectorAll('link[rel="alternate"][hreflang]'),
  ) as HTMLLinkElement[];
  const jsonLdEls = Array.from(
    document.querySelectorAll('script[type="application/ld+json"]'),
  ) as HTMLScriptElement[];
  const headingEls = Array.from(document.querySelectorAll('h1, h2, h3')) as HTMLHeadingElement[];
  // Prefer semantic main content over the whole body (nav/footer chrome adds
  // noise B2's answer-first/self-containment heuristics would misread).
  const contentEl = document.querySelector('main, article') ?? document.body;

  // Same-site links in the main content (B2 → C3 sparse-internal-linking).
  // Resolved via each anchor's `.host`, which the browser normalizes against
  // the page's base URL, so relative hrefs are counted correctly.
  const anchorEls = Array.from(contentEl?.querySelectorAll('a[href]') ?? []) as HTMLAnchorElement[];
  const internalLinkCount = anchorEls.filter((a) => a.host === location.host).length;

  return {
    title: document.title ?? '',
    metaDescription: descEl?.content ?? '',
    canonical: canonicalEl?.href ?? null,
    metaNoindex: (robotsEl?.content ?? '').toLowerCase().includes('noindex'),
    hreflang: hreflangEls.map((el) => ({ lang: el.hreflang, href: el.href })),
    jsonLdScripts: jsonLdEls.map((el) => el.textContent ?? ''),
    headings: headingEls.map((el) => ({ level: Number(el.tagName[1]), text: (el.textContent ?? '').trim() })),
    bodyText: (contentEl?.textContent ?? '').trim().slice(0, BODY_TEXT_MAX_CHARS),
    bodyHtml: (contentEl?.innerHTML ?? '').slice(0, BODY_HTML_MAX_CHARS),
    internalLinkCount,
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
      headings: dom.headings,
      bodyText: dom.bodyText,
      bodyHtml: dom.bodyHtml,
      internalLinkCount: dom.internalLinkCount,
    };
  } finally {
    await page.close();
  }
}
