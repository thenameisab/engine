# B4 — Log File Analysis · Reference Spec

**Pillar:** B · **Phase:** v2 (enterprise) · **Priority:** P2 · **Moat weight:** ◆
**PRD ref:** [Master PRD §4 B4](../00-Master-PRD.md) · **Status:** Draft (deferred to Phase 3)

## 1. Problem & job-to-be-done
Enterprise sites need to know how crawlers — including **AI bots** (GPTBot/ClaudeBot/PerplexityBot) — actually spend crawl budget, and which pages are never reached. Log-file analysis is a classic enterprise-SEO capability, upgraded here with **AI-bot traffic analysis** (a GEO-native angle). It's an enterprise-tier feature and a deliberate Phase-3 item — high infra cost, narrow (large-site) audience.

## 2. Users & roles
- **Enterprise Analyst:** primary — crawl budget, bot behavior, orphan pages.
- **Executive:** "Are AI crawlers even reading our content?"

## 3. Scope
**In (v2/Phase 3):** B4.1 crawl-budget analysis, B4.2 AI-bot traffic analysis, B4.3 orphan-page detection, B4.4 log ingestion connectors (Cloudflare/CDN/server).
**Out:** anything below enterprise tier.

## 4. Functional requirements
1. Ingest server/CDN logs (Cloudflare Logpush is a natural first connector — aligns with our stack).
2. Attribute hits by bot (Googlebot, Bingbot, GPTBot, ClaudeBot, PerplexityBot, etc.).
3. **Crawl-budget analysis:** bot hit distribution vs page value; wasted crawl detection.
4. **AI-bot analysis:** are AI crawlers reaching key pages? frequency? blocked? (ties to B1.6).
5. **Orphan pages:** pages no crawler reaches.
6. Emit `Finding`s → robots/sitemap/internal-link actions.

## 5. Data & sources
- Customer logs via connectors (Cloudflare Logpush, S3 log drops, server upload).
- Storage: parsed log events → ClickHouse (high volume — its sweet spot); raw logs → R2/Parquet.

## 6. Intelligence / models
- Mostly aggregation + heuristics on ClickHouse. No LLM. Statistical anomaly detection on bot patterns.

## 7. Finding → Action mapping
| Finding | Action |
|---|---|
| AI bot not reaching key pages | robots/sitemap fix (C4), internal-link fix (C3) |
| Crawl budget wasted on low-value URLs | robots/noindex/redirect (C4) |
| Orphan pages | Internal-link insertion (C3) |

## 8. UX
- Lead: **crawl-budget efficiency** + AI-bot coverage, then drilldowns.

## 9. Non-functional
- High log volume → ClickHouse ingestion pipeline sized for enterprise; retention tiered.

## 10. Dependencies & risks
- Depends on log connectors + ClickHouse scale; gated to enterprise tier.
- **Risk:** log volume/cost → tiered retention + enterprise pricing covers COGS.

## 11. Success metrics
- AI-bot coverage of priority pages before/after; crawl-waste reduction.

## 12. Open questions
- Which log formats/connectors to support first beyond Cloudflare Logpush?
