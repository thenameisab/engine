/**
 * B1.1 site-level orchestration: fetch robots.txt + sitemap(s) once, then
 * crawl either an explicit URL list or a same-site BFS discovery, subject
 * to a per-project budget cap and a politeness delay between requests
 * (spec §9 — "crawler politeness ... is mandatory").
 */
import type { Browser } from 'playwright';
import type { CrawledPage } from '@engine/diagnosis';
import { parseRobotsTxt, isAllowed, type RobotsRules } from './robots.js';
import { fetchSitemapUrls, extractSitemapDeclarations, normalizeUrl } from './sitemap.js';
import { crawlPage } from './crawlPage.js';

export interface CrawlSiteOptions {
  entityId: string;
  /** Explicit URLs to crawl. If omitted, BFS-discovers same-site links starting at `rootUrl`. */
  seedUrls?: string[];
  /** Hard cap on pages crawled in this run (spec: 100k/project MVP default; enterprise lifts it). */
  maxPages?: number;
  /** Delay between requests, ms — politeness / rate-limiting. */
  delayMs?: number;
  /** URL-pattern predicate for whether a page is expected to declare hreflang (B1.9). Defaults to never expected. */
  expectsHreflang?: (url: string) => boolean;
  /** Per-URL relative page-value signal (B1.8), if the caller has one. */
  pageValue?: (url: string) => number | undefined;
}

/**
 * What the crawl could reach, as opposed to what it found wrong.
 *
 * Production's last crawl audited **one page**, and nothing on any screen said
 * so: the Audit view showed a thin finding list, which reads as "your site is
 * nearly clean" when it actually means "we only ever saw your home page". A
 * crawl that reaches one page is itself the first thing to report, and the
 * reader needs the reason — no sitemap, no followable links, robots.txt in the
 * way, or a budget that ran out — not just the number.
 */
export interface CrawlCoverage {
  /** Whether robots.txt was reachable at all. False means default-allow. */
  robotsFound: boolean;
  /** URLs declared across every sitemap that could be read. 0 means none was. */
  sitemapUrls: number;
  /** Distinct same-site links found by following pages. 0 on a seeded crawl. */
  linksDiscovered: number;
  /** Pages actually fetched and audited. */
  pagesCrawled: number;
  /** URLs skipped because robots.txt disallowed them. */
  blockedByRobots: number;
  /** True when the page budget ran out with URLs still queued. */
  stoppedAtLimit: boolean;
  /** The budget this run was given, so "stopped at the limit" names a number. */
  maxPages: number;
}

export interface CrawlSiteResult {
  pages: CrawledPage[];
  coverage: CrawlCoverage;
}

const DEFAULT_MAX_PAGES = 100_000;
const DEFAULT_DELAY_MS = 250;

/** 2xx only. A redirect has already been followed by the time we see a status. */
function isSuccess(statusCode: number): boolean {
  return statusCode >= 200 && statusCode < 300;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchRobotsRulesAndSitemaps(
  origin: string,
): Promise<{ rules: RobotsRules; sitemapUrls: Set<string>; robotsFound: boolean }> {
  let robotsText = '';
  let robotsFound = false;
  try {
    const res = await fetch(new URL('/robots.txt', origin));
    if (res.ok) {
      robotsText = await res.text();
      robotsFound = true;
    }
  } catch {
    /* no robots.txt reachable — default-allow everything */
  }
  const rules = parseRobotsTxt(robotsText);

  const declared = extractSitemapDeclarations(robotsText);
  // Sitemap: directives should be absolute per spec, but resolve relative to
  // origin defensively — some real-world robots.txt files get this wrong.
  const sitemapCandidates =
    declared.length > 0
      ? declared.map((d) => new URL(d, origin).toString())
      : [new URL('/sitemap.xml', origin).toString()];

  const sitemapUrls = new Set<string>();
  for (const candidate of sitemapCandidates) {
    const found = await fetchSitemapUrls(candidate);
    for (const url of found) sitemapUrls.add(url);
  }
  return { rules, sitemapUrls, robotsFound };
}

/**
 * The host that identifies a site, with any leading `www.` removed.
 *
 * Apex and `www` are the same site to everyone except a string comparison.
 * `tartanhq.com` redirects to `www.tartanhq.com`, so an exact-origin test
 * rejected every internal link the rendered page carried and discovery found
 * nothing at all.
 */
function siteHostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

/** Which of a page's links belong to this site and may be followed. */
function sameSiteLinks(hrefs: readonly string[], siteHost: string, rules: RobotsRules): string[] {
  const seen = new Set<string>();
  const links: string[] = [];
  for (const href of hrefs) {
    let u: URL;
    try {
      u = new URL(href);
    } catch {
      continue;
    }
    // `mailto:`, `tel:` and `javascript:` are links a browser resolves happily
    // and a crawler cannot fetch.
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
    if (siteHostOf(u.href) !== siteHost) continue;
    u.hash = '';
    const normalized = normalizeUrl(u.toString());
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    if (!isAllowed(rules, '*', u.pathname)) continue;
    links.push(normalized);
  }
  return links;
}

export async function crawlSite(
  browser: Browser,
  rootUrl: string,
  options: CrawlSiteOptions,
): Promise<CrawlSiteResult> {
  const origin = new URL(rootUrl).origin;
  const { rules, sitemapUrls, robotsFound } = await fetchRobotsRulesAndSitemaps(origin);
  // Provisional: the seed says which site we were *asked* for. The root page's
  // final URL says which one actually answered, and that is the one every
  // link on it will be written against. Corrected below, after the first page.
  let siteHost = siteHostOf(rootUrl);

  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const discover = !options.seedUrls || options.seedUrls.length === 0;

  const queue = [...(options.seedUrls ?? [rootUrl])];
  const visited = new Set<string>();
  const pages: CrawledPage[] = [];
  const discovered = new Set<string>();
  let blockedByRobots = 0;
  // True when the budget ran out *before* the crawler looked for more links.
  // Without this the run reports "0 links followed", which reads as "your page
  // links nowhere" when the truth is that nobody looked.
  let discoveryCutShort = false;

  while (queue.length > 0 && pages.length < maxPages) {
    const url = queue.shift()!;
    const normalized = normalizeUrl(url);
    if (visited.has(normalized)) continue;
    visited.add(normalized);

    if (!isAllowed(rules, '*', new URL(url).pathname)) {
      blockedByRobots += 1;
      continue;
    }

    const { page, links: hrefs } = await crawlPage(browser, url, {
      entityId: options.entityId,
      robotsRules: rules,
      sitemapUrls,
      expectsHreflang: options.expectsHreflang?.(url),
      pageValue: options.pageValue?.(url),
    });
    // An error page is not the site. Refuse the whole crawl when the *root*
    // answers non-2xx, because everything downstream treats page one as the
    // customer's homepage: B2 scores it, the health score is computed from it,
    // and `entities.urls` records the origin that served it.
    //
    // Measured on 2026-09-10: tartanhq.com's apex is behind a CloudFront WAF
    // that answers 403 to the GitHub Actions runner while answering 301 from
    // a residential IP. The crawl stored 515 characters of "403 ERROR /
    // Request blocked" as the homepage and reported five content findings and
    // a health score of 45 over it — a confident wrong answer, for a day,
    // with nothing in the row to reveal it.
    //
    // Thrown rather than returned: `runQueue` already turns an exception into
    // `finish(id, { error })`, so the request lands as `failed` with this
    // sentence attached. A failed audit is recoverable; a plausible-looking
    // audit of an error page is not.
    //
    // Only the root. A discovered page that 404s is a real finding about the
    // site's own links, so those are kept, stored with their status, and left
    // for the rules to judge.
    if (pages.length === 0 && !isSuccess(page.statusCode)) {
      throw new Error(
        `the root page ${page.url} answered ${page.statusCode}, so there is no site to audit. ` +
          "A crawl of an error page would be scored as the customer's own content.",
      );
    }

    pages.push(page);
    // A redirect means the URL we asked for and the URL we got are different
    // strings. Both are visited now, or the root gets crawled a second time
    // the moment discovery finds a link to its own final address.
    visited.add(page.url);
    if (pages.length === 1) siteHost = siteHostOf(page.url);

    if (discover && pages.length >= maxPages) discoveryCutShort = true;
    if (discover && pages.length < maxPages) {
      const links = sameSiteLinks(hrefs, siteHost, rules);
      for (const link of links) {
        discovered.add(link);
        if (!visited.has(link)) queue.push(link);
      }
    }

    if (queue.length > 0 && pages.length < maxPages) await sleep(delayMs);
  }

  return {
    pages,
    coverage: {
      robotsFound,
      sitemapUrls: sitemapUrls.size,
      linksDiscovered: discovered.size,
      pagesCrawled: pages.length,
      blockedByRobots,
      // Only a budget that ran out counts. A queue emptied because there was
      // nothing left to follow is a complete crawl of a small site, and saying
      // it "stopped at the limit" would be a different, wrong story. A budget
      // that expired before discovery ran counts too: the crawler stopped
      // short, it just never got as far as queueing what it missed.
      stoppedAtLimit: pages.length >= maxPages && (queue.length > 0 || discoveryCutShort),
      maxPages,
    },
  };
}
