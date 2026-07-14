# A1 — Rank Tracking · Reference Spec

**Pillar:** A · **Phase:** MVP · **Priority:** P0 · **Moat weight:** ◆
**PRD ref:** [Master PRD §3 A1](../00-Master-PRD.md) · **Status:** Draft

## 1. Problem & job-to-be-done
Businesses need to know where they rank in Google (and other engines) across every market, device, and language they care about — and *when it moves*. Classic rank tracking is table stakes and **not a differentiator**, but it is the organic half of the Unified Visibility Score (A3) and a primary trigger source for the Fix Queue (a ranking drop → a diagnosis → a fix). It must be *correct, fast, and cheap*, not fancy.

## 2. Users & roles
- **Owner mode:** "Am I up or down this week?" — trend + top movers only.
- **Analyst mode:** full keyword tables, filters, exports, cannibalization.
- **Executive mode:** trend rolled into the unified score.
- **Agency mode:** per-client rollups across the multi-client grid.

## 3. Scope
**In (MVP):** A1.1 multi-geo (country→city→postcode), A1.2 device, A1.3 language, A1.4 SERP-feature tracking (incl. AI Overview *presence*), A1.5 volatility index, A1.6 historical SERP snapshots, A1.7 distribution/movement + cannibalization, A1.8 cadence (weekly→daily→on-demand), A1.9 tag/segment.
**Out:** building our own scraper (use DataForSEO/SerpAPI); non-Google engines beyond Bing at MVP (Baidu/Naver/Yandex → Phase 3).

## 4. Functional requirements
1. Track a keyword at a specified {geo, device, language} tuple; each tuple is an independent tracked series.
2. Capture top-100 organic positions + all SERP features present (snippet, PAA, packs, shopping, **AI Overview block presence**).
3. Store a full-page **SERP snapshot** per poll for point-in-time reconstruction (→ R2/Parquet lake).
4. Compute a per-project and per-market **volatility index** from position deltas.
5. Detect **cannibalization** (two+ URLs of the same site ranking for one keyword).
6. Honor plan cadence: Starter weekly, Growth daily, on-demand refresh (rate-limited).
7. Segment/tag keywords; all views filterable by the shared filter bar (market/language/engine/device).
8. Emit a `Finding` when a tracked keyword drops beyond a threshold (feeds Fix Queue).

## 5. Data & sources
- **Source:** DataForSEO (primary), SerpAPI (failover) via the common SERP adapter interface.
- **Storage:** positions & SERP-feature events → **ClickHouse** (time-series, sub-second aggregation); raw SERP HTML/JSON snapshots → **R2 + Parquet** (24-mo retention); keyword configs/tags → **Postgres**.
- **Entity linkage:** each keyword links to its `entity_id` so rankings join with AI citations and local in A3.

## 6. Intelligence / models
- Volatility index = statistical (rolling stdev of position deltas). No LLM.
- Cannibalization = deterministic grouping. No LLM.
- Cost: SERP API is the cost driver → cadence gating by plan is the primary control (~$0.60/1k queries).

## 7. Finding → Action mapping
| Finding | Example Action(s) |
|---|---|
| Ranking drop on a page | Content rewrite (C3), technical fix if crawl issue (C4) |
| Cannibalization | Canonical correction / internal-link fix (C4) |
| Lost SERP feature (e.g. snippet) | Answer-first rewrite / schema (C2/C3) |

## 8. UX
- Lead metric: **net rank movement** this period (one number), then the keyword table beneath.
- SERP-feature presence shown as chips per keyword; AI Overview presence flagged (bridges to A2).
- Volatility shown as a market-weather indicator on Pulse.

## 9. Non-functional
- Dashboard query <500ms (ClickHouse). Snapshots never block the dashboard read path.
- Scale: 100k keyword-tuples/project without query degradation.

## 10. Dependencies & risks
- Depends on SERP adapter (Arch §1 L1) and entity model.
- **Risk:** Google restricts SERP data → mitigated by multi-vendor abstraction + first-party GSC weighting; the AI-visibility side (A2) doesn't depend on Google SERPs.

## 11. Success metrics
- Poll success rate ≥99%; position accuracy spot-check vs manual ≥98%; query latency <500ms p95.

## 12. Open questions
- Postcode-level granularity cost ceiling? Which markets justify sub-city tracking at MVP?
