# Engine SEO (WordPress plugin)

The WordPress side of the `'cms-plugin'` `DeployTarget` (roadmap C2.2: "CMS
plugin *or* Cloudflare Worker — no dev ticket"). See the header comment in
`engine-seo.php` for how this fits the edge-worker path (`apps/workers`) and
why the two deploy mechanisms behave differently on rollback.

## What it does

1. On an hourly WP-Cron tick (or a manual "Sync now" in **Settings → Engine
   SEO**), calls `GET /projects/:id/cms-plugin/actions?plugin=wordpress&siteId=…`
   (apps/api) for every `approved` action targeting this install.
2. Resolves each action's page URL to a WordPress post (`url_to_postid`) and
   writes the diff into that post's meta — JSON-LD for `schema` actions,
   title/description for `meta` actions.
3. Renders the stored schema via `wp_head`, and the stored title through
   `pre_get_document_title` (so it composes with the theme/SEO-plugin title
   pipeline instead of emitting a second `<title>`).
4. Reports each applied action back via `POST .../actions/:id/deploy`, the
   same transition endpoint every other deploy path uses.

## Setup

**Settings → Engine SEO**: set the Engine API base URL, the project ID, the
`siteId` this install is registered under (must match an Action's
`target.siteId`), and an API token (a bearer service credential — see
`packages/crawler`'s `ENGINE_API_TOKEN` for the same pattern on the crawl
runner side).

## Known limitation: rollback

A `rolled_back` action in Engine is not automatically reverted here. The
edge-worker path re-derives its transform from the live action set on every
request, so a rollback there takes effect on the next page load. This plugin
instead writes into WordPress's own storage once and stops watching that
action — there's no WordPress equivalent of "serve the untransformed origin
response." A rollback leaves the write in place until the next real audit
re-detects the same issue and a new fix is approved. Recommend the
edge-worker path to customers who need instant rollback.

## Verification status

This plugin's PHP has not been executed against a real WordPress install —
no WordPress runtime is available in this environment. What *is* verified
(on `wrangler dev` against live Neon): the API side this plugin depends on —
`GET .../cms-plugin/actions` correctly scopes by `plugin`+`siteId` and only
returns `approved` actions; a real generated action was approved, appeared in
the queue, and disappeared after the existing `deploy` transition was called
with a plugin-style actor. The PHP itself should be reviewed/smoke-tested
against a real WordPress site before shipping to a customer.
