/** Thin lifecycle wrapper around a single Playwright Chromium instance (B1.1). */
import { chromium, type Browser } from 'playwright';

export async function launchCrawlerBrowser(): Promise<Browser> {
  return chromium.launch({ headless: true });
}
