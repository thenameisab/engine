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

  it('separates a spent budget from a site with nothing left to follow', async () => {
    // "Stopped at the limit" and "crawled everything there was" are different
    // stories, and only one of them means there is more site to check.
    const capped = await crawlSite(browser, server.origin + '/', { entityId: 'ent_1', maxPages: 1, delayMs: 0 });
    expect(capped.coverage.stoppedAtLimit).toBe(true);

    const complete = await crawlSite(browser, server.origin + '/', { entityId: 'ent_1', maxPages: 10, delayMs: 0 });
    expect(complete.coverage.stoppedAtLimit).toBe(false);
  }, 60_000);
});