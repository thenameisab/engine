# Changelog

All notable work on Engine, in chronological order. Grouped by day and theme;
each entry links the PR that shipped it (all merged to `main`).

Format loosely follows [Keep a Changelog](https://keepachangelog.com/). This
project has no releases/tags yet — Phase 1 (MVP) is still in progress per
[`docs/10-Roadmap.md`](docs/10-Roadmap.md), so entries are dated commits, not
versions.

---

## 2026-07-16 — Cinematic auth gate (Neon Auth = Better Auth, SDK-free)

### Added
- **Auth screen + login gate (`apps/dashboard/src/auth`)** — the dashboard now
  opens on a sign-in screen and only mounts the app once authenticated; a
  sign-out control lives in the sidebar footer, showing the signed-in user.
  Wired to **Neon Auth, which is Better Auth** (not Stack), **without the SDK**
  so the dashboard stays bundler-free: `POST /sign-in/social` → redirect into
  Better Auth's Google OAuth (Neon's shared Google creds — no separate Google
  Cloud client) → cookie session; `GET /get-session` (with credentials) adopts
  it on return; `POST /sign-out` clears it. The Better Auth base URL is
  overridable via `window.ENGINE_AUTH_BASE`; the deployed origin must be added
  to Neon Auth's trusted origins for the OAuth callback. Verified against the
  live endpoint from the browser: `get-session` → 200 `null`, `sign-in/social`
  → 200 with a real Google OAuth URL, CORS reflects the origin with credentials.
  A dev-session fallback keeps the app usable where a session can't be
  established (e.g. the sandboxed preview). Email magic-link attempts Better
  Auth's plugin, with the same fallback.
- **Wordless "data → action" background animation** — a self-contained Canvas
  flow-field: scattered *data* particles resolve into coherent *streams* under
  a slowly-evolving vector field, and streams periodically culminate in a warm
  *execution* bloom (cool data → warm, deployed action). Motion trails + two
  depth layers give it a cinematic, camera-like drift; honors
  `prefers-reduced-motion` with a calm static frame. Pure 2D Canvas, no deps —
  runs in the app and the shareable preview alike.
- Verified the full cycle in-browser: sign-in → dashboard → sign-out → back to
  a fresh animated screen; zero console errors.

## 2026-07-16 — SERP Inspector goes live: first real Serper data in the product

### Added
- **SERP Inspector view (`apps/dashboard`)** — the first genuinely *live*
  product feature, wired to the user's real Serper.dev key. Enter a keyword
  (+ optional your-domain, + country) → one live Google query surfaces: **AI
  Overview presence** (the GEO signal — "is Google answering with AI?"), the
  **SERP features** present (People Also Ask, etc.), **your organic rank**
  (computed from the real results, e.g. "zapier.com ranks #6") with your row
  highlighted, and the **competitor hosts** ranking above you. Pure helpers
  (`hostname`/`normalizeDomain`/`domainRank`/`serpFeatureLabel`) are unit-tested
  (14 dashboard tests now).
- **CORS on `apps/api`** (`hono/cors`, `CORS_ORIGINS` env, `*` by default for
  pre-alpha) so the browser dashboard can call the Worker cross-origin.
- **`nodejs_compat`** compatibility flag on `apps/api`'s `wrangler.toml`,
  required by the `postgres` driver on the Workers runtime.

### Fixed
- **Connector `fetch` "Illegal invocation" on the Workers runtime** — the
  Serper/OpenAI/Gemini connectors stored `globalThis.fetch` as an instance
  property and called it as a method, detaching its `this` and crashing every
  live call inside a Worker (500s). Now default to a module-scope wrapper.
  Caught by running `apps/api` live under `wrangler dev` — not by the
  fixture-mocked unit tests.

### Verified live (end to end)
Ran `apps/api` under `wrangler dev` with the real `.dev.vars` Serper key and
drove the dashboard against it in the browser: `/health/integrations` reports
`serp: configured`; a real `/rank/poll` returns live Google results
(HTTP 200); and the SERP Inspector renders them with a `LIVE` badge, the
computed domain rank, and feature chips — **zero console errors**. First proof
of the full stack: browser → CORS → Worker → Serper → Google → back.

## 2026-07-15 — Product dashboard (K): the real Pulse + Fix Queue SPA

### Added
- **`apps/dashboard`** — the product SPA the roadmap kept flagging as missing
  (distinct from `apps/web`, the marketing placeholder). No framework, no
  bundler: TypeScript compiled to browser ES modules, served static on
  Cloudflare Pages. Ports the design-system v2.0 visual language (flat/minimal,
  the confidence band as the one signature) from `docs/mockups/pulse.html` into
  a live, API-wired app. Five views behind a hash router + rail nav + theme
  toggle (light default, dark honored/toggleable):
  - **Pulse** — Unified Visibility Score with its confidence-band range bar
    (a wider band visibly fills more track — uncertainty is legible), count-up,
    trend sparkline, channel decomposition (organic / AI Share-of-Model with
    ±range / local), wins & risks.
  - **Fix Queue** — the lifecycle kanban (proposed → approved → deployed →
    verified); card actions call the live transition endpoints and fall back to
    a local move (with a plain-spoken toast) when there's no live DB.
  - **Audit** — the B1 findings inventory (severity, predicted impact,
    auto-fixable), shaped exactly like `@engine/diagnosis`'s output.
  - **Integrations** — reads `GET /health/integrations` **live** and shows,
    per external account, what's wired vs. missing (ties directly to the
    integration-readiness layer).
  - **Settings** — point the app at a running `apps/api` (base URL + project id,
    persisted in `localStorage`).
- **Live-or-sample, honestly labelled.** Every view tries the live API and
  falls back to built-in sample data, showing a `live`/`sample` badge. Two
  routes genuinely work live with no database — `/health/integrations` and
  `/projects/:id/pulse` (the A3 score math is pure) — and the client sends the
  exact `SurfaceScores` body + parses the real band. DB-backed views stay on
  sample until Postgres is wired.
- **10 unit tests** on the pure presentation helpers (confidence-band bar
  geometry, sparkline path building, delta formatting, lifecycle transitions).
  Battle-tested in-browser: all five views render in light **and** dark, the
  Fix Queue lifecycle transition moves a card + updates its next action, zero
  console errors, no horizontal overflow.

## 2026-07-15 — Integration readiness: config layer, Serper SERP + OpenAI/Gemini adapters

### Added
- **`packages/config`** — one registry (`INTEGRATIONS`) as the single source of
  truth for every external account Engine depends on (Postgres/Neon, GSC OAuth,
  Stripe, Serper.dev SERP, OpenAI, Gemini): each carries its env vars,
  secret/required flags, purpose, account, and provisioning notes. Drives three
  things off that one definition so they can't drift: a pure readiness
  evaluator (`evaluateReadiness` → per-integration `configured`/`partial`/
  `missing` + an `mvpReady` roll-up), the `.dev.vars.example` generator, and
  the human docs. 8 unit tests.
- **Serper.dev SERP adapter (`packages/connectors`)** — the first concrete
  `SerpConnector`. Chosen for the most generous free tier (2,500 credits) +
  prepaid billing (structurally can't bill-shock). Pure Serper-response→
  `SerpResult` mapping with SERP-feature detection incl. **AI Overview
  presence** (the GEO-critical chip), local pack, PAA. Extended the `vendor`
  union to `serper | dataforseo | serpapi` so switching later stays a small
  change. Google-only, prepaid, no SDK.
- **OpenAI + Google Gemini LLM adapters (`packages/connectors`)** — both
  implement `LlmEngineConnector` with n-sampling (A2 n=3–5). Shared, pure
  citation extractor (`buildCitationEvent`): domain-target matches against
  cited source hosts, brand-name targets against answer text; sentiment/
  accuracy honestly left `null` pending the A2.5 judge. **OpenAI** is the
  primary (Chat Completions); **Gemini** is built for readiness with the Google
  Search grounding tool on by default, so it returns real source URIs.
  Added `citationTargets?` to `PromptQuery` (additive) so the caller supplies
  the entity's domains/names. A connector factory instantiates whichever
  providers have a key present, gracefully returning nothing when none do.
  27 connector unit tests (all fixture-based — no live keys).
- **Wired into `apps/api`**: `GET /health/integrations` (readiness, never
  echoes a secret), `POST /projects/:id/rank/poll` (live SERP via the
  configured connector, `503` when unwired), `POST /projects/:id/ai/poll`
  (polls every configured LLM engine, `503` when none). Extended the Worker
  `Env` bindings, documented every secret/var in `wrangler.toml`, and generated
  `apps/api/.dev.vars.example` from the registry. `.dev.vars` (real local
  secrets) is now gitignored; the `.example` is committed.
- **`docs/40-Integrations.md`** — every external account: what/why, provisioning
  steps, env vars, cost/free-tier posture, and the decisions (SERP = Serper.dev
  to start; LLM = OpenAI primary + Gemini readiness). Cross-linked from the docs
  index and Architecture (which now names Serper as the pre-alpha SERP start).

### Known gaps
Every adapter is fixture-tested and typechecks, but none has been run against a
live third-party account in this environment (same posture as the OAuth/Stripe
scaffolding): the SERP/LLM polls need real keys, and the GSC OAuth + Stripe
paths still need their accounts. `GET /health/integrations` reports exactly
which of these are wired at any moment.

## 2026-07-15 — Real crawler (B1.1): Playwright feeds the diagnosis engine live

### Added
- **`packages/crawler`** — the B1.1 Playwright crawler that was the one piece
  of the diagnosis pipeline still synthetic-input-only. Unlike M1.4–M1.7,
  this needed no external account (no Google/Stripe dependency), so it's
  fully built *and* integration-tested against real Chromium, not just
  smoke-scripted. `robots.ts` (robots.txt parser — per-user-agent groups,
  longest-match-wins with `$`-anchoring, feeds B1.6's
  GPTBot/ClaudeBot/PerplexityBot/Google-Extended verdicts), `sitemap.ts`
  (sitemap + sitemap-index fetch/parse, `Sitemap:` directive extraction from
  robots.txt), `structuredData.ts` (JSON-LD extraction incl. `@graph`
  flattening with `@context` inheritance, validation against required
  schema.org properties per type), `vitals.ts` (lab Core Web Vitals via real
  `PerformanceObserver` LCP/CLS entries, plus a synthetic-click INP proxy —
  documented approximation, same idea as Lighthouse's lab TBT), `browser.ts`
  (Chromium lifecycle), `crawlPage.ts` (orchestrates one URL into a full
  `CrawledPage` matching `@engine/diagnosis`'s contract exactly — status,
  redirect chain via `redirectedFrom()`, canonical/indexability, noindex
  source resolution across header/meta/robots, hreflang, structured data, AI
  crawler access, CWV), `crawlSite.ts` (multi-URL orchestration: explicit
  seed list or same-origin BFS discovery, a budget cap defaulting to the
  spec's 100k/project, and a politeness delay between requests — discovered
  links are filtered through robots.txt before ever being queued), `report.ts`
  + `cli.ts` (`engine-crawl` — a standalone runner process, since a Cloudflare
  Worker can't launch a browser; crawls a site then POSTs the pages to the
  already-existing `POST /projects/:id/audit`, which was built in M1.3
  specifically to take `CrawledPage[]` from an out-of-band crawler).
- **28 tests, all against a real local HTTP server + real headless Chromium**
  — no mocked browser, no `page.setContent` shortcuts. A tiny test-only
  `node:http` server serves real HTTP responses (status codes, redirects,
  headers, robots.txt, sitemap.xml) so `crawlPage`/`crawlSite` exercise
  genuine network behavior. Caught 4 real bugs this way before they shipped:
  a `@graph` validator falsely failing on inherited `@context`, a relative
  `Sitemap:` directive not resolved against origin, a missing charset header
  mangling non-ASCII page titles, and a wrong test expectation in
  `normalizeUrl`.
- Added a `playwright install --with-deps chromium` step to
  `.github/workflows/ci.yml` ahead of `turbo run typecheck/build/test`.

### Known gaps
None specific to this package — it needs no external account and every code
path (robots parsing, sitemap resolution, structured-data validation, CWV
capture, redirect/noindex/hreflang extraction, BFS discovery + robots
filtering + budget cap) is exercised against a real browser and a real HTTP
server in CI. The only thing still out-of-band is Postgres persistence on
the `apps/api` side of `/projects/:id/audit`, which is the same standing gap
as M1.4–M1.7 (no live Postgres in this environment), not a crawler gap.

## 2026-07-15 — Fix Queue goes live: deploy, automatic rollback, onboarding & billing scaffolding

### Added
- **Edge-worker deploy target (`packages/deploy`, `apps/workers`)** — the
  executable half of the C2/C3.2/C4.4 deploy targets. Pure HTML/robots.txt
  transforms (`applySchemaDiff`/`applyMetaDiff`/`applyHtmlActions` — insert-
  or-replace JSON-LD, `<title>`, meta description, HTML-escaped;
  `applyRobotsActions` — latest deployed action wins) plus `verifyHtmlDeploy`/
  `verifyRobotsDeploy` to confirm a diff actually landed before the Fix Queue
  moves an action to `verified`. `apps/workers` is the real Cloudflare Worker:
  reverse-proxies a customer origin and rewrites the response with every
  live `deployed`/`verified` action for the project, read straight from
  Postgres per request — deploy/rollback are pure DB status flips, no
  separate push to the worker. Added a `field: 'title' | 'description'`
  discriminator to `@engine/core`'s `Diff` type so a deploy target knows
  which element a meta action targets. Wired the Fix Queue lifecycle into
  `apps/api`: `POST /projects/:id/actions/{approve,deploy,rollback,verify}`.
  12 new unit tests. ([PR #13](https://github.com/thenameisab/engine/pull/13))
- **Automatic rollback (C1.7, `packages/deploy/src/health.ts`)** — every
  transform the edge worker serves is now health-checked before going out:
  origin 5xx, a page-shrunk-below-50%-of-original heuristic (catches a
  mangled transform), and JSON-LD re-validation for HTML; non-empty +
  well-formed checks for robots.txt. A failing check makes the worker fail
  safe — serve the untransformed origin response, never a broken fix — and
  fires a background rollback call to the API with the failure reason
  recorded on the action's audit log (`actor: 'system:edge-worker-health-
  check'`). Extended the transition endpoints to accept an optional `detail`
  object so the reason lands in the immutable audit log. 9 new unit tests.
  ([PR #14](https://github.com/thenameisab/engine/pull/14))
- **Onboarding + billing backend scaffolding (M1.6/M1.7)** — both need real
  external accounts (a Google Cloud OAuth client for GSC, a Stripe account)
  that can't be provisioned in this environment, so this is the
  fully-testable backend slice behind env-var seams. `@engine/core` gained
  `OnboardingProgress` (set-once E1–E3 milestone timestamps + `durationMs`
  for KPI math) and a `Subscription`/`PlanTier`/`UsageCounters` billing read
  model. New **`packages/billing`** package: Stripe webhook signature
  verification reimplemented on Web Crypto (no Stripe SDK, portable to
  Workers *and* Node — unit-tested against signatures computed independently
  via `node:crypto` as a cross-check, not just self-consistency),
  `PLAN_LIMITS`/`isOverLimit` (G1/G5 — only Starter's caps are blueprint-
  pinned), and a pure `customer.subscription.*` event mapper. 15 new unit
  tests — the one piece of M1.6/M1.7 that's genuinely fully tested, since
  signature verification is just crypto. `infra/migrations/postgres/
  0002_onboarding_billing.sql` added `onboarding_progress` and
  `subscriptions` tables. New `apps/api` endpoints: onboarding checklist +
  E2/E3 KPI reporting, a pure GSC OAuth connect-URL builder plus the
  callback token-exchange (code-complete, not live-tested against a real
  Google client), a signature-gated `POST /billing/webhook`, and
  `GET /accounts/:id/plan`. The existing `/audit`, `/actions/generate`, and
  deploy endpoints now mark onboarding milestones automatically as a side
  effect of normal use. ([PR #15](https://github.com/thenameisab/engine/pull/15))

### Known gaps (flagged in each PR, not yet exercised)
No live Postgres or Cloudflare deploy access in this environment: the
Fix Queue's DB round-trip, the edge worker's live HTTP request, the GSC
OAuth token exchange, and real Stripe webhook traffic are all typechecked
and logically verified via scratch smoke scripts, but not integration-tested
against real infra.

## 2026-07-15 — Pre-launch site + Fix Queue execution layer

### Added
- **Action generation (`packages/actions`)** — the executable half of the
  `Finding → Action` moat contract. Three deterministic generators (schema.org
  JSON-LD, meta title/description, robots.txt AI-crawler policy) turn a
  diagnosis `Finding` into a `proposed` `Action` with a concrete before/after
  diff. Added the Fix Queue lifecycle state machine
  (`proposed → approved → deployed → verified → rolled_back`) with an
  append-only audit log and illegal-transition guards. `POST
  /projects/:id/actions/generate` in `apps/api`. 18 unit tests.
  ([PR #10](https://github.com/thenameisab/engine/pull/10))
- **Pre-launch landing page (`apps/web`)** — Cloudflare Pages placeholder
  frontend. Hero direction: "Living Confidence Band" — a Unified Visibility
  score resolving out of uncertainty into an honest range, restating the
  product thesis as the page's own centerpiece. Instrument Serif tagline,
  light/dark theme toggle (**light is the default**), Emil-grade motion (WAAPI
  count-up, per-word reveal, spring cursor parallax, dot-grid canvas
  background), full `prefers-reduced-motion` support. Embedded Tally waitlist
  form. ([PR #11](https://github.com/thenameisab/engine/pull/11))
- **Scrolling manifesto** on the landing page — a "blog article in a landing
  page" living between the confidence readout and the waitlist. Four
  movements: the shift from search to AI answers, the dishonesty of a
  single-number score, why execution (not measurement) is the moat, and what
  Engine builds. Three custom, library-free, theme-aware graphs: an SVG
  zero-click line chart, a canvas "samples → honest confidence band"
  visualization, and an SVG Measure→Diagnose→Fix→Verify loop diagram.
  Scroll-reveal via IntersectionObserver, CSS-only scroll-progress hairline.
  ([PR #12](https://github.com/thenameisab/engine/pull/12))

### Changed
- Landing page defaults to **light mode**; dark remains available via the
  persisted toggle. ([PR #12](https://github.com/thenameisab/engine/pull/12))

### Process / infra
- Diagnosed a Cloudflare deploy-secrets question (`CLOUDFLARE_API_TOKEN` /
  `CLOUDFLARE_ACCOUNT_ID` as GitHub Actions secrets vs. `DATABASE_URL` as a
  Cloudflare Worker secret) and a Workers-vs-Pages architecture discussion,
  landing on: **Pages for the frontend, multiple Workers for backend
  services**, matching `docs/20-Architecture.md`'s existing `apps/{web,api,
  workers,mcp}` scaffold. User connected the `apps/web` Pages project to the
  GitHub repo (git-integrated deploys).
- Recorded standing project facts to memory: Neon Postgres region is **AWS
  ap-southeast-1 (Singapore)**; identity runs on **Neon Auth** (Stack
  Auth-based, synced into Postgres via `neon_auth.users_sync`) — no
  hand-rolled user/password table going forward.

## 2026-07-14 — Diagnosis engine (M1.3)

### Added
- **Diagnosis package (`packages/diagnosis`)** — the B1 technical-audit rule
  engine, pure and deterministic. Seven detectors covering B1.2–B1.6 and B1.9:
  missing/invalid schema, missing meta title/description, blocked AI crawlers
  (GPTBot/ClaudeBot/PerplexityBot/Google-Extended — the GEO-native check),
  redirect chains, canonical conflicts, missing hreflang, poor Core Web
  Vitals, unexpected noindex, and sitemap gaps. Enforces the spec §7 contract:
  every issue type carries ≥1 executable `ActionTemplate` or a documented
  non-executable reason. Added severity × page-value impact scoring and a
  one-number technical health score. `POST /projects/:id/audit` in
  `apps/api`. 21 unit tests.
  ([PR #9](https://github.com/thenameisab/engine/pull/9))

## 2026-07-14 — Design pivot: flat, minimal aesthetic

### Changed
- **Redesigned from Liquid Glass to a flat, minimal aesthetic** (Linear/
  Notion/GitHub register) across `docs/30-Design-System.md` (now v2.0) and
  the live `docs/mockups/pulse.html` mockup. Removed all backdrop-blur,
  translucency, ambient color washes, and materialize choreography. Introduced
  a true-neutral gray ramp, hairline-border structure, one rationed accent, a
  tighter fixed type scale, sentence-case labels, and state-only motion. The
  confidence band survived as the one deliberate emphasis, rendered flat.
  Battle-tested in-browser across light/dark themes and mobile.
  ([PR #8](https://github.com/thenameisab/engine/pull/8))

### Removed
- **Deleted the ECC Claude Code plugin** (its cost-tracker/GateGuard hooks
  were blocking the build) — full removal of the plugin, its marketplace
  registration, caches, and logs. First preserved the one asset worth keeping
  — the iOS 26 Liquid Glass design skill — verbatim into
  `docs/design/liquid-glass-design.md` before deleting.
  ([PR #6](https://github.com/thenameisab/engine/pull/6))

## 2026-07-14 — Visibility MVP (M1.2)

### Added
- **Scoring package (`packages/scoring`)** — the A3 Unified Visibility Score
  domain logic, pure and deterministic. `organic.ts` (CTR-curve volume-
  weighted organic share-of-voice), `ai.ts` (Share-of-Model band aggregated
  from A2 citation measurements, preserving band width), `local.ts`
  (local-pack SoV), `unified.ts` (channel-mix-weighted blend that propagates
  only the AI band width up, so the headline score is always a
  number-with-a-range). Established the repo's testing foundation: vitest, 15
  unit tests, `turbo run test` wired into CI. `POST /projects/:id/pulse` in
  `apps/api`. ([PR #4](https://github.com/thenameisab/engine/pull/4))
- **n-sampling → confidence-band infrastructure** (A2.6/A2.7, "the trust
  signature") — `wilsonInterval` (Wilson score interval, correct for small n,
  never collapses at 0/n successes), `citationBandFromSamples`,
  `buildCitationMeasurement`, and `reconcileBands` (API↔consumer
  reconciliation, inverse-width weighted, never understates uncertainty). 10
  more unit tests. Lost in the ECC plugin removal and recovered onto a fresh
  branch off `main`. ([PR #5](https://github.com/thenameisab/engine/pull/5),
  recovered as [PR #7](https://github.com/thenameisab/engine/pull/7))

## 2026-07-14 — Data spine + CI (M1.1)

### Added
- **CI workflow** (`.github/workflows/ci.yml`) — `pnpm install
  --frozen-lockfile` → `turbo run typecheck` → `turbo run build` on every push
  to `main` and every PR. ([PR #3](https://github.com/thenameisab/engine/pull/3))
- **Data spine schemas + minimal API** —
  `infra/migrations/postgres/0001_init.sql` (accounts/projects/entities/
  keyword_configs/findings/actions, mirroring `packages/core`'s types) and
  `infra/migrations/clickhouse/0001_init.sql` (serp_positions,
  citation_events, plus a daily confidence-band rollup materialized view).
  Scaffolded `apps/api` (Hono on Cloudflare Workers): DB client factory,
  entities repository, `GET/POST /projects/:id/entities`.
  ([PR #2](https://github.com/thenameisab/engine/pull/2))

## 2026-07-14 — Foundation: entity model + connectors

### Added
- **Monorepo scaffold** per `docs/20-Architecture.md` §2.1 — pnpm workspaces +
  Turborepo, `apps/{web,api,workers,mcp}`, `packages/{core,connectors,ui,
  scoring}`, `plugins/{wordpress,shopify}`, `infra/`. Pinned `pnpm@9.15.0` via
  corepack.
- **`packages/core`** — the entity-first data model (`Entity`) and the
  **`Finding → Action` contract** (`Finding`, `Action`, `DeployTarget`,
  `Diff`, `AuditEntry`) — frozen in Phase 1 as the moat contract so the
  execution layer (Pillar C) is integration work, not redesign. Also
  `CitationMeasurement`, the confidence-band honesty type for AI visibility.
- **`packages/connectors`** — SERP/LLM-engine adapter interfaces. `serp.ts`
  (`SerpConnector`/`SerpQuery`/`SerpResult`, multi-geo/device/language,
  SERP-feature chips incl. AI Overview presence). `llmEngine.ts`
  (`LlmEngineConnector`/`PromptQuery`/`LlmAnswerResult`, adapter-per-engine
  for the 5 MVP engines, n=3–5 sampling, citation/sentiment/accuracy per
  sample). ([PR #1](https://github.com/thenameisab/engine/pull/1))

## 2026-07-14 — Product strategy, specs, architecture, design (pre-code)

### Added
- **Strategy.** Reviewed the initial product blueprint; researched
  competitors (Profound, Peec AI, Ahrefs, Semrush); wrote a competitor note
  arguing measurement is a crowded funded race and the Fix Queue (execution)
  is the real wedge.
- **Product docs (`docs/`).** Master PRD (full feature catalogue, Pillars
  A–D + platform wrapper), 3-phase Roadmap (MVP → Depth → Platform, with
  milestones and exit criteria), Architecture (four-layer system, entity-first
  model, the `Finding → Action` contract), plus 11 per-feature reference
  specs (A1–A6, B1–B5).
- **Design language v1.** Liquid Glass material system —
  `docs/30-Design-System.md` v1 and a live interactive Pulse hero mockup
  (`docs/mockups/pulse.html`) with an animated Unified Visibility Score,
  confidence band, trend chart, Fix Queue kanban, ⌘K copilot, light+dark
  themes. (Superseded by the flat/minimal redesign on 2026-07-14, later the
  same day — see above.)
- **Repo setup.** Initialized git, pushed to a private GitHub repo
  (`thenameisab/engine`), root `README.md`, `.gitignore`.
  ([PR, initial commit](https://github.com/thenameisab/engine/commit/1bcaf0a))

---

## Roadmap status (for context)

Per [`docs/10-Roadmap.md`](docs/10-Roadmap.md), Phase 1 (MVP) milestones:

| # | Milestone | Status |
|---|---|---|
| M1.1 | Data spine live | ✅ Done |
| M1.2 | Visibility MVP (A1+A2+A3 with confidence bands) | ✅ Scoring done; live A1/A2 ingestion still pending |
| M1.3 | Diagnosis MVP (B1 → scored Findings) | ✅ Done — rule engine + real B1.1 Playwright crawler both live |
| M1.4 | First fix deployed (proposed→approved→deployed→verified via plugin/worker) | ✅ Built and smoke-tested end to end (`packages/deploy`, `apps/workers`); not yet exercised against a live Postgres + real Cloudflare deploy |
| M1.5 | Rollback proven | ✅ Automatic rollback (C1.7) built and staged-tested; same live-infra caveat as M1.4 |
| M1.6 | Self-serve onboarding | 🟡 KPI tracking + GSC OAuth scaffolding built; blocked on a real Google Cloud OAuth client + the product SPA (onboarding wizard UI) |
| M1.7 | Billing live | 🟡 Webhook sync + plan/usage logic built and fully unit-tested; blocked on a real Stripe account |

Also outstanding: A1/A2 connector runtimes (interfaces exist, no live
ingestion yet — both need a paid third-party API account: a SERP data
provider for A1, per-engine LLM API access for A2), the product app
(`apps/web` today is the pre-launch marketing placeholder, not the
dashboard — no onboarding wizard or billing UI exists yet even though the
backend does), X0 competitor teardown research track, and provisioning the
two external accounts (Google Cloud OAuth client, Stripe) needed to take
M1.6/M1.7 from scaffolded to live.
