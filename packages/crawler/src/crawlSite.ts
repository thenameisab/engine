/**
 * B1.1 site-level orchestration: fetch robots.txt + sitemap(s) once, then
 * crawl either an explicit URL list or a same-origin BFS discovery, subject
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
  /** Explicit URLs to crawl. If omitted, BFS-discovers same-origin links starting at `rootUrl`. */
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

const DEFAULT_MAX_PAGES = 100_000;
const DEFAULT_DELAY_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchRobotsRulesAndSitemaps(
  origin: string,
): Promise<{ rules: RobotsRules; sitemapUrls: Set<string> }> {
  let robotsText = '';
  try {
    const res = await fetch(new URL('/robots.txt', origin));
    if (res.ok) robotsText = await res.text();
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
  return { rules, sitemapUrls };
}

/** Extract same-origin `<a href>` targets from an already-crawled page's live DOM, respecting robots. */
async function discoverLinks(
  browser: Browser,
  fromUrl: string,
  rules: RobotsRules,
): Promise<string[]> {
  const page = await browser.newPage();
  try {
    await page.goto(fromUrl, { waitUntil: 'load', timeout: 30_000 });
    const hrefs = await page.$$eval('a[href]', (els) => els.map((el) => (el as HTMLAnchorElement).href));
    const origin = new URL(fromUrl).origin;
    const seen = new Set<string>();
    const links: string[] = [];
    for (const href of hrefs) {
      let u: URL;
      try {
        u = new URL(href);
      } catch {
        continue;
      }
      if (u.origin !== origin) continue;
      u.hash = '';
      const normalized = normalizeUrl(u.toString());
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      if (!isAllowed(rules, '*', u.pathname)) continue;
      links.push(normalized);
    }
    return links;
  } finally {
    await page.close();
  }
}

export async function crawlSite(
  browser: Browser,
  rootUrl: string,
  options: CrawlSiteOptions,
): Promise<CrawledPage[]> {
  const origin = new URL(rootUrl).origin;
  const { rules, sitemapUrls } = await fetchRobotsRulesAndSitemaps(origin);

  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const discover = !options.seedUrls || options.seedUrls.length === 0;

  const queue = [...(options.seedUrls ?? [rootUrl])];
  const visited = new Set<string>();
  const pages: CrawledPage[] = [];

  while (queue.length > 0 && pages.length < maxPages) {
    const url = queue.shift()!;
    const normalized = normalizeUrl(url);
    if (visited.has(normalized)) continue;
    visited.add(normalized);

    if (!isAllowed(rules, '*', new URL(url).pathname)) continue;

    const page = await crawlPage(browser, url, {
      entityId: options.entityId,
      robotsRules: rules,
      sitemapUrls,
      expectsHreflang: options.expectsHreflang?.(url),
      pageValue: options.pageValue?.(url),
    });
    pages.push(page);

    if (discover && pages.length < maxPages) {
      const links = await discoverLinks(browser, page.url, rules);
      for (const link of links) if (!visited.has(link)) queue.push(link);
    }

    if (queue.length > 0 && pages.length < maxPages) await sleep(delayMs);
  }

  return pages;
}
