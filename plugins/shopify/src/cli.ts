#!/usr/bin/env node
/**
 * Standalone Shopify sync runner — the Shopify side of the 'cms-plugin'
 * DeployTarget (C2.2), analogous to `packages/crawler`'s `engine-crawl`: a
 * scheduled process (cron / a Shopify-hosted job), not something that runs
 * inside a Worker. Pulls `approved` shopify-targeted actions and writes them
 * into product metafields (see shopifyAdmin.ts for why metafields, not a
 * Script Tag or theme edit).
 *
 * Usage:
 *   ENGINE_API_TOKEN=<token> SHOPIFY_ACCESS_TOKEN=<token> \
 *     engine-shopify-sync --shop my-shop.myshopify.com --project proj_1 \
 *       --site site_1 --api http://localhost:8787
 *
 * Both tokens come from the environment, never a flag — same reasoning as
 * the crawl runner: argv is `ps`-readable and lands in shell history.
 */
import { syncActions } from './sync.js';

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
  const { shop, project, site, api } = args;
  if (!shop || !project || !site || !api) {
    console.error('Usage: engine-shopify-sync --shop <shop.myshopify.com> --project <projectId> --site <siteId> --api <apiBaseUrl>');
    console.error('Env:   ENGINE_API_TOKEN       the Engine API bearer token');
    console.error('       SHOPIFY_ACCESS_TOKEN    the Shopify Admin API access token for --shop');
    process.exit(1);
  }

  const engineToken = process.env.ENGINE_API_TOKEN;
  const shopifyToken = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!engineToken || !shopifyToken) {
    console.error('Both ENGINE_API_TOKEN and SHOPIFY_ACCESS_TOKEN must be set in the environment.');
    process.exit(1);
  }

  const result = await syncActions(
    { apiBase: api, projectId: project, siteId: site, apiToken: engineToken },
    { shopDomain: shop, accessToken: shopifyToken },
  );

  console.log(`Applied ${result.applied.length} action(s): ${result.applied.join(', ') || '(none)'}`);
  if (result.skipped.length > 0) {
    console.log('Skipped:');
    for (const s of result.skipped) console.log(`  ${s.actionId}: ${s.reason}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
