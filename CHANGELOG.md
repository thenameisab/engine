# Changelog

All notable work on Engine, in chronological order. Grouped by day and theme;
each entry links the PR that shipped it (all merged to `main`).

Format loosely follows [Keep a Changelog](https://keepachangelog.com/). This
project has no releases/tags yet — Phase 1 (MVP) is still in progress per
[`docs/10-Roadmap.md`](docs/10-Roadmap.md), so entries are dated commits, not
versions.

---

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
| M1.3 | Diagnosis MVP (B1 → scored Findings) | ✅ Done |
| M1.4 | First fix deployed (proposed→approved→deployed→verified via plugin/worker) | 🟡 Action generation + Fix Queue lifecycle done; real deploy transport (WordPress/Shopify plugin, Cloudflare Worker) not yet built |
| M1.5 | Rollback proven | 🟡 State machine supports it; not yet exercised against a real deploy |
| M1.6 | Self-serve onboarding | ⬜ Not started |
| M1.7 | Billing live | ⬜ Not started |

Also outstanding: real crawler (B1.1 Playwright) and A1/A2 connector runtimes
(interfaces exist, no live ingestion yet), the product app (`apps/web` today
is the pre-launch marketing placeholder, not the dashboard), X0 competitor
teardown research track.
