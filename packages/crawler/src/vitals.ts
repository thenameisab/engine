/**
 * B1.2 Core Web Vitals — lab measurement via Playwright + the real
 * PerformanceObserver APIs (no CrUX/field data available to a one-shot
 * crawl, so `field` is always `false` here; a caller with GSC/CrUX access
 * can merge field data in afterward).
 *
 * INP strictly requires real user interactions; a lab crawl has none, so we
 * dispatch one synthetic click after load and use its event-processing
 * duration as a documented proxy (the same trick Lighthouse's lab TBT/INP
 * approximations use).
 */
import type { Page } from 'playwright';
import type { CoreWebVitals } from '@engine/diagnosis';

declare global {
  interface Window {
    __engineVitals?: { lcp: number; cls: number; events: number[] };
  }
}

/** Call once on a fresh page, before navigation, so LCP/CLS observers see the whole load. */
export async function installVitalsInstrumentation(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__engineVitals = { lcp: 0, cls: 0, events: [] };
    try {
      new PerformanceObserver((list) => {
        const entries = list.getEntries() as PerformanceEntry[];
        const last = entries[entries.length - 1] as
          | (PerformanceEntry & { renderTime?: number; loadTime?: number })
          | undefined;
        if (last) window.__engineVitals!.lcp = last.renderTime || last.loadTime || 0;
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    } catch {
      /* unsupported in this engine build */
    }
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as (PerformanceEntry & {
          hadRecentInput?: boolean;
          value?: number;
        })[]) {
          if (!entry.hadRecentInput) window.__engineVitals!.cls += entry.value ?? 0;
        }
      }).observe({ type: 'layout-shift', buffered: true });
    } catch {
      /* unsupported in this engine build */
    }
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as (PerformanceEntry & { duration: number })[]) {
          window.__engineVitals!.events.push(entry.duration);
        }
      }).observe({ type: 'event', buffered: true, durationThreshold: 0 } as PerformanceObserverInit);
    } catch {
      /* unsupported in this engine build */
    }
  });
}

/** Call after the page has settled (loaded). Simulates one interaction, then reads the metrics. */
export async function collectCoreWebVitals(page: Page): Promise<CoreWebVitals> {
  try {
    await page.mouse.click(5, 5);
  } catch {
    /* a page with no visible content at that point can't be clicked; INP stays 0 */
  }
  await page.waitForTimeout(150);

  const raw = await page.evaluate(() => window.__engineVitals ?? { lcp: 0, cls: 0, events: [] });
  const inpMs = raw.events.length > 0 ? Math.max(...raw.events) : 0;
  return { lcpMs: Math.round(raw.lcp), inpMs: Math.round(inpMs), cls: raw.cls, field: false };
}
