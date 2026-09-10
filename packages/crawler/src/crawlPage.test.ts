import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { parseRobotsTxt } from './robots.js';
import { crawlPage } from './crawlPage.js';
import { startTestServer, type TestServer } from './testServer.js';

describe('crawlPage (real Chromium against a local HTTP server)', () => {
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

  it('assembles a full CrawledPage from a real rendered page', async () => {
    const rules = parseRobotsTxt(''); // default-allow; robots access asserted separately below
    const sitemapUrls = new Set([`${server.origin}/`, `${server.origin}/target`]);

    const { page } = await crawlPage(browser, server.origin + '/', {
      entityId: 'ent_1',
      robotsRules: rules,
      sitemapUrls,
    });

    expect(page.statusCode).toBe(200);
    expect(page.title).toBe('Home — Test Site');
    expect(page.metaDescription).toBe('A test page for the crawler.');
    expect(page.canonical).toBe(`${server.origin}/`);
    expect(page.indexable).toBe(true);
    expect(page.inSitemap).toBe(true);
    expect(page.redirectChain).toEqual([]);
    expect(page.structuredData).toEqual([{ type: 'Organization', valid: true, errors: [] }]);
    expect(page.noindex).toBeUndefined();

    // B2 content capture (M2.1): real headings + body text off the real DOM,
    // not a fixture — this is the field `page.evaluate` silently dropped
    // (`BODY_TEXT_MAX_CHARS is not defined`) before it was inlined into the
    // evaluated function.
    expect(page.headings).toEqual([{ level: 1, text: 'Hello' }]);
    expect(page.bodyText).toContain('Hello');

    // Lab Core Web Vitals: real numbers from a real page load, not fixtures.
    expect(page.vitals.field).toBe(false);
    expect(page.vitals.lcpMs).toBeGreaterThanOrEqual(0);
    expect(page.vitals.inpMs).toBeGreaterThanOrEqual(0);
    expect(page.vitals.cls).toBeGreaterThanOrEqual(0);
  }, 30_000);

  it('follows a real redirect and records the chain', async () => {
    const rules = parseRobotsTxt('');
    const { page } = await crawlPage(browser, server.origin + '/redirect', {
      entityId: 'ent_1',
      robotsRules: rules,
      sitemapUrls: new Set(),
    });

    expect(page.statusCode).toBe(200);
    expect(page.url).toBe(`${server.origin}/target`);
    expect(page.redirectChain).toEqual([`${server.origin}/redirect`]);
  }, 30_000);

  it('detects meta-noindex from the real DOM', async () => {
    const rules = parseRobotsTxt('');
    const { page } = await crawlPage(browser, server.origin + '/noindex', {
      entityId: 'ent_1',
      robotsRules: rules,
      sitemapUrls: new Set(),
    });
    expect(page.noindex).toEqual({ source: 'meta' });
  }, 30_000);

  it('reports invalid JSON-LD as an invalid structured-data block', async () => {
    const rules = parseRobotsTxt('');
    const { page } = await crawlPage(browser, server.origin + '/broken-schema', {
      entityId: 'ent_1',
      robotsRules: rules,
      sitemapUrls: new Set(),
    });
    expect(page.structuredData).toEqual([{ type: 'Unknown', valid: false, errors: ['invalid JSON'] }]);
  }, 30_000);

  it('waits for a client-rendered page to paint before reading it', async () => {
    // The production defect this fixes: the page's HTML has no text and no
    // links until a script runs, and `load` fires before it does. Reading at
    // `load` stored a 515-character shell for a real customer's whole site.
    const rules = parseRobotsTxt('');
    const { page, links } = await crawlPage(browser, server.origin + '/client-rendered', {
      entityId: 'ent_1',
      robotsRules: rules,
      sitemapUrls: new Set(),
    });

    expect(page.headings).toEqual([{ level: 1, text: 'Rendered heading' }]);
    expect(page.bodyText).toContain('Content that only exists after hydration.');
    expect(page.internalLinkCount).toBe(1);
    expect(links).toEqual([`${server.origin}/target`]);
  }, 30_000);

  it('reports every link on the page, navigation and footer included', async () => {
    // `internalLinkCount` deliberately counts only the main content, so
    // discovery cannot be built on it — a site's nav is where the rest of it
    // is linked from.
    const rules = parseRobotsTxt('');
    const { links } = await crawlPage(browser, server.origin + '/', {
      entityId: 'ent_1',
      robotsRules: rules,
      sitemapUrls: new Set(),
    });
    expect(links).toEqual([
      `${server.origin}/target`,
      `${server.origin}/forbidden`,
      'mailto:hi@example.com',
    ]);
  }, 30_000);

  it('flags a real robots.txt AI-crawler block for the page path', async () => {
    const robotsTxt = 'User-agent: GPTBot\nDisallow: /\n';
    const rules = parseRobotsTxt(robotsTxt);
    const { page } = await crawlPage(browser, server.origin + '/target', {
      entityId: 'ent_1',
      robotsRules: rules,
      sitemapUrls: new Set(),
    });
    expect(page.aiCrawlerAccess.GPTBot).toBe('blocked');
    expect(page.aiCrawlerAccess.ClaudeBot).toBe('allowed');
  }, 30_000);
});
