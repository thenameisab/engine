# @engine/crawler

The B1.1 crawler, and the standalone runner that reports its results to
`apps/api`. A Cloudflare Worker cannot launch a browser, so the crawl runs
off-edge as an ordinary Node process and ships `CrawledPage[]` to the API,
which runs the (pure, edge-safe) diagnosis rule engine over them.

This is the only path that puts real findings into a project. Nothing else
crawls.

## The loop

```
engine-crawl ──crawl──► site
     │
     └──POST /projects/:id/audit──► apps/api ──► @engine/diagnosis ──► findings (Postgres)
                                                                          │
                                                              /actions/generate ──► Fix Queue
```

## Running a crawl

```sh
ENGINE_API_TOKEN=<the API's INTERNAL_API_TOKEN> \
  pnpm --filter @engine/crawler exec engine-crawl \
    --url https://example.com \
    --project <projectId> \
    --entity <entityId> \
    --api http://localhost:8787 \
    --max-pages 50
```

| Flag | Meaning |
| --- | --- |
| `--url` | Root URL. Crawls same-origin via BFS from here. |
| `--project` | Project uuid the findings belong to. |
| `--entity` | Entity uuid the crawled pages resolve to. Must belong to `--project` — the API rejects a mismatch with `400`, not a 500. |
| `--api` | Base URL of a running `apps/api`. |
| `--max-pages` | Cap for this run. Defaults to the 100k/project MVP budget. |

### `ENGINE_API_TOKEN`

`/projects/*` is gated, and the crawler has no user session, so it authenticates
as a machine caller with the API's shared `INTERNAL_API_TOKEN` (see
`docs/40-Integrations.md`). It is read from the **environment, not a flag** —
argv is readable via `ps` and persists in shell history.

Omit it only against a local API running `AUTH_MODE=disabled`. Otherwise the
report is rejected and the crawl is thrown away; the runner warns before it
starts spending browser time, and the resulting error names the cause.

## Politeness

`crawlSite` fetches `robots.txt` once and honours it, and sleeps `delayMs`
(default 250ms) between requests. Spec §9 makes this mandatory — do not remove
the delay to speed up a run.

## Tests

`vitest run`. `crawlPage`/`crawlSite` run against a real local HTTP server
(`testServer.ts`, build-excluded) rather than Playwright's network-less
`setContent`, so status codes, redirects and headers are real.

Note that `report.test.ts` injects `fetchImpl`. That makes the reporter's
*shape* testable but proves nothing about the live gate: a mocked fetch is what
let the runner ship with no `Authorization` header at all. Drive the CLI against
a real `wrangler dev` before trusting a change here.
