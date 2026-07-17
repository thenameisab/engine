#!/usr/bin/env node
/**
 * Standalone crawl runner — the process that actually executes B1.1 off-edge
 * (a Cloudflare Worker can't launch a browser). Crawls a site, then POSTs the
 * result to an already-running `apps/api` instance's `/projects/:id/audit`.
 *
 * Usage:
 *   ENGINE_API_TOKEN=<token> \
 *     engine-crawl --url https://example.com --project proj_1 --entity ent_1 --api http://localhost:8787
 *
 * The token is read from the environment, never a flag: argv is world-readable
 * through `ps` and lands in shell history, and this one is the API's shared
 * service credential.
 */
import { launchCrawlerBrowser } from './browser.js';
import { crawlSite } from './crawlSite.js';
import { reportCrawlToApi } from './report.js';

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith('--')) continue;
    args[key.slice(2)] = argv[i + 1] ?? '';
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { url, project, entity, api } = args;
  if (!url || !project || !entity || !api) {
    console.error('Usage: engine-crawl --url <rootUrl> --project <projectId> --entity <entityId> --api <apiBaseUrl>');
    console.error('Env:   ENGINE_API_TOKEN  the API\'s INTERNAL_API_TOKEN (omit only for a local AUTH_MODE=disabled API)');
    process.exit(1);
  }

  const token = process.env.ENGINE_API_TOKEN;
  if (!token) {
    // Warn but continue: a local API with AUTH_MODE=disabled is a legitimate
    // target. Warning up front beats discovering it after the crawl spends
    // minutes of browser time.
    console.warn('ENGINE_API_TOKEN is not set — the report will be rejected unless the API runs with AUTH_MODE=disabled.');
  }

  const browser = await launchCrawlerBrowser();
  try {
    const maxPages = args['max-pages'] ? Number(args['max-pages']) : undefined;
    console.log(`Crawling ${url} (entity ${entity})...`);
    const pages = await crawlSite(browser, url, { entityId: entity, maxPages });
    console.log(`Crawled ${pages.length} page(s). Reporting to ${api}...`);
    const result = await reportCrawlToApi(pages, { apiBaseUrl: api, projectId: project, token });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
