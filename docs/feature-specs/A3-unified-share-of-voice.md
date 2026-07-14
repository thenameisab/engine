# A3 — Unified Share of Voice (Unified Visibility Score) · Reference Spec

**Pillar:** A · **Phase:** MVP · **Priority:** P0 · **Moat weight:** ◆◆
**PRD ref:** [Master PRD §3 A3](../00-Master-PRD.md) · **Status:** Draft

## 1. Problem & job-to-be-done
Every incumbent forces the user to mentally stitch together rank tracking, GEO, and local. Engine's core UX promise is **"one number, then depth."** The Unified Visibility Score is that number: a single blended measure of a business's total discoverability across **organic + AI + local**, weighted by *its own* traffic mix. It is the hero metric of the Pulse screen and the anchor of the executive story.

## 2. Users & roles
- **Owner:** *the* number + its 30-day trend. Understands the whole product in 10 seconds.
- **Executive:** the number tied to revenue attribution (D2 later).
- **Analyst:** full decomposition into contributing surfaces.
- **Agency:** one score per client across the grid.

## 3. Scope
**In (MVP):** A3.1 unified score (organic SoV + AI SoV + local SoV), A3.2 traffic-mix weighting, A3.3 decomposition, A3.4 trend + algorithm-update overlays. A3.5 competitor benchmark (MVP-light; deepens with A5).
**Out:** revenue weighting (that's D2 attribution, Phase 2).

## 4. Functional requirements
1. Compute **organic SoV** from A1 (weighted ranking presence), **AI SoV** from A2 (Share of Model), **local SoV** from B5/A1.4 (local pack presence).
2. Blend into one 0–100 score, **weighted by the customer's actual channel mix** (from GA4/GSC connectors; sensible defaults before data exists).
3. Because AI SoV carries confidence bands, the unified score **also carries a band** — the honesty signature propagates up.
4. Provide full **decomposition**: click the number → see each surface's contribution and its own trend.
5. Overlay known **algorithm-update timelines** on the trend.
6. Benchmark against tracked competitor set.

## 5. Data & sources
- **Derived** from A1 (ClickHouse rankings), A2 (ClickHouse citations), B5/local. Channel mix from GA4/GSC. No new external source.
- Computed on a schedule + on-demand; stored as a time series in **ClickHouse** for instant trend rendering.

## 6. Intelligence / models
- Weighting model is deterministic + configurable; no LLM. Band propagation is statistical (combine A2 bands with point contributions).

## 7. Finding → Action mapping
- A3 itself is a *rollup*, but a **sharp drop in the unified score** is a top-level `Finding` that routes the user to the responsible surface's findings (drill to A1/A2/B5), which carry the actual actions.

## 8. UX
- **Pulse hero:** the score, its band, 30-day trend, top-3 wins, top-3 risks, Fix Queue count.
- Decomposition ring/bars showing organic vs AI vs local contribution.
- Confidence band rendered on the score and its trend line.

## 9. Non-functional
- Must render <500ms on Pulse (precomputed series in ClickHouse).
- Band must never be hidden; the "one number" is always a number *with* a range for the AI-influenced portion.

## 10. Dependencies & risks
- Depends on A1, A2, B5, and GA4/GSC connectors for weighting.
- **Risk:** a single blended number can mislead if weighting is opaque → mitigate with always-available decomposition and visible weights.

## 11. Success metrics
- % of users who understand Pulse in <10s (usability testing); correlation of score movement with real traffic movement.

## 12. Open questions
- Default channel-mix weights per vertical before GA4 data arrives?
- How to weight local for non-local businesses (auto-detect intent to include/exclude local SoV)?
