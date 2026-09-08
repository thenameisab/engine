# Engine — Where audits run

**Status:** proposal, awaiting a decision · 2026-09-08
**Context:** ship-readiness review B4 and week 1 item 6. The crawler needs a
browser (Playwright, Chromium) and a Cloudflare Worker cannot start one, so
"Run audit" in the product needs a process outside Workers.

## What exists

- `packages/crawler` is a CLI: crawl a site, then `POST /projects/:id/audit`.
- The API accepts a machine caller: a bearer equal to `INTERNAL_API_TOKEN`
  becomes the user `service:internal` (`middleware/auth.ts`).
- CI already installs Chromium for the crawler's tests
  (`pnpm --filter @engine/crawler exec playwright install --with-deps chromium`).
- Nothing records that a customer asked for an audit, and nothing runs one
  without a person at a terminal.

## The part that is the same under every option

A queue in Postgres, owned by the API, so the product never talks to the
runner directly.

- Migration `0021_audit_requests`: `id`, `project_id`, `entity_id`,
  `root_url`, `max_pages`, `status` (`queued` | `running` | `done` | `failed`),
  `requested_by` (user id or `service:internal`), `error`, `audit_run_id`,
  `created_at`, `started_at`, `finished_at`.
- `POST /projects/:id/audit-requests` — the customer's "Run audit". Refuses a
  second request while one is `queued` or `running` for the project (409), so a
  double click is one crawl.
- `GET /projects/:id/audit-requests/latest` — what the Audit screen polls to
  show "Queued", "Running since 14:02" or "Done · 41 findings".
- `GET /internal/audit-requests?status=queued` and
  `POST /internal/audit-requests/:id/claim` — service token only. Claim is a
  conditional update (`queued` → `running`), so two runners never take one job.
- `POST /internal/audit-requests/:id/finish` with `{ auditRunId }` or
  `{ error }`.
- A `queue-runner` entry point in `packages/crawler`: list queued, claim, crawl
  with the request's `max_pages`, `POST /projects/:id/audit`, finish. It logs
  request ids only, never a customer's URL (see the public-log note below).
- The product side: a "Run audit" button on the Audit screen and a call to the
  same endpoint at the end of Get started, which is the "queues a crawl" the
  review's B1 asks for.

Either option below runs that same `queue-runner`. The choice is only where
the process lives.

## Option A — a scheduled GitHub Action (recommended to start)

`.github/workflows/crawl.yml`: `schedule` every 15 minutes plus
`workflow_dispatch`. Steps: checkout, `pnpm install`, install Chromium, build
`@engine/crawler`, run `queue-runner` with `ENGINE_API_TOKEN` (repository
secret equal to the Worker's `INTERNAL_API_TOKEN`) and `ENGINE_API_BASE`
(repository variable, already set). One job drains the whole queue.

Optional but worth it: when the API inserts a request it calls GitHub's
`workflow_dispatch` REST endpoint, so a crawl starts within a minute or two
instead of at the next quarter hour. That needs one more Worker secret, a
fine-grained token with `actions: write` on this repository. It is
platform-owned, so it does not have the per-customer problem review B7 raises
about `GITHUB_TOKEN`.

| | |
|---|---|
| Time to build | About a day: migration, three routes, the runner, the button, the workflow. |
| New accounts or billing | None. The repository is public, so Actions minutes are free. |
| Latency | Under 2 minutes with dispatch; up to 15 minutes without. |
| Limits | 6 hours per job, 20 concurrent jobs. Far above a test customer's needs. |
| Caveat | Action logs on a public repository are readable by anyone. The runner therefore logs request ids and counts only. If you prefer no trace at all, the repository has to become private, which ends the free minutes. |
| Caveat | GitHub can delay scheduled runs on a busy day. Dispatch removes that dependence. |

## Option B — a small container job

A Docker image from `mcr.microsoft.com/playwright` running the same
`queue-runner`, either as a long-lived poller or started per request. Hosts
that fit: a Fly.io Machine (start on demand via API), Google Cloud Run Jobs
(trigger via API), or Cloudflare Containers once it is stable enough to rely
on.

| | |
|---|---|
| Time to build | Two to three days: the day above, plus Dockerfile, a registry, a deploy step in CI, secrets on the host, and an API call from the Worker to start the job. |
| New accounts or billing | One hosting account and a card. Small, but new. |
| Latency | Seconds if the poller is always on; under a minute if started per request. |
| Limits | None that matter at this scale. |
| Benefit | Private logs, no per-job time cap, no dependence on GitHub's scheduler. |
| Caveat | One more system to keep deployed and paid for before the first customer has signed in. |

## Recommendation

Build the queue and the runner now, and run them from a GitHub Action with
`workflow_dispatch` from the API. Everything except the workflow file carries
over unchanged to Option B when a customer's crawl volume or the public-log
constraint makes a container worth its cost.

## Decisions needed

1. Option A or Option B.
2. If A: allow the Worker to dispatch the workflow (one fine-grained GitHub
   token as a Worker secret), or accept the 15-minute schedule only.
3. Page cap per crawl. The review used 12; 50 is proposed as the default for
   a test customer, adjustable per request.
4. Whether request-id-only logging on a public repository is acceptable, or
   the repository should go private first.
