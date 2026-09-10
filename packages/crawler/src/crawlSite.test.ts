import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { crawlSite } from './crawlSite.js';
import { startTestServer, type TestServer } from './testServer.js';

describe('crawlSite (real Chromium + a local HTTP server, real robots.txt/sitemap.xml)', () => {
  let browser: Browser;
  let server: TestServer;

  beforeAll(async () => {
    browser = await chromium.launch();
    server = await startTestServer();
  }, 60_000);

  afterAll(async () => {
    await browser.close();
    await server.close();
  });

  it('discovers same-origin links and respects the real robots.txt Disallow', async () => {
    const { pages } = await crawlSite(browser, server.origin + '/', {
      entityId: 'ent_1',
      maxPages: 10,
      delayMs: 0,
    });

    const urls = pages.map((p) => p.url).sort();
    expect(urls).toEqual([`${server.origin}/`, `${server.origin}/target`]);
    // /forbidden is linked from the homepage but disallowed by robots.txt for '*'.
    expect(urls).not.toContain(`${server.origin}/forbidden`);
  }, 60_000);

  it('crawls only the given seed URLs when provided, skipping discovery', async () => {
    const { pages } = await crawlSite(browser, server.origin + '/', {
      entityId: 'ent_1',
      seedUrls: [server.origin + '/target'],
      delayMs: 0,
    });
    expect(pages.map((p) => p.url)).toEqual([`${server.origin}/target`]);
  }, 30_000);

  it('honors the maxPages budget cap', async () => {
    const { pages } = await crawlSite(browser, server.origin + '/', {
      entityId: 'ent_1',
      maxPages: 1,
      delayMs: 0,
    });
    expect(pages).toHaveLength(1);
  }, 30_000);

  it('marks pages found via the real sitemap.xml as inSitemap', async () => {
    const { pages } = await crawlSite(browser, server.origin + '/', {
      entityId: 'ent_1',
      maxPages: 10,
      delayMs: 0,
    });
    const home = pages.find((p) => p.url === `${server.origin}/`);
    expect(home?.inSitemap).toBe(true);
  }, 60_000);

  it('reports what it could reach, including the robots.txt it was refused', async () => {
    // Production's last crawl audited one page and nothing said why. These
    // numbers are the "why", and they are read straight onto the Audit screen.
    const { coverage } = await crawlSite(browser, server.origin + '/', {
      entityId: 'ent_1',
      maxPages: 10,
      delayMs: 0,
    });
    expect(coverage.robotsFound).toBe(true);
    expect(coverage.sitemapUrls).toBeGreaterThan(0);
    expect(coverage.linksDiscovered).toBeGreaterThan(0);
    expect(coverage.pagesCrawled).toBe(2);
    expect(coverage.stoppedAtLimit).toBe(false);
    expect(coverage.maxPages).toBe(10);
  }, 60_000);

  it('follows links on the host that answered, not the host that was asked for', async () => {
    // tartanhq.com 301s to www.tartanhq.com. The same-origin test read the
    // seed URL, so every link on the page it got back — all written against
    // www — was discarded as off-origin and discovery found nothing.
    // `localhost` and `127.0.0.1` are the same two-origins-one-site shape.
    const { pages, coverage } = await crawlSite(browser, server.origin + '/moved', {
      entityId: 'ent_1',
      maxPages: 10,
      delayMs: 0,
    });

    const urls = pages.map((p) => p.url).sort();
    expect(urls).toEqual([`${server.altOrigin}/`, `${server.altOrigin}/target`]);
    expect(coverage.linksDiscovered).toBeGreaterThan(0);
  }, 60_000);

  it('does not crawl the root twice when the seed redirects', async () => {
    // The root is reached as the seed URL and again as a link to its own final
    // address. Those are two different strings and one page.
    const { pages } = await crawlSite(browser, server.origin + '/moved', {
      entityId: 'ent_1',
      maxPages: 10,
      delayMs: 0,
    });
    expect(pages.filter((p) => p.url === `${server.altOrigin}/`)).toHaveLength(1);
  }, 60_000);

  it('discovers a client-rendered page\'s links', async () => {
    // A crawl seeded at a page that renders itself must still find the rest of
    // the site — discovery used to re-fetch the page and read it at `load`,
    // which is the same defect one layer down.
    const { pages } = await crawlSite(browser, server.origin + '/client-rendered', {
      entityId: 'ent_1',
      maxPages: 10,
      delayMs: 0,
    });
    expect(pages.map((p) => p.url).sort()).toEqual([
      `${server.origin}/client-rendered`,
      `${server.origin}/target`,
    ]);
  }, 60_000);

  /**
   * The defect this pair exists to stop, measured in production on
   * 2026-09-10: the crawl stored CloudFront's 403 page as tartanhq.com's
   * homepage and B2 reported five content findings and a health score of 45
   * over it. An error page is not the site, and page one is the page every
   * downstream step treats as the homepage.
   */
  it('refuses the crawl when the root answers non-2xx, naming the status', async () => {
    await expect(
      crawlSite(browser, server.origin + '/blocked', { entityId: 'ent_1', maxPages: 10, delayMs: 0 }),
    ).rejects.toThrow(/answered 403/);
  }, 60_000);

  it('keeps a discovered page that 404s, with its status, rather than failing the crawl', async () => {
    // The opposite case, and the reason the refusal is root-only: a broken
    // internal link is a real finding about the customer's own site.
    const { pages } = await crawlSite(browser, server.origin + '/has-broken-link', {
      entityId: 'ent_1',
      maxPages: 10,
      delayMs: 0,
    });
    const gone = pages.find((p) => p.url === `${server.origin}/gone`);
    expect(gone).toBeDefined();
    expect(gone!.statusCode).toBe(404);
    expect(pages[0].statusCode).toBe(200);
  }, 60_000);

  it('separates a spent budget from a site with nothing left to follow', async () => {
    // "Stopped at the limit" and "crawled everything there was" are different
    // stories, and only one of them means there is more site to check.
    const capped = await crawlSite(browser, server.origin + '/', { entityId: 'ent_1', maxPages: 1, delayMs: 0 });
    expect(capped.coverage.stoppedAtLimit).toBe(true);

    const complete = await crawlSite(browser, server.origin + '/', { entityId: 'ent_1', maxPages: 10, delayMs: 0 });
    expect(complete.coverage.stoppedAtLimit).toBe(false);
  }, 60_000);
});