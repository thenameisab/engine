# V1 data readiness — why the screens are empty, and the plan to fill them

Date: 2026-09-09. Baseline: `origin/main` after PR #83 (`feat/google-data` merged). Companion to
`docs/reviews/2026-09-09-redesign-build-plan.md`, which covers the shell and the journey; this
document covers **data**: what each screen needs, what is missing, and the order to fix it.

## 1. What was measured

Three sources, all read directly rather than inferred.

**Production Worker secrets** (`wrangler secret list` against `engine-api`):

| Set | Not set |
|---|---|
| `DATABASE_URL`, `ENCRYPTION_KEY`, `INTERNAL_API_TOKEN`, `LOCAL_AUTH_SECRET` | `SERPER_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OAUTH_STATE_SECRET`, `GITHUB_DISPATCH_TOKEN`, `GOOGLE_CLIENT_SECRET` (in `platform_credentials` instead, which is correct) |

**Scheduled work** (`apps/api/wrangler.toml`): one cron, `15 3 * * *`, which runs the Google sync
and nothing else. No rank poll, no AI poll, no entity audit, no competitor audit, no off-site
audit, no local audit is scheduled anywhere.

**Crawl queue** (GitHub Actions run 34337469246, 2026-09-09 09:57 UTC): `1 request(s) queued`,
`1 claimed, 1 done, 0 failed`, `1 page(s) audited`. The crawl pipeline works in production. It
found one page.

**Row counts, local scratch Postgres** (the same schema and the same code paths as production):

| Table | Rows | Table | Rows |
|---|---|---|---|
| `findings` | 90 | `serp_positions` | **0** |
| `actions` | 10 | `citation_events` | **0** |
| `crawled_pages` | 14 | `keyword_configs` | **0** |
| `gsc_query_daily` | 1,350 | `competitor_sets` | **0** |
| `gsc_site_daily` | 28 | `competitor_gaps` | **0** |
| `ga4_channel_daily` | 720 | `citation_opportunities` | **0** |
| `entity_graph_audits` | 1 (one button press) | `local_profiles` / `local_audits` | **0** |

## 2. Diagnosis, screen by screen

The empty screens are not broken. Every one of them reads a table that nothing writes to, and
the reason differs per screen.

| Screen | Reads | Why it is empty | Class of fix |
|---|---|---|---|
| Audit | `findings`, `crawled_pages` | Works. Findings exist wherever a crawl ran. In production the last crawl audited **one page**, so the screen is thin, not empty — no sitemap was reachable and no same-origin links were found (`crawlSite.ts:49-75`). Nothing on screen says so. | Report crawl coverage; check the site |
| Fix Queue | `actions` | Works, downstream of Audit. Ten cards locally. Sparse for the same reason as Audit. | Same as Audit |
| Entity audit | `entity_graph_audits` | The audit is deterministic and reads facts already on the entity row, so it would produce findings today. Nothing runs it: it is a manual button, pressed once ever. | Schedule it |
| SERP / Rankings | `serp_positions` | Two blockers. `SERPER_API_KEY` is not a production secret, so `POST /rank/poll` answers 503. And `keyword_configs` is empty with no UI that writes to it, so there is nothing to poll. The screen's one-off lookup persists nothing by design. | Customer key + keyword tracking + cron |
| Competitors | `competitor_gaps` | Needs a second entity in the project. The only way to add a competitor is to pick another *tracked entity*, and nothing creates one — no add-by-domain exists. Its citation-gap dimension also needs `citation_events`. | Add-by-domain + cron |
| Backlinks / AI answers | `citation_opportunities` | Mines `citation_events`, which is empty because `OPENAI_API_KEY` and `GEMINI_API_KEY` are unset (`POST /ai/poll` → 503) and because no entity carries prompts to sample. | LLM key + prompts + cron |
| Local SEO | `local_audits` | Needs a `local_profiles` row. The only way to create one is `PUT …/local-profile`, which has no UI, and there is no Google Business Profile connection. | Profile source |
| Pulse visibility score | `serp_positions` + `citation_events` | Null because both inputs are empty. Not a scoring bug. | Downstream of the two above |
| Pulse Search / Traffic | `gsc_*`, `ga4_channel_daily` | Works as of #83. This is the one place with real data. | — |

Three root causes sit under all of it:

1. **Two vendor credentials are missing in production.** Serper and an LLM key. Without them,
   two of the four data surfaces can never fill.
2. **Nothing is scheduled except the Google sync.** Six audits and two pollers exist as routes
   with a button on a screen. A product that only ingests when a customer finds a button has no
   data on the customer's first visit, which is the visit that matters.
3. **The dependency chain is unseeded.** Rankings need tracked keywords; AI answers need
   prompts; Competitors needs a competitor; Local needs a profile. Each is a row a customer has
   no way to create in the product today.

## 3. Decisions taken for this plan

| # | Question | Decision |
|---|---|---|
| 1 | Serper ownership | Serper becomes a customer-facing `api_key` provider in the registry. The platform `SERPER_API_KEY` stays as a fallback when a client has pasted none. This reverses the earlier platform-only position, at the user's instruction. |
| 2 | LLM ownership | Platform-owned, and the engine is **Sarvam** rather than OpenAI or Gemini: that is where the credits are. One Worker secret lights AI answers for every client. Sarvam does not browse, so it can report whether a model names the brand, not which sources it cites. |
| 3 | Workspace rail | Always visible, including for an account with one client. One client is one square. |
| 4 | Sequence | Data first, then the shell and the workspace rail. |

## 4. The plan

One branch at a time off the latest `origin/main`, merged before the next starts — the shared
files are `shell.ts`, `styles.css`, `format.ts`, `api.ts`, `index.ts`, `registry.ts` and the
migration sequence. Migration numbers start at 0024. Sizes: S under a day, M one to two days,
L three to four.

### Step 1 — Credentials, and one place that says what is missing (S) — **done, PR pending**

Built as described, with three changes forced by what the vendors actually do:
Sarvam replaced OpenAI/Gemini as the LLM engine (the user's credits are there), the model is a
reasoning model that needs a 16,000-token budget, and `insertSerpPositions` was found to record
the wrong number entirely. See the 2026-09-09 entry in `working_log.md`.


- `packages/integrations/src/registry.ts`: new `serper` row, `kind: 'api_key'`, one `apiKey`
  field, `placement: { in: 'header', name: 'X-API-KEY' }`, `verifyUrl` a cheap Serper call so a
  wrong key is refused at paste time by the existing `verifyApiKey`. `category: 'rank'`,
  `resourceScope: 'account'`, no resource lister (there is nothing to pick).
- New `apps/api/src/repositories/serpKey.ts`: `resolveSerpKey(db, accountId, keyring, env)` —
  the account's pasted key first, `env.SERPER_API_KEY` second, `null` third. `POST /rank/poll`
  calls it and builds the connector from the result instead of from the environment alone. The
  503 message names neither a variable nor a vendor: "Search-ranking lookups are not set up for
  this client yet."
- `evaluateReadiness` gains rows for the SERP key (either form) and the LLM keys, so
  `/health/integrations` answers the operator's question in one call.
- **Operator tasks, outside the code:** `wrangler secret put OPENAI_API_KEY` (or `GEMINI_API_KEY`),
  and `SERPER_API_KEY` if the platform fallback is wanted. Also `OAUTH_STATE_SECRET` and
  `GITHUB_DISPATCH_TOKEN`, both currently unset.
- Done when: a client can paste a Serper key on Integrations and it is verified before storage;
  with no client key and a platform key set, a rank poll still succeeds; with neither, the
  screen says so in the customer's words.

### Step 2 — Rankings: tracked keywords and a poller (M) — **done, PR pending**

Built as described. Two things not in the plan: the poll runs *daily* and asks each keyword's
cadence whether it is due (a weekly cron cannot serve a keyword tracked at daily cadence), and
the per-run lookup cap exists because Serper bills per lookup. See the 2026-09-09 entry in
`working_log.md`.


- The seed list already exists. #83's `search-traffic` route computes `withinReach` and
  `topQueries` from Search Console — for TartanHQ that is *income verification api*, *payroll
  data api*, *hrms integration*, *fake payslip detector*, *payslip ocr*. Rankings offers those
  instead of a blank field.
- `serp.ts` becomes Rankings: the tracked-keyword table (keyword, engine, geo, device, current
  position, change since the previous poll) above the existing one-off lookup, with "Track this
  keyword" on both the suggestions and a lookup result. Writes `keyword_configs` through the
  route that already exists (`POST …/entities/:id/keywords`) and which nothing has ever called.
- New cron entry: weekly rank poll. A second scheduled handler drains `keyword_configs` per
  project with `cadence` respected, calls the same connector, and persists to `serp_positions`
  with the `entityId` present, which is the path that already persists.
- Plan limits: `packages/billing` already counts `keyword_configs` for the tracked-keyword
  limit, so the count stops being permanently zero — check the limit is enforced at creation.
- Done when: a keyword tracked from a Search Console suggestion shows a position after the
  first poll, and the Organic cell of the visibility score is non-null.

### Step 3 — AI answers: prompts and a sampler (M)

- Prompts editor on the Backlinks screen, renamed to AI answers: `entities.prompts` is an
  existing column, and `generatePromptSeeds` in the keywords package already turns a keyword
  into prompt candidates, so the editor opens with suggestions rather than an empty box.
- New cron entry: weekly AI poll over every entity with prompts, `n=3` samples per engine,
  writing `citation_events` through the existing insert.
- The screen then shows both halves: cited share by engine (from `citation_events`) and the
  citation opportunities the off-site audit mines from them.
- Done when: with two prompts and one LLM key set, the screen shows a cited-share range and at
  least one opportunity domain, and the AI cell of the visibility score is non-null.

### Step 4 — Run the deterministic audits without a button (M)

Four audits read data the system already holds and need no vendor call: entity, off-site,
competitor, local. Each is currently a button on a screen.

- `packages/crawler/src/runQueue.ts`: after a crawl finishes, call the entity audit for the
  project. The crawl is the moment the facts changed, so it is the right trigger.
- Nightly (fold into the existing 03:15 cron, after the Google sync): off-site audit per
  entity, competitor audit per self-entity that has a competitor set, local audit per entity
  that has a profile. All are idempotent, so a re-run is safe.
- The buttons stay as "Run now", but they stop being the only path. Each screen gains a line
  saying when the audit last ran.
- Done when: after one crawl, Entity audit shows a strength breakdown with no button pressed,
  and the three nightly audits populate their screens on the next morning.

### Step 5 — Competitors by domain (S)

- "A competitor's website" as the empty state's one field. It creates an entity with
  `kind: 'competitor'` and adds it to the self-entity's set, so the existing analysis runs
  against it that night.
- `entities.kind` — check whether #80's `packages/core/src/entity.ts` already carries it; add
  migration 0024 only if the column is genuinely absent.
- Done when: one typed domain produces gap rows the next day.

### Step 6 — Local, and crawl coverage (S)

- Local: the location picker becomes an entity dropdown rather than a UUID field
  (`googleIntegrations.ts:454`), and the profile facts get a form so a customer without a
  Google Business Profile connection can still fill them. The screen is hidden until either
  exists.
- Crawl coverage on Audit: show pages found, whether a sitemap was read, and how many links
  were followed. Production's "one page audited" must be visible as a fact about the crawl, not
  as an empty screen. If a real site returns one page, that is itself the first finding.
- Done when: Audit states its coverage, and Local is either absent or working.

### Step 7 — The workspace rail and the client drawer (M)

This replaces step 1 of the redesign build plan, whose decision 3 hid the client layer. The
user's instruction supersedes it: the client is a visible switcher, in the Slack shape.

- A narrow permanent column, 56 px, left of the existing rail: one rounded square per client
  (initials, or the client's logo where branding has one), the active one marked, a `+` at the
  bottom for a new client, and the user avatar at the very bottom.
- Clicking the active square, or the client name in the rail header, opens a second drawer over
  the menu: the client list with each client's sites beneath it, a search field once there are
  more than about eight, and each row showing what is connected (`GET /accounts` already
  returns `connectedProviders` per client as of #83). Escape and a backdrop click close it, and
  `dialog.ts` already has that behaviour to reuse.
- Selecting a site sets the project and re-renders in place. Today switching a client only
  raises a toast.
- `styles.css`: `.app` becomes a three-column grid, `56px 224px 1fr`, collapsing to
  `56px 60px 1fr` when the menu is collapsed and to a bottom bar under 860 px, where the rail
  currently sets `display: none` and makes the product unreachable on a phone.
- Done when: two clients are one click apart, the open client is named on every screen, the
  drawer is reachable by keyboard, and a phone can reach every destination.

### Step 8 — Findings, propose-batch and verification (L)

Unchanged from step 4 of the redesign build plan: `propose-batch` per issue group, "Fix on all
N pages", one explanation per issue type, the deploy-target form asked for at the moment of
need, and verification as a machine step with a "Check now" button. Sequenced last because it
is the largest and it depends on nothing above.

## 5. Order

```
1 Credentials ─► 2 Rankings ─► 3 AI answers ─► 4 Audits on a schedule ─► 5 Competitors ─► 6 Local & coverage ─► 7 Workspace rail ─► 8 Findings & verify
```

Steps 1 to 3 are strictly ordered: step 2 needs the SERP key resolver, step 3 needs the LLM key
set. Steps 4 to 6 can be reordered freely. Step 7 touches `shell.ts` and `styles.css`, which
nothing before it touches, so it can also run in parallel with 4 to 6 if that is preferred.

## 6. What this plan does not cover

- The model behind Ask Engine.
- Bing search-performance sync (the key verifies and a site is assigned, but no sync exists).
- Billing, plan limits and the upgrade screen.
- Email for invites and resets.
- Whether production's one-page crawl is a thin site or a crawl defect. That needs one look at
  the project in the product, which is step 6's first task.
