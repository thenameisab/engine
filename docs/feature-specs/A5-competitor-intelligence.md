# A5 — Competitor Intelligence · Reference Spec

**Pillar:** A · **Phase:** v1.5 · **Priority:** P1 · **Moat weight:** ◆◆
**PRD ref:** [Master PRD §3 A5](../00-Master-PRD.md) · **Status:** Draft

## 1. Problem & job-to-be-done
Visibility is relative. Users need to know where competitors beat them — across **both** classic SEO and GEO — on one entity model. The unified gap analysis (keyword + citation + content + entity + backlink) is something GEO startups can't do (no SEO depth) and incumbents can't do cleanly (URL-first, not entity-first). This is a concrete expression of the "unified on one entity model" moat.

## 2. Users & roles
- **Analyst:** primary — gap tables, prioritization, export.
- **Owner:** "Who's beating me and where?" (top gaps only).
- **Agency:** competitive story per client.

## 3. Scope
**In (v1.5):** A5.1 keyword gap, A5.2 **citation gap** (prompts competitors are cited for, you aren't), A5.3 content gap, A5.4 entity gap, A5.5 backlink gap, A5.6 competitor-set management.
**Out:** predictive competitor forecasting (later).

## 4. Functional requirements
1. Manage competitor sets per project/market (auto-suggest from SERP + AI-citation co-occurrence; manual add).
2. **Keyword gap:** keywords competitors rank for that you don't (from A1 data across sets).
3. **Citation gap:** prompts where competitors are cited and you aren't (from A2) — the GEO-native gap no SEO tool has.
4. **Content gap:** topics/entities they cover that you don't (from crawl + entity model).
5. **Entity gap:** entity coverage & strength differential (from B3).
6. **Backlink gap:** referring domains they have that you don't (licensed data, A6).
7. Prioritize gaps by predicted impact; each gap emits a `Finding` for the Fix Queue.

## 5. Data & sources
- Derived from A1 (rankings), A2 (citations), crawler (content), B3 (entities), A6 (links). No major new source beyond competitor crawl budget.
- Storage: gap computations in ClickHouse; competitor sets in Postgres.

## 6. Intelligence / models
- Embedding-based topic/entity overlap; deterministic set-difference for keyword/citation/backlink gaps.
- LLM (routed) only for summarizing "why this gap matters." Category-cached.

## 7. Finding → Action mapping
| Gap | Action |
|---|---|
| Content gap | Draft covering content (C3) |
| Citation gap | Extractability rewrite + citation-earning playbook (C3/C6) |
| Entity gap | Knowledge-graph/schema fix (B3/C2) |
| Backlink gap | Digital-PR outreach (C6) |

## 8. UX
- Lead: "Biggest gaps to close" (ranked), then the four gap tables under a shared filter.
- Each gap row links straight to the action it would create.

## 9. Non-functional
- Competitor crawl respects per-project budgets; gap queries <500ms on ClickHouse.

## 10. Dependencies & risks
- Depends on A1, A2, A6, B3, crawler, entity model — hence v1.5 (needs the graph online).
- **Risk:** competitor crawl cost → cap and cache.

## 11. Success metrics
- Gap→action conversion; % of closed gaps that moved the metric (verified via Fix Queue loop).

## 12. Open questions
- Competitor-set auto-suggestion signal weighting (SERP co-rank vs AI co-citation)?
