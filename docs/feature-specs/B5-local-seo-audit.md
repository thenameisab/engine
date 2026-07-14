# B5 — Local SEO Audit · Reference Spec

**Pillar:** B · **Phase:** v1.5 · **Priority:** P1 · **Moat weight:** ◆◆
**PRD ref:** [Master PRD §4 B5](../00-Master-PRD.md) · **Status:** Draft

## 1. Problem & job-to-be-done
For the "Delhi kirana store to Fortune 500" span, local visibility is core — especially for the India SMB wedge. B5 audits Google Business Profile health, NAP consistency, and reviews, and feeds the **local SoV** into the Unified Visibility Score (A3). It pairs directly with GBP automation (C5) so findings become one-click fixes — the local expression of the moat.

## 2. Users & roles
- **Owner (SMB):** primary — "Is my Google listing right and are reviews healthy?"
- **Agency:** multi-location clients.
- **Analyst:** NAP/citation consistency detail.

## 3. Scope
**In (v1.5):** B5.1 GBP completeness, B5.2 citation consistency (NAP), B5.3 review velocity & sentiment, B5.4 local-pack tracking (shared with A1.4).
**Out:** full reputation-management suite (drafts via C5 only).

## 4. Functional requirements
1. **GBP completeness:** audit profile fields (categories, hours, attributes, photos, description) for coverage + accuracy via GBP API connector.
2. **NAP consistency:** check Name/Address/Phone across directories (market-specific: G2/Capterra globally; JustDial/Sulekha etc. in India).
3. **Reviews:** track velocity + sentiment over time.
4. **Local-pack tracking:** map-pack presence by geo (reuses A1.4 SERP-feature capture).
5. Emit `Finding`s → GBP automation actions (C5) and citation tasks (C6).

## 5. Data & sources
- GBP API, directory data (licensed/crawled per market), SERP adapter (local pack).
- Storage: GBP/NAP state in Postgres; review + local-pack history in ClickHouse.
- Entity linkage: locations as entities (multi-location = multiple linked entities).

## 6. Intelligence / models
- Review **sentiment** classifier (multilingual — Indic support matters here).
- Deterministic NAP matching + fuzzy address resolution.

## 7. Finding → Action mapping
| Finding | Action (C5/C6) |
|---|---|
| Incomplete GBP field | Attribute update (C5.3) |
| NAP inconsistency | Directory citation correction task (C6.3) |
| Unanswered reviews | Review reply draft (C5.4) |
| Missing GBP posts | GBP post (C5.1) |

## 8. UX
- Lead: **local visibility score** for the location, then the fix list.
- Multi-location grid for agencies/chains.

## 9. Non-functional
- Multilingual review sentiment (Hindi + regional) is a quality bar for the India wedge.
- Per-location scaling for chains/enterprise.

## 10. Dependencies & risks
- Depends on GBP API connector, directory data per market, A1.4.
- **Risk:** directory coverage varies by market → prioritize India + core markets first.

## 11. Success metrics
- GBP completeness lift after fixes; NAP consistency %; review-response rate via drafts.

## 12. Open questions
- Which India directories to license vs crawl? Multi-location entity modeling for large chains?
