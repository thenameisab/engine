/**
 * B1.1: crawl one URL with a rendered browser and assemble the `CrawledPage`
 * record that `@engine/diagnosis`'s rule engine consumes. This is the single
 * point where every B1.x sub-check's raw signal gets captured for one page.
 */
import type { Browser, Page, Response } from 'playwright';
import type { CrawledPage } from '@engine/diagnosis';
import { installVitalsInstrumentation, collectCoreWebVitals } from './vitals.js';
import { extractStructuredData, parseJsonLdNodes } from './structuredData.js';
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
  /**
   * How long to wait for a client-rendered page to paint after `load`, ms.
   * See `waitForRenderedContent`.
   */
  renderTimeoutMs?: number;
}

export interface CrawlPageResult {
  page: CrawledPage;
  /**
   * Every absolute `<a href>` on the rendered page, deduplicated and in
   * document order. Unfiltered on purpose: deciding which of these to follow
   * is `crawlSite`'s job (same site, allowed by robots, not already seen), and
   * it needs the rejected ones to explain a crawl that reached one page.
   */
  links: string[];
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
  linkHrefs: string[];
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

  // Link discovery reads the *whole* document, not just the main content: a
  // site's navigation and footer are usually where the rest of it is linked
  // from, and B2's link-density heuristic above deliberately ignores them.
  // Capped so one page of a link farm cannot flood the crawl queue.
  const LINK_HREFS_MAX = 2_000;
  const linkEls = Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[];
  const linkHrefs = [...new Set(linkEls.map((a) => a.href))].slice(0, LINK_HREFS_MAX);

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
    linkHrefs,
  };
}

/** Default budget for `waitForRenderedContent`, ms. */
const DEFAULT_RENDER_TIMEOUT_MS = 10_000;

/** How often `waitForRenderedContent` samples the page, ms. */
const SETTLE_POLL_MS = 250;
/**
 * Consecutive identical samples that count as settled — a one-second quiet
 * window. Shorter windows were measured settling on a plateau *mid*-render:
 * tartanhq.com's contact page shows 27,156 characters and **zero** links a
 * second after `load`, and only reaches its 30 links half a second later.
 */
const SETTLE_SAMPLES = 5;
/** What `contentSignature` returns for a page that has rendered nothing yet. */
const EMPTY_SIGNATURE = '0:0';

/**
 * A cheap fingerprint of how much the page is currently showing.
 *
 * Text length *and* link count, because the two arrive separately: the same
 * page can have all its text and none of its anchors, and a crawler read at
 * that moment records a site that links nowhere.
 */
function contentSignature(): string {
  const contentEl = document.querySelector('main, article') ?? document.body;
  return `${(contentEl?.textContent ?? '').length}:${document.querySelectorAll('a[href]').length}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for a client-rendered page to finish painting before reading its DOM.
 *
 * `load` fires once the HTML document and its subresources are in, which on a
 * client-rendered site is *before* the framework has put anything on the page.
 * Production's crawl of a Framer-built site stored 515 characters of body text
 * and zero links for exactly this reason: that site's raw HTML carries no text
 * and no links at all, so `load` captured a pre-hydration shell and every
 * content finding was computed over it. Client-side rendering is the common
 * case, so this is the default and not an option.
 *
 * This measures the thing that matters — has the page stopped changing what it
 * shows — rather than inferring it from network activity. `networkidle` was
 * tried as a faster proxy and is wrong in both directions on the same site:
 * it never fires at all on tartanhq.com's home page, spending the whole
 * ten-second budget, and on its sub-pages it fires *early*, while the text is
 * up but the anchors are not, which is the original defect in a new disguise.
 *
 * Not settling is not an error. A page given the full budget has had far
 * longer than it needed to render, and reading it then is still right.
 */
async function waitForRenderedContent(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  let repeats = 0;
  while (Date.now() < deadline) {
    await sleep(SETTLE_POLL_MS);
    let signature: string;
    try {
      signature = await page.evaluate(contentSignature);
    } catch {
      return; // page navigated or closed under us — read whatever is there
    }
    if (signature !== last) {
      last = signature;
      repeats = 0;
      continue;
    }
    // A page showing nothing is not a settled page. A framework that has not
    // started rendering looks identical to one that never will, and only the
    // deadline can tell those apart — so a genuinely blank page costs the full
    // budget, which is the right trade against recording a rendered site as
    // empty.
    if (last === EMPTY_SIGNATURE) continue;
    if (++repeats >= SETTLE_SAMPLES - 1) return;
  }
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
): Promise<CrawlPageResult> {
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
    await waitForRenderedContent(page, options.renderTimeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS);

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

    const crawled: CrawledPage = {
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
      jsonLd: parseJsonLdNodes(dom.jsonLdScripts),
      aiCrawlerAccess: computeAiCrawlerAccessFromRobots(options.robotsRules, path),
      hreflang: dom.hreflang,
      expectsHreflang: options.expectsHreflang ?? dom.hreflang.length > 0,
      pageValue: options.pageValue,
      headings: dom.headings,
      bodyText: dom.bodyText,
      bodyHtml: dom.bodyHtml,
      internalLinkCount: dom.internalLinkCount,
    };
    return { page: crawled, links: dom.linkHrefs };
  } finally {
    await page.close();
  }
}
