# Engine — Architecture Foundations

**Status:** v1.0 · Last updated 2026-07-14
**Companion to:** [Master PRD](00-Master-PRD.md) · [Roadmap](10-Roadmap.md)
**Scope:** The technical foundation. Chosen deployment spine for the near term: **GitHub + Cloudflare Pages/Workers.**

---

## 0. Design principles

1. **Entity-first, not URL-first.** The core join key is the **entity**, not the URL: `Entity → { URLs, keywords, prompts, citations, mentions, schema, Wikidata ID }`. This makes SEO and GEO queryable as one world and is the thing incumbents cannot retrofit. Every schema decision below defers to this.
2. **Event-driven, built to scale 100 → 100,000 customers** without a redesign.
3. **Honesty is architectural.** n-sampling (n=3–5) and confidence bands are first-class data types, computed in the pipeline, stored, and rendered — not bolted on in the UI.
4. **Cheapest capable path.** An LLM gateway routes each task to the cheapest capable model; category-level prompt caching is a first-class cost lever (40–60% saving).
5. **Retroactive intelligence.** Keep raw SERP + AI answers for 24 months so improved scoring models can reprocess history.
6. **Multi-vendor abstraction.** No single SERP or LLM vendor is a single point of failure.
7. **Safety-first execution.** Every write to a customer surface is staged, diffed, reversible, and audit-logged.

---

## 1. The four layers

```
┌─────────────────────────────────────────────────────────────────────┐
│ LAYER 4 — PRESENTATION & ACTION                                     │
│  Cloudflare Pages (React/TS SPA) · REST+GraphQL API · MCP server    │
│  Webhooks/alerts (Slack/email/Teams) · CMS plugins · Edge Workers   │
├─────────────────────────────────────────────────────────────────────┤
│ LAYER 3 — STORAGE (the data layering)                               │
│  Postgres (ops) · ClickHouse (time-series) · S3+Parquet (raw lake)  │
│  pgvector→Qdrant (vectors) · Redis (cache/queue)                    │
├─────────────────────────────────────────────────────────────────────┤
│ LAYER 2 — PROCESSING & INTELLIGENCE                                 │
│  Kafka/Redpanda streams · NLP pipeline · scoring models             │
│  LLM orchestration gateway (model routing + caching)                │
├─────────────────────────────────────────────────────────────────────┤
│ LAYER 1 — DATA ACQUISITION                                          │
│  SERP APIs · LLM answer polling (adapter/engine) · cloud crawler    │
│  first-party connectors (GSC/GA4/GBP/CMS/GitHub) · backlink license │
└─────────────────────────────────────────────────────────────────────┘
```

### Layer 1 — Data Acquisition
- **SERP data:** managed APIs first, behind the swappable `SerpConnector` interface. **Pre-alpha starts on [Serper.dev](40-Integrations.md#4-serp-data--serperdev-serp_provider-serper_api_key)** (2,500 free credits, prepaid so no bill-shock); **DataForSEO** (~$0.60/1k) is the primary switch-target at volume, **SerpAPI** the subscription-capped alternative. *No Google scraper in year one* (parser maintenance + legal exposure). Revisit vendor at >$50k/mo spend.
- **LLM answer polling:** **adapter-per-engine behind a common interface.**
  - *API-based:* **OpenAI (primary) + Gemini (built for readiness)** shipped; Perplexity (Sonar), Anthropic to follow — cheap; but API ≠ consumer answers. See [Integrations §5](40-Integrations.md#5-llm-engines--openai-primary--google-gemini-readiness).
  - *Consumer-surface capture:* headless browser sessions for ground truth on a **sampled** basis. Run APIs daily, consumer capture weekly on a stratified sample; reconcile statistically.
  - *Non-determinism:* every prompt runs **n=3–5×/cycle**; store as ranges + confidence bands.
- **Crawling:** distributed **Playwright cluster** with JS rendering, polite rate-limiting, per-project crawl budgets (cap 100k URLs/project; enterprise lifts caps).
- **First-party connectors:** GSC (incl. new Generative AI performance reports), GA4, Bing Webmaster, GBP API, CMS plugins (WordPress/Shopify/Webflow), GitHub.
- **Backlink/mention:** license initially (DataForSEO backlinks); build a proprietary **mention** index (not link index) in v2.

### Layer 2 — Processing & Intelligence
- **Stream ingestion:** **Kafka/Redpanda** topics per data type → stream processors normalize into the warehouse.
- **NLP pipeline:** entity extraction (spaCy + fine-tuned multilingual transformer; **IndicBERT/MuRIL** for Indic), embeddings (**multilingual-e5** class, self-hosted for cost), intent classification, AI-answer sentiment, keyword clustering (**HDBSCAN** on embeddings).
- **Scoring models:** technical health, **extractability** (trained on cited vs non-cited pages — compounding moat), entity strength, unified visibility.
- **LLM orchestration:** one internal gateway routing to the cheapest capable model per task, with aggressive **category-level prompt caching** shared across customers.

### Layer 3 — Storage
| Store | Technology | Holds |
|---|---|---|
| Operational | **PostgreSQL** | Accounts, projects, configs, fix-queue state, billing |
| Analytical/time-series | **ClickHouse** | SERP positions, AI citation events, crawl results, metrics history — sub-second aggregations |
| Object/raw lake | **S3 + Parquet** | Raw SERP snapshots + raw AI answers, 24-month retention (retroactive reprocessing) |
| Vector | **pgvector → Qdrant** at scale | Embeddings for content, keywords, entities, AI answers |
| Cache/queue | **Redis** | Sessions, rate limits, job queues (BullMQ/Celery) |

**Entity-first data model (the core decision):**
```
Entity {
  id, canonical_name, wikidata_id,
  urls[], keywords[], prompts[], citations[], mentions[], schema[]
}
```
All analytics join through `entity_id`. A URL, a keyword, and an AI citation are all *facets of an entity*.

### Layer 4 — Presentation & Action
- Web app (React/TS SPA), REST + GraphQL API, **MCP server**, webhook/alert system, CMS plugins, and **Cloudflare Worker** for edge deployment of fixes.

---

## 2. The GitHub + Cloudflare deployment spine (near-term)

The blueprint's ambition (K8s Playwright clusters, ClickHouse, GPU pools) is the *destination*. For the near term we deliberately start lean on **GitHub + Cloudflare**, which also happens to be the exact substrate the **execution layer** deploys *into* for headless customers — so we dogfood it.

### 2.1 Repos (GitHub)
Monorepo with workspaces (pnpm/Turborepo):
```
engine/
  apps/
    web/            # marketing / pre-launch placeholder → Cloudflare Pages
    dashboard/      # product SPA (Pulse + Fix Queue), TS→ESM → Cloudflare Pages
    api/            # API + GraphQL   → Cloudflare Workers (Hono) or containerized
    workers/        # edge fix-deploy Workers, cron pollers, queue consumers
    mcp/            # MCP server
  packages/
    core/           # entity model, shared types (Finding/Action contract)
    connectors/     # SERP, LLM adapters, GSC/GA4/GBP/CMS/GitHub
    db/             # Postgres migration runner (`pnpm db:migrate` / `db:status`)
    ui/             # design system (tokens, Radix, charts)
    scoring/        # scoring model clients
  plugins/
    wordpress/      # CMS plugin
    shopify/        # CMS app
  infra/            # IaC, wrangler configs, migrations
```
- **CI/CD:** GitHub Actions → build, test, typecheck → deploy Pages + Workers on merge to `main`; preview deployments per PR (Cloudflare Pages preview URLs).
- **The customer-facing GitHub integration reuses this muscle:** technical/content fixes for headless sites are exported as **GitHub PRs** (feature C4.5) into the *customer's* repo — same primitive we use internally.

### 2.2 Cloudflare surface
| Concern | Cloudflare primitive |
|---|---|
| Frontend hosting | **Pages** (SPA, preview deploys, global CDN) |
| API / edge compute | **Workers** (Hono/itty-router); heavier jobs on containers |
| Edge fix deployment | **Workers** injecting JSON-LD / redirects / robots rules at the edge — no dev ticket for the customer |
| Async jobs | **Queues** (polling cycles, crawl orchestration, fix deploys) |
| Scheduled polling | **Cron Triggers** (daily API polls, weekly consumer capture) |
| Edge cache / KV | **KV / Cache API** for prompt-cache lookups and session data |
| Object storage | **R2** as the S3-compatible raw lake (Parquet) — avoids egress fees |
| Secrets | **Workers Secrets** / environment bindings |
| Zero-trust / WAF | Cloudflare Access + WAF in front of API |

### 2.3 Where Cloudflare is *not* enough (and what we pair it with)
Cloudflare is the **edge + web + light-compute + storage** spine. It is **not** the home for:
- **ClickHouse** (time-series warehouse) → managed ClickHouse Cloud, queried by the API.
- **Postgres** → managed (Neon/Supabase/RDS), or Cloudflare **Hyperdrive** to pool connections from Workers.
- **Playwright crawler cluster + GPU inference (embeddings, extractability scorer)** → containers on a GPU-capable host (managed K8s or a GPU cloud), triggered via Queues. Workers orchestrate; heavy compute runs off-edge.
- **Kafka/Redpanda** → managed (Redpanda Cloud) as scale demands; at MVP, Cloudflare Queues can stand in for lower-volume streams.

**Rule of thumb:** *Orchestration, delivery, and edge writes on Cloudflare; stateful warehouses and GPU/browser compute on managed services behind the Workers API.*

### 2.3.1 Postgres schema migrations
The Postgres schema in `infra/migrations/postgres/` is applied by `@engine/db`:

```bash
pnpm db:status              # what is applied vs pending
pnpm db:migrate --dry-run   # plan only
pnpm db:migrate             # apply
```

`DATABASE_URL` comes from the environment, else from `apps/api/.dev.vars` — the
same file `wrangler dev` reads. Workers cannot run migrations themselves (no
filesystem, and a migration is not a request), so this is a deliberate
operator-run step, not something the API does at boot.

**Rules the runner enforces:**
- **Applied migrations are immutable.** Each is checksummed into
  `schema_migrations`; editing one that already ran is drift and aborts the run.
  Add a new migration instead.
- **Filenames are `NNNN_snake_case.sql`** (`0003_add_widgets.sql`). Anything else
  is rejected rather than skipped — a migration that never runs is worse than one
  that fails loudly.
- **New migrations must sort above every applied one**, or the resulting schema
  is one no fresh `migrate` could reproduce.
- **All pending migrations run in one transaction**, under a transaction-scoped
  advisory lock (Neon's pooled endpoint is a transaction-mode pooler, where
  session-scoped locks aren't reliably held by the same backend). A migration
  needing to run outside a transaction — `CREATE INDEX CONCURRENTLY`,
  `ALTER TYPE ... ADD VALUE` — cannot go through this runner and must be applied
  by hand.

**Writing `jsonb` columns:** bind through `toJsonb()` (`apps/api/src/db.ts`),
never `${JSON.stringify(v)}::jsonb`. The cast makes Postgres infer the parameter
as jsonb and the driver re-encodes the already-encoded string, silently storing a
jsonb *string*: it reads back fine through its own repository, but `col->>'key'`
is null and every jsonb predicate matches nothing. A guard test in
`apps/api/src/repositories/jsonb.test.ts` keeps the idiom out.

### 2.4 MVP-lean vs scale-target mapping
| Capability | MVP-lean (Phase 1) | Scale target (Phase 2–3) |
|---|---|---|
| Streaming | Cloudflare Queues | Redpanda/Kafka |
| Warehouse | ClickHouse Cloud (small) | ClickHouse cluster |
| Vectors | pgvector | Qdrant |
| Crawler | Small Playwright pool (containers) | K8s Playwright cluster |
| Inference | Hosted API models + small self-host | Self-hosted GPU pool |
| API | Workers (Hono) | Workers + containerized services |

---

## 3. Key architectural contracts

### 3.1 `Finding → Action` (the moat contract)
Every Pillar B diagnosis emits:
```ts
type Finding = {
  id: string; entityId: string; source: 'technical'|'content'|'entity'|'local';
  issueType: string;                   // what is wrong, e.g. 'ai-crawler-blocked'
  severity: number; predictedImpact: number; evidence: object;
  actionTemplates: ActionTemplate[];   // zero-or-more executable fixes
}
type Action = {
  id: string; findingId: string; type: 'schema'|'meta'|'redirect'|'robots'|'content'|'gbp';
  target: DeployTarget;                 // cms-plugin | edge-worker | github-pr | gbp-api
  diff: Diff; status: 'proposed'|'approved'|'deployed'|'verified'|'rolled_back';
  auditLog: AuditEntry[];
}
```
This contract is frozen in `packages/core` in Phase 1 so the C-layer is integration, not redesign.

**Persistence rules (learned the hard way — see migration `0003`):**

1. **A Finding must be persisted before its Actions exist.** `actions.finding_id` is a
   uuid FK, so `POST /actions/generate` can only reference a finding that `POST /audit`
   already wrote. Findings are not a transient by-product of a crawl; they are the
   feedstock rows the Fix Queue hangs off.
2. **`Finding.id` changes meaning at the persistence boundary.** Diagnosis mints a
   *deterministic* id (FNV-1a over entity+url+issue-type) so the same unresolved issue
   keeps one identity across crawls. That id is stored as `findings.fingerprint`, unique
   per entity, and `/audit` upserts on it — a re-crawl refreshes scores in place instead
   of duplicating findings and re-proposing fixes the user already rejected. The Finding
   returned by `/audit` carries its **database uuid**, which is what an Action references.
3. **An Action reaches its project only through `findings → entities`.** There is
   deliberately no `actions.project_id`: the entity is the join key for everything
   (§5), and a denormalized copy would be a second, drift-prone source of that truth.
   The Fix Queue list is a two-hop join, and any route accepting a caller-supplied
   `entityId` must check it belongs to the project before writing — otherwise one
   project can hang findings off another's entity.
4. **A Finding must carry its `issueType` (migration `0004`).** The type *is* the
   problem's identity: it selects the severity weight and the action templates, and it
   is hashed into the fingerprint. It was originally consumed by the rule engine and
   then dropped, which left every stored finding unable to say what it was — and
   unrecoverable, since FNV-1a is one-way and inferring the type back from
   `actionTemplates` is lossy (`schema-missing`/`schema-invalid` and the two `meta-*`
   types each share a single template). The vocabulary belongs to each Pillar B source,
   not to `packages/core` and not to a schema `check` constraint, so `issueType` is a
   `string` and `source` says which vocabulary reads it.
5. **The health score belongs to a run, not to the inventory.** §8 normalizes it by
   pages audited, and crawled pages are never persisted — so it cannot be recomputed
   from findings later. `/audit` records an `audit_runs` row per crawl and
   `GET /audit` reports the newest one's score, returning **null** for a project that
   has never been crawled rather than a default that would read as a clean bill of
   health.

### 3.2 AI-visibility honesty type
```ts
type CitationMeasurement = {
  engine: string; prompt: string; nSamples: number;   // 3–5
  citationRate: { low: number; point: number; high: number };  // confidence band
  method: 'api' | 'consumer' | 'reconciled';
}
```
Point estimates are never surfaced for AI visibility.

### 3.3 Connector interface
Every SERP vendor, LLM engine, and first-party source implements a common adapter interface so vendors are swappable (multi-vendor abstraction, X9).

### 3.4 The A1/A2 data spine (Postgres standing in for ClickHouse)
`serp_positions` and `citation_events` (migration 0005) hold the M1.1 warehouse
data — one row per polled SERP query and per sampled LLM answer, respectively.
They live in the same Neon Postgres as the operational tables, not the
ClickHouse this doc specifies for time-series storage: no managed ClickHouse
instance is provisioned yet, and a poll result with nowhere to land is worse
than one sitting in the "wrong" database for now. Both tables mirror the
ClickHouse column shapes in `infra/migrations/clickhouse/0001_init.sql`
exactly, so migrating later is a data copy, not a redesign.

`GET /projects/:id/pulse` (`apps/api/src/repositories/pulseRollup.ts`)
assembles the A3 `SurfaceScores` from these tables server-side: each entity's
most recent position per tracked keyword feeds `organicSov`, and its citation
events — grouped by (engine, prompt) — feed `citationBandFromSamples` and
`aiSov`. Local (B5) has no data source yet, so it is excluded from the channel
mix at **weight 0** rather than scored as a 0, which would assert "no local
visibility" instead of "not measured"; `unifiedVisibilityScore`'s `normalize()`
renormalizes the remaining weights correctly. `score` is `null` for a project
with nothing polled — never a 0, which reads as "zero visibility".

`POST /rank/poll` persists only when the caller supplies an `entityId`; the
dashboard's SERP Inspector omits it deliberately for ad-hoc, untracked lookups.
`POST /ai/poll` always persists (`PromptQuery.entityId` is already required).
Both check the entity belongs to the project before spending SERP/LLM credit —
same tenancy rule as `/audit`'s and `/actions/generate`'s entity checks.

### 3.5 A4 keyword & prompt research (MVP slice)
`packages/keywords` implements the parts of A4 buildable without new
infrastructure: `classifyIntent` (A4.3, rule-based), `transliterateToDevanagari`
(A4.7, a deterministic ITRANS-style Hinglish→Devanagari scheme — the spec's own
risk register names transliteration accuracy as an open problem, so this is
scoped as a normalizer for common spellings, not dictionary-perfect Hindi),
`generatePromptSeeds` (A4.8, template-based), and `hasAiOverlap` (A4.9, reads a
SERP's feature set for an AI Overview/AI Mode presence). All four are pure,
dependency-free functions with no LLM call and no managed keyword-data API key.

**Explicitly out of this slice**, because each needs infrastructure or a
vendor account this build doesn't have: A4.1/A4.2 volume + difficulty (needs a
managed keyword-data API — DataForSEO or similar), and A4.4 semantic
clustering (needs self-hosted embeddings + HDBSCAN). `POST .../keywords/research`
is a stateless preview call; `POST .../entities/:id/keywords` is the "push
into A1 tracking" step, writing a real `keyword_configs` row (migration
0001) — previously nothing did, despite `apps/api/src/repositories/billing.ts`
already counting them toward a plan's tracked-keyword limit.

Full A4.9 wiring against live SERP feature history was the one piece blocked
on §3.4's `serp_positions` table landing in a separate PR (to avoid a stacked
branch) — that PR has since merged, so `hasAiOverlap` applying to
`serp_positions.features` is now a small follow-up, not a blocked one.

### 3.6 The 'cms-plugin' DeployTarget (C2.2)
The edge-worker `DeployTarget` (`apps/workers`) re-derives its HTML transform
from the live `deployed`/`verified` action set on every request, so a
rollback takes effect on the next page load with no separate push step. A
`'cms-plugin'` target can't work that way — WordPress and Shopify have no
equivalent of "serve the untransformed origin response" — so it's a **pull,
apply-once, report** model instead:

1. `GET /projects/:id/cms-plugin/actions?plugin=<wordpress|shopify>&siteId=<id>`
   (`apps/api`) returns every `approved` action scoped to one plugin install,
   with the page URL its Finding was raised on.
2. The plugin (`plugins/wordpress/engine-seo.php` on WP-Cron;
   `plugins/shopify`'s `engine-shopify-sync` CLI on an external schedule)
   resolves that URL to a CMS-native resource and writes the diff into it —
   WordPress post meta, rendered via `wp_head`/`pre_get_document_title`;
   Shopify product metafields under the `engine_seo` namespace.
3. The plugin reports the push via the ordinary `POST .../actions/:id/deploy`
   transition — the same one every other deploy path uses.

Once `approved`, the action drops out of step 1's query as soon as it's
`deployed`; there's no separate "mark seen." The known asymmetry with the
edge-worker path: a `rolled_back` action here is **not** automatically
reverted — the write stays until the next audit re-detects the issue and a
new fix is approved. Both plugin READMEs document this and recommend the
edge-worker path when instant rollback matters.

### 3.7 Stripe Checkout (M1.7)
`POST /accounts/:id/billing/checkout` (`apps/api`) is the other half of
`POST /billing/webhook`: the webhook could already turn a subscription
event into our read model, but nothing could create the subscription a
customer would actually pay for. Calls Stripe's REST API directly via
`fetch` (`packages/billing/src/checkout.ts`), not the Stripe SDK — same
reasoning as `signature.ts`: this runs in Cloudflare Workers, and Checkout
Sessions are a plain form-encoded POST with nothing SDK-specific worth the
dependency.

`STRIPE_PRICE_TO_TIER` (already required for the webhook, price id → tier)
is inverted at request time to resolve a tier → price id, rather than adding
a second map that could drift out of sync with the one the webhook trusts.
A tier with no configured price (e.g. `enterprise`, contact-sales rather
than self-serve) is a 400, not a 500.

The checkout session's `subscription_data[metadata][accountId]` — not
top-level session metadata — is what closes the loop: `mapStripeSubscriptionEvent`
reads `accountId` off the *subscription* object the webhook receives, and
only `subscription_data.metadata` propagates there. Getting this wrong would
have silently broken every post-checkout webhook while looking correct in a
manual Stripe dashboard test.

### 3.8 The entity Copilot query (M2.2)
`GET /projects/:id/entities/:entityId/copilot/summary` (`apps/api/src/repositories/entityCopilot.ts`)
is the first real payoff of the entity-first bet §0 named as something that
"cannot be retrofitted": one query joining A1 (`serp_positions`), A2
(`citation_events`), and B1 (`findings`) through a single `entity_id` — the
only column all three pillars share. A URL-keyed model couldn't do this join
at all: an AI answer citing a brand carries no URL, and a finding is scoped
to a crawled page, not a SERP row.

Reuses the existing pure scoring functions (`organicSov`, and `aiFromRows`
lifted out of `pulseRollup.ts` so the project-level Pulse rollup and the
entity-level Copilot summary share one citation-grouping implementation
rather than two that could drift) — no new scoring math, just a narrower
join. Surfaced in `apps/dashboard` as a ⌘K modal (D1.3 "persistent copilot,
available on every screen"); this ships the query, not the natural-language
layer, which is the fuller D1 build.

### 3.9 Redirect fixes (C4.1/C4.2)
Closes a gap `generate.ts` documented in its own comment ("`'redirect' |
'content' | 'gbp'` are not generated in the MVP"): B1.5 already emitted
`redirect-chain` and `canonical-conflict` findings with a `redirect`
`ActionTemplate`, but nothing executed it. `packages/actions/src/redirect.ts`
(`resolveRedirectPair`/`generateRedirectAction`) turns both finding shapes
into the same `{ before: fromUrl, after: toUrl }` diff — a redirect-chain
collapses to a single hop from the *original* entry point to the crawled
page's final URL; a canonical conflict consolidates the page into the
canonical it already declares.

Unlike schema/meta/robots, a redirect has no origin content to health-check
the transform against — it short-circuits the request before origin is ever
fetched (`apps/workers/src/index.ts`). `checkRedirectDeployHealth`
(`packages/deploy/src/health.ts`) instead guards against a self-loop
(`to === from`) or an empty destination, since neither would show up in a
normal origin-error check and a self-loop would silently redirect-loop every
visitor forever.

Verified live end-to-end for the first time this project has actually run
`apps/workers` under `wrangler dev` rather than a scratch script: audit → a
real `redirect-chain` finding → generated action → approved → deployed → the
worker served a genuine `301` with the correct `Location` for the matched
path, and left an unrelated path to fall through to origin untouched. This
surfaced a real, previously-undiscovered bug: `apps/workers/wrangler.toml`
was missing `compatibility_flags = ["nodejs_compat"]` (present on `apps/api`
since PR #17), so the worker could not boot at all — `postgres`'s Workers
build needs Node's `node:events`/`node:buffer`/`node:stream` shims. Every
prior M1.4/M1.5 session had smoke-tested `apps/workers`' logic via scratch
scripts against pure functions, never the actual Workers runtime, so this had
never been caught.

---

## 4. Security, compliance & data residency
- **Execution safety:** human-in-the-loop default; staged rollouts; automatic rollback; edge-worker sandboxing; immutable audit logs (insurance-grade).
- **Isolation:** per-customer tenancy in Postgres/ClickHouse; row-level scoping enforced at the API.
- **Compliance:** GDPR + DPDP + CCPA; export/delete tooling; clear customer data-ownership terms; **no training on customer private data without opt-in**.
- **Residency roadmap:** EU + India regions (Phase 3). Cloudflare's regional services + regional managed Postgres/ClickHouse make this tractable.
- **Secrets & access:** Workers Secrets, Cloudflare Access/WAF, SSO/SAML for enterprise.

---

## 5. Unit-economics guardrails (architecture's job)
At ~1,000 paying customers the target COGS is ~$30–45k/mo against ~$120–150k MRR → **65–75% gross margin**. Architecture upholds this via:
- Category-level **prompt caching** (shared across customers in a category) — the single biggest lever.
- **Small-model routing** for classification; frontier models only for generation/copilot.
- **R2** raw lake (no egress fees) + Parquet columnar compression.
- ClickHouse for cheap sub-second aggregations instead of expensive per-query compute.

---

## 6. Open architecture decisions (to resolve before Phase 2 freeze)
1. API runtime: pure Workers (Hono) vs containerized service behind Workers — pick after MVP load characteristics are known.
2. Postgres host: Neon vs Supabase vs RDS (weigh Hyperdrive integration + residency needs).
3. When to introduce Redpanda vs staying on Cloudflare Queues (trigger: sustained stream volume/throughput).
4. Self-hosted GPU pool timing vs hosted inference (trigger: inference spend + extractability-scorer latency needs).
5. pgvector → Qdrant migration trigger (vector count + recall/latency thresholds).

---

*This foundation is intentionally lean now (GitHub + Cloudflare) and explicitly names its scale-out path so we never paint into a corner. The entity-first model and the `Finding → Action` contract are the two decisions we must get right on day one.*
