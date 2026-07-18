# Engine — Product Documentation

Engine — *"The AI visibility platform that fixes what it finds."*
Unified SEO + GEO + local visibility with an agentic **Fix Queue** that deploys, verifies, and rolls back fixes into the customer's own CMS/code/GBP.

## Core documents
1. **[Master PRD](00-Master-PRD.md)** — the full feature catalogue, granular → end-to-end micro-SaaS, across Pillars A/B/C/D + platform wrapper.
2. **[Product Roadmap](10-Roadmap.md)** — phased build (MVP / Depth / Platform), milestones, exit criteria. Current focus: **Pillars A & B**.
3. **[Architecture Foundations](20-Architecture.md)** — four-layer system + the near-term **GitHub + Cloudflare Pages/Workers** deployment spine.
4. **[Design System & Motion Language](30-Design-System.md)** — the visual identity: Liquid Glass material, the confidence-band signature, instrument-mono type, Apple/Emil motion rules. Live reference: **[Pulse hero mockup](mockups/pulse.html)**.
5. **[External Integrations & Configuration](40-Integrations.md)** — every external account (Google OAuth/GSC, Stripe, Serper.dev SERP, OpenAI, Gemini): what/why, provisioning, env vars, cost, and the provider decisions. Backed by `packages/config` + `GET /health/integrations`.
6. **[X0 — Profound Agents Teardown](50-X0-Profound-Teardown.md)** — competitive read on Profound's Agents/Aim execution wedge and the resulting design-freeze recommendation for Engine's Phase 2 C-layer (C2 technical fixes stay the priority lane; C3 content generation must flow through the existing Fix Queue contract, not a parallel drafting tool).

## Per-feature reference specs (`feature-specs/`)
Each feature is a complicated play with its own deep-dive:

| Pillar A — Visibility | Pillar B — Diagnosis |
|---|---|
| [A1 Rank Tracking](feature-specs/A1-rank-tracking.md) | [B1 Technical Audit](feature-specs/B1-technical-audit.md) |
| [A2 AI Visibility / GEO](feature-specs/A2-ai-visibility-geo.md) | [B2 Content & Extractability](feature-specs/B2-content-extractability.md) |
| [A3 Unified Share of Voice](feature-specs/A3-unified-share-of-voice.md) | [B3 Entity & Knowledge Graph](feature-specs/B3-entity-knowledge-graph.md) |
| [A4 Keyword & Prompt Research](feature-specs/A4-keyword-prompt-research.md) | [B4 Log File Analysis](feature-specs/B4-log-file-analysis.md) |
| [A5 Competitor Intelligence](feature-specs/A5-competitor-intelligence.md) | [B5 Local SEO Audit](feature-specs/B5-local-seo-audit.md) |
| [A6 Backlink & Mention Index](feature-specs/A6-backlink-mention-index.md) | |

New specs use the [template](feature-specs/_TEMPLATE.md).

## The strategic spine (read this first)
From the competitor teardown: **measuring AI visibility is table stakes** (Profound, Peec already do it). Engine's defensible wedge is the **Fix Queue** — deploy → verify → rollback into production surfaces, with audit logs. So Pillars A & B are built as the **necessary input to execution**, and every Pillar B finding must map to an executable action (the `Finding → Action` contract, frozen day one).

Two architectural decisions that cannot be retrofitted: the **entity-first data model** and the **`Finding → Action` contract**.
