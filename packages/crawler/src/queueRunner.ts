#!/usr/bin/env node
/**
 * The scheduled crawl runner. Drains the API's audit-request queue once and
 * exits; GitHub Actions (or any scheduler) runs it on a timer and on demand.
 *
 * Env:
 *   ENGINE_API_BASE   the API origin, e.g. https://engine-api.example.workers.dev
 *   ENGINE_API_TOKEN  the API's INTERNAL_API_TOKEN (service credential)
 */
import { launchCrawlerBrowser } from './browser.js';
import { crawlSite } from './crawlSite.js';
import { reportCrawlToApi } from './report.js';
import { createQueueApi, runQueue, type QueuedRequest } from './runQueue.js';

async function main(): Promise<void> {
  const apiBaseUrl = process.env.ENGINE_API_BASE;
  const token = process.env.ENGINE_API_TOKEN;
  if (!apiBaseUrl || !token) {
    console.error('ENGINE_API_BASE and ENGINE_API_TOKEN must both be set.');
    process.exit(1);
  }

  const api = createQueueApi({ apiBaseUrl, token });
  const queued = await api.listQueued();
  if (queued.length === 0) {
    console.log('Queue is empty.');
    return;
  }

  // One browser for the whole pass; launching Chromium is the slow part.
  const browser = await launchCrawlerBrowser();
  try {
    const result = await runQueue(
      { ...api, listQueued: async () => queued },
      async (request: QueuedRequest) => {
        const pages = await crawlSite(browser, request.rootUrl, { entityId: request.entityId, maxPages: request.maxPages });
        const report = (await reportCrawlToApi(pages, { apiBaseUrl, projectId: request.projectId, token })) as { run?: { id?: string } };
        const auditRunId = report.run?.id;
        if (!auditRunId) throw new Error('the audit report did not return a run id');
        return { pagesCrawled: pages.length, auditRunId };
      },
      (line) => console.log(line),
    );
    console.log(`Pass complete: ${result.claimed} claimed, ${result.done} done, ${result.failed} failed.`);
    if (result.failed > 0) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
