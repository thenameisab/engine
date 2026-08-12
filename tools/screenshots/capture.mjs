/**
 * Portfolio screenshot capture.
 *
 * Drives the real, built dashboard (apps/dashboard/site) in Chromium against
 * tools/screenshots/demo-api.mjs and writes retina PNGs to public/screenshots.
 * Nothing here is part of the product — it exists so the public repo can show
 * the actual UI rather than mockups.
 *
 * Prereqs: pnpm --filter @engine/dashboard build, then
 *   node tools/screenshots/demo-api.mjs 8788 &
 *   node tools/screenshots/serve.mjs 8787 &
 *   node tools/screenshots/capture.mjs
 */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SITE = process.env.SITE_URL ?? 'http://127.0.0.1:8787';
const API = process.env.API_URL ?? 'http://127.0.0.1:8788';
const OUT = process.env.OUT_DIR ?? join(process.cwd(), 'public', 'screenshots');
const EXE = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

mkdirSync(OUT, { recursive: true });

const session = {
  'engine.session': JSON.stringify({ name: 'Aditya Gaur', email: 'demo@northwindroasters.com', provider: 'google' }),
  'engine.apiBaseUrl': API,
  'engine.projectId': 'demo',
  'engine.accountId': 'acc_northwind',
};

const SHOTS = [
  { name: '01-pulse', route: 'pulse' },
  { name: '02-fix-queue', route: 'fix-queue' },
  { name: '03-audit', route: 'audit' },
  { name: '04-entity-graph', route: 'entity-graph' },
  { name: '05-competitors', route: 'competitors' },
  { name: '06-backlinks', route: 'offsite' },
  { name: '07-local', route: 'local' },
  { name: '08-clients', route: 'clients' },
  { name: '09-serp', route: 'serp' },
  // Settings' interesting half is the integrations readiness grid; the API-base
  // form above it is just a localhost URL in a capture run.
  { name: '10-integrations', route: 'settings', clip: '.summary-row', clipEnd: '.intg-grid' },
];

const browser = await chromium.launch({ executablePath: EXE });
const ctx = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
});
await ctx.addInitScript((s) => {
  for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v);
}, session);

const page = await ctx.newPage();

/**
 * Fit the viewport to the view's own content before capturing. A fixed tall
 * viewport leaves half of a short view (Pulse, Settings) as empty background,
 * which reads as an unfinished screen rather than a compact one.
 */
async function fitAndShoot(p, shot) {
  const h = await p.evaluate(() => {
    const main = document.querySelector('main') ?? document.body;
    return Math.ceil(main.getBoundingClientRect().bottom + 40);
  });
  await p.setViewportSize({ width: 1600, height: Math.min(2600, Math.max(760, h)) });
  await p.waitForTimeout(400);

  let clip;
  if (shot.clip) {
    clip = await p.evaluate(([a, b]) => {
      const top = document.querySelector(a).getBoundingClientRect();
      const bottom = document.querySelector(b).getBoundingClientRect();
      const pad = 28;
      return {
        x: Math.max(0, top.left - pad),
        y: Math.max(0, top.top - pad),
        width: Math.max(top.width, bottom.width) + pad * 2,
        height: bottom.bottom - top.top + pad * 2,
      };
    }, [shot.clip, shot.clipEnd]);
  }

  await p.screenshot({ path: join(OUT, `${shot.name}.png`), ...(clip ? { clip } : {}) });
  console.log(`✓ ${shot.name}`);
}

/** Views that only show their interesting state after the user does something. */
const SETUP = {
  '09-serp': async (p) => {
    await p.fill('input[placeholder^="keyword"]', 'best single origin coffee subscription');
    await p.fill('input[placeholder^="your domain"]', 'northwindroasters.com');
    await p.click('button:has-text("Check SERP")');
    await p.waitForSelector('.serp-organic', { timeout: 10_000 });
  },
};

for (const shot of SHOTS) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`${SITE}/app/#/${shot.route}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await SETUP[shot.name]?.(page);
  await page.waitForTimeout(600);
  await fitAndShoot(page, shot);
}

/* The sign-in screen: same app, no session. */
const clean = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, colorScheme: 'dark' });
const cleanPage = await clean.newPage();
await cleanPage.goto(`${SITE}/app/`, { waitUntil: 'networkidle' });
await cleanPage.waitForTimeout(1500);
await cleanPage.screenshot({ path: join(OUT, '00-sign-in.png') });
console.log('✓ 00-sign-in');

/* Landing page + public docs (apps/web, assembled into the same site). */
for (const [name, path] of [
  ['11-landing', '/'],
  ['12-docs', '/docs/'],
]) {
  await cleanPage.goto(`${SITE}${path}`, { waitUntil: 'networkidle' });
  await cleanPage.waitForTimeout(800);
  await cleanPage.screenshot({ path: join(OUT, `${name}.png`), fullPage: false });
  console.log(`✓ ${name}`);
}

await browser.close();
console.log(`\nWrote ${SHOTS.length + 3} screenshots to ${OUT}`);
