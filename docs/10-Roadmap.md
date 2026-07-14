# Engine — Product Roadmap

**Status:** v1.0 · Last updated 2026-07-14
**Companion to:** [Master PRD](00-Master-PRD.md) · [Architecture](20-Architecture.md)
**Current focus:** **Pillar A (Unified Visibility)** + **Pillar B (Diagnosis)** — with the Fix Queue *contract* stubbed so C plugs in cleanly.

---

## Strategy note that shapes the sequencing

The competitor teardown is explicit: *measure AI visibility is a crowded, well-capitalized race we'd enter late.* So even though our **current build focus is A & B**, we treat them as the **necessary input to the Fix Queue**, not the headline. Concretely, that changes two things about how we phase A & B:

1. **Every Pillar B module ships with its `Finding → Action` mapping defined**, even before the C-layer executes it. We are building the diagnosis engine as the *feedstock for execution*, so the data contract cannot be an afterthought.
2. **The `X0` Profound Agents teardown runs in parallel with Phase 1** and gates the C-layer design. We refuse to over-invest in measurement polish before we've pinned exactly how narrow/wide the execution wedge is.

---

## Phase map at a glance

| Phase | Window | Team | Theme | Pillars in focus |
|---|---|---|---|---|
| **Phase 1 — MVP** | Months 0–6 | 6–8 | Prove the loop on a thin slice | **A** (rank + AI polling), **B** (technical audit), C1/C2 stub |
| **Phase 2 — Depth** | Months 6–18 | 12–18 | Deepen A & B; light up C & D | **A** (competitor, mention), **B** (content, entity, local), C3–C5, D1/D3 |
| **Phase 3 — Platform** | Months 18–36 | 25+ | Enterprise + agent-native | B4 log analysis, D2/D4, mention index, more engines |

Full phase criteria carried from the blueprint are in each section below.

---

## PHASE 1 — MVP (months 0–6) · Team 6–8

**Goal:** Demonstrate the *whole loop* on a narrow slice — see a problem, fix it, verify it moved — for real design partners. Not breadth; proof.

### Scope (features from PRD)
**Pillar A**
- A1 Rank Tracking (A1.1–A1.8) — multi-geo/device/language, SERP features incl. AI Overview presence, volatility, snapshots.
- A2 AI Visibility (A2.1–A2.10) — polling across the 5 engines, citation tracking, **n-sampling + confidence bands** (non-negotiable), API+consumer reconciliation.
- A3 Unified Visibility Score (A3.1–A3.4).
- A4 Keyword & Prompt Research (A4.1–A4.9) — incl. English + **Hindi** vernacular keywords.

**Pillar B**
- B1 Technical Audit (B1.1–B1.9) — cloud crawler w/ JS rendering, CWV, indexability, structured-data validation, **AI-crawler access audit**, severity scoring.

**Pillar C (thin slice — proves the moat)**
- C1 Fix Queue core (kanban, diff preview, approval, deploy, verify, rollback, audit log).
- C2 Schema injection — deploy JSON-LD via **WordPress + Shopify plugins** and/or **Cloudflare Worker**.
- Meta title/description regeneration (subset of C3.2) — the second executable action type.

**Platform wrapper**
- E onboarding (domain + GSC connect → insight <10min → proposed fix <48h), K Pulse dashboard + role-adaptive shell, G billing (Starter + Growth tiers, Stripe), F accounts/projects, J English + Hindi UI.

**Research (parallel track)**
- **X0 Profound Agents teardown** → gates Phase 2 C-layer design.

### Milestones
| # | Milestone | Definition of done |
|---|---|---|
| M1.1 | **Data spine live** | Ingestion → ClickHouse → dashboard query <500ms on real data |
| M1.2 | **Visibility MVP** | A1+A2+A3 rendering with confidence bands for a pilot domain |
| M1.3 | **Diagnosis MVP** | B1 crawl produces scored `Finding` objects with `Action` mappings |
| M1.4 | **First fix deployed** | A schema fix goes proposed→approved→deployed→verified on a real site via plugin/worker |
| M1.5 | **Rollback proven** | A deployed fix is automatically rolled back in a staged test |
| M1.6 | **Self-serve onboarding** | New user reaches first insight <10 min unaided |
| M1.7 | **Billing live** | Starter/Growth purchasable via Stripe |

### Exit criteria (from blueprint)
- **50 design partners** onboarded.
- **Demonstrable citation-rate lift for ≥10** of them.
- **<48h time-to-first-fix** achieved and instrumented.

---

## PHASE 2 — Depth (months 6–18) · Team 12–18

**Goal:** Turn the proof into a product with defensible depth. Deepen A & B, and light up the execution + intelligence layers that drive retention and expansion.

### Scope
**Pillar A**
- A5 Competitor Intelligence (keyword/citation/content/entity/backlink gap).
- A6 Backlink & Mention Index — **licensed** link data + unlinked mention tracking.

**Pillar B**
- B2 Content & Extractability Scoring — incl. the **proprietary extractability scorer** (cited vs non-cited training signal → data moat).
- B3 Entity & Knowledge Graph Audit.
- B5 Local SEO Audit.

**Pillar C**
- C3 Content actions (rewrites, meta at scale, internal links).
- C4 Technical fixes incl. **GitHub PR export** for headless sites.
- C5 GBP automation.

**Pillar D**
- D1 AI Copilot (⌘K, RAG over ClickHouse, cited answers).
- D3 Reporting + agency white-label (Looker connector, scheduled reports, multi-workspace).

**Platform**
- Agency tier + white-label, F6 SSO (early enterprise), **6 UI languages**, **India pricing launch** (UPI/Razorpay), GSC generative-report ingestion.

### Milestones
| # | Milestone | Definition of done |
|---|---|---|
| M2.1 | **Extractability scorer v1** | Classifier beats heuristic baseline on held-out cited/non-cited set |
| M2.2 | **Entity graph online** | Entity-first joins power a cross-SEO/GEO query in the Copilot |
| M2.3 | **Content + technical fixes GA** | C3 + C4 (incl. GitHub PRs) deployable end-to-end |
| M2.4 | **Copilot GA** | NL question → cited, drill-downable answer <3s |
| M2.5 | **Agency white-label GA** | Multi-client grid + branded reports shipping |
| M2.6 | **India pricing live** | Region-fair pricing enforced, UPI/Razorpay billing working |

### Exit criteria (from blueprint)
- **$1.5M ARR.**
- **Agency logos** signed.
- **Published case studies** with revenue attribution.

---

## PHASE 3 — Platform (months 18–36) · Team 25+

**Goal:** Enterprise-grade + agent-native. Turn accumulated data into a moat competitors cannot retrofit.

### Scope
- B4 Log-file analysis + **Enterprise tier** (SSO, SLA, unlimited scale, brand-voice fine-tune).
- C6 Citation-earning playbooks.
- D2 Attribution & forecasting suite.
- D4 **API + MCP server GA**; ACP/UCP agent-ready commerce feeds.
- A6.3 **Proprietary web-scale mention index**.
- More engines: **Baidu / Naver / Yandex** tracking.
- **EU + India data residency.**

### Milestones
| # | Milestone | Definition of done |
|---|---|---|
| M3.1 | **Enterprise tier GA** | Log analysis, SSO, SLA, residency options live |
| M3.2 | **MCP server GA** | External agent queries + acts on customer SEO data |
| M3.3 | **Mention index v1** | Proprietary index replaces licensed mention data for core markets |
| M3.4 | **Forecasting suite** | Ranking→traffic→revenue forecast shipped to executive view |
| M3.5 | **Multi-engine GA** | Baidu/Naver/Yandex tracked for relevant markets |

### Exit criteria (from blueprint)
- **First $50k+ enterprise contracts.**
- **Measurable agent-referred revenue** for e-commerce customers.

---

## Dependencies & critical path

```
Data spine (M1.1) ──► Visibility MVP (M1.2) ──► Diagnosis MVP (M1.3) ──► First fix (M1.4) ──► Rollback (M1.5)
                                                        │
Entity-first data model (arch) ─────────────────────────┴──► Entity graph (M2.2) ──► Extractability scorer (M2.1) ──► Content actions (M2.3)
X0 Profound teardown ───────────────────────────► C-layer design freeze ──► C3/C4/C5
```

**Hard sequencing rules:**
1. The **entity-first data model** (see Architecture) is laid down in Phase 1 even though its payoff lands in Phase 2 — it cannot be retrofitted.
2. The **`Finding → Action` contract** ships with B1 in Phase 1, so C-layer work in Phase 2 is integration, not redesign.
3. **Confidence-band / n-sampling** infrastructure is Phase-1 foundational, not a later polish — it's the trust signature.
4. The **24-month raw lake** starts collecting in Phase 1 so Phase-2 scorer retraining has history.

---

## Per-feature reference specs

Because each feature is "a complicated play," every focus-pillar module has its own in-depth spec. Start here:

- Pillar A: [A1](feature-specs/A1-rank-tracking.md) · [A2](feature-specs/A2-ai-visibility-geo.md) · [A3](feature-specs/A3-unified-share-of-voice.md) · [A4](feature-specs/A4-keyword-prompt-research.md) · [A5](feature-specs/A5-competitor-intelligence.md) · [A6](feature-specs/A6-backlink-mention-index.md)
- Pillar B: [B1](feature-specs/B1-technical-audit.md) · [B2](feature-specs/B2-content-extractability.md) · [B3](feature-specs/B3-entity-knowledge-graph.md) · [B4](feature-specs/B4-log-file-analysis.md) · [B5](feature-specs/B5-local-seo-audit.md)
- [Feature-spec template](feature-specs/_TEMPLATE.md) for new modules.
