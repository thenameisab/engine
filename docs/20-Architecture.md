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
