# Engine SEO sync (Shopify)

The Shopify side of the `'cms-plugin'` `DeployTarget` (roadmap C2.2: "CMS
plugin *or* Cloudflare Worker — no dev ticket"). A standalone Node process
(`engine-shopify-sync`), analogous to `packages/crawler`'s `engine-crawl` —
not something that runs inside a Worker.

## What it does

1. Calls `GET /projects/:id/cms-plugin/actions?plugin=shopify&siteId=…`
   (apps/api) for every `approved` action targeting this install.
2. Resolves each action's page URL to a Shopify product (`/products/<handle>`
   → the Admin API product id via `productByHandle`) and writes the diff into
   that product's `engine_seo` metafields — `jsonld` for `schema` actions,
   `meta_title`/`meta_description` for `meta` actions.
3. Reports each applied action back via `POST .../actions/:id/deploy`, the
   same transition endpoint every other deploy path uses.

## Why metafields, not a Script Tag or theme edit

A Shopify Script Tag injects JS site-wide, not per-product JSON-LD, and a
Theme App Extension needs the merchant to place a block in their theme
editor — neither is "no dev ticket" for *this* fix. Writing to
`product.metafields.engine_seo.*` is the standard, always-available
extensibility point; the tradeoff, stated plainly: **rendering** the
metafield on the storefront still needs a one-time theme change (referencing
`product.metafields.engine_seo.jsonld` in the theme's product template), or a
future Theme App Extension. This plugin makes the data available, not
automatically visible — the same class of scope boundary as the WordPress
plugin's rollback limitation (see `plugins/wordpress/README.md`).

## Setup

```
ENGINE_API_TOKEN=<token> SHOPIFY_ACCESS_TOKEN=<token> \
  node dist/cli.js --shop my-shop.myshopify.com --project proj_1 --site site_1 --api https://api.engine.example.com
```

Run on a schedule (cron, a Shopify-hosted job) the same way `engine-crawl`
is. Both tokens come from the environment, never a flag.

## Verification status

Unlike the WordPress plugin, this is real TypeScript running in the same
Node runtime as the rest of this repo — `pnpm --filter @engine/shopify-plugin
test` exercises the full sync loop (21 tests): applying schema and
meta/title actions, skipping unresolvable products and non-product URLs
without blocking the rest of the batch, and skipping action types with no
Shopify handler rather than silently marking them deployed.

What is **not** verified: an actual call against Shopify's Admin API or a
real store. Every test mocks `fetch`; there's no Shopify dev store or access
token in this environment. The request shapes (GraphQL query text, mutation
variables, `X-Shopify-Access-Token` header) are written to match Shopify's
documented Admin API, but should be smoke-tested against a real store before
shipping to a customer — the same caveat `packages/crawler`'s working log
raised about mocked-`fetch` tests: they prove the client's shape, not that
the real API accepts it.
