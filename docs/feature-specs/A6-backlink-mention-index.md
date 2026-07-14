# A6 — Backlink & Mention Index · Reference Spec

**Pillar:** A · **Phase:** v1.5 (license) → v2 (proprietary index) · **Priority:** P1 · **Moat weight:** ◆◆◆
**PRD ref:** [Master PRD §3 A6](../00-Master-PRD.md) · **Status:** Draft

## 1. Problem & job-to-be-done
For AI visibility, **unlinked brand mentions correlate ~3× stronger than backlinks** with AI Overview presence. Yet incumbents index links, not mentions. Engine tracks both — licensing links initially and building a proprietary **mention index** in v2. The mention index is cheaper to build than a full link graph and is a *GEO-native asset* that directly feeds citation-earning playbooks. This is a genuine data moat.

## 2. Users & roles
- **Analyst:** link/mention profiles, quality, gaps.
- **Owner:** "Who's talking about me, and is it helping AI cite me?"
- **Agency:** off-site story per client.

## 3. Scope
**In v1.5:** A6.1 licensed backlink data, A6.2 unlinked mention tracking, A6.4 citation-domain intelligence (which domains AI engines cite in your category), A6.5 quality scoring.
**In v2:** A6.3 proprietary web-scale **mention** index.
**Out (year one):** proprietary web-scale *link* graph (license it; not worth building).

## 4. Functional requirements
1. Ingest licensed backlink data (DataForSEO-class) via connector; refresh on schedule.
2. Track **unlinked brand mentions** across the web (news, forums, directories, social where accessible).
3. **Citation-domain intelligence:** from A2 answer archive, rank domains AI engines cite in the customer's category → target list for C6.
4. Score link/mention **quality** (authority, relevance, sentiment).
5. (v2) Build a proprietary mention index: crawl + entity-resolve mentions at web scale, dedup, store entity-linked.
6. Emit `Finding`s: high-value citation domains where the brand is absent; negative-sentiment mentions.

## 5. Data & sources
- **v1.5:** licensed link API; mention discovery via crawler + news/API sources; A2 answer archive for citation domains.
- **v2:** proprietary crawl → mention index.
- **Storage:** mentions/links + quality scores → ClickHouse (events) + entity linkage in the graph; raw captures → R2/Parquet; embeddings for entity resolution → Qdrant.

## 6. Intelligence / models
- **Entity resolution** (link a mention to the right entity) — MuRIL/e5 embeddings + disambiguation; the hard part of the mention index.
- Sentiment classifier on mention context.
- Cost: mention indexing is cheaper than link graphs; self-hosted crawl + embeddings.

## 7. Finding → Action mapping
| Finding | Action |
|---|---|
| Absent from high-citation domain | Digital-PR outreach draft + target (C6) |
| Incomplete third-party profile (G2/Capterra/JustDial) | Profile-completeness task (C6) |
| Negative mention cluster | Flag for review/response |

## 8. UX
- Lead: "Citation opportunities" (domains AI cites in your category where you're missing), then full link/mention tables.
- Mentions and links unified under the entity, not shown as two disconnected worlds.

## 9. Non-functional
- Entity-resolution precision is the quality bar for the mention index.
- Scale: web-scale index built incrementally, market by market.

## 10. Dependencies & risks
- Depends on entity model (resolution), A2 archive, crawler.
- **Risk:** mention entity-resolution accuracy → phase it (license first, build v2 once resolution is proven); start with high-value markets.

## 11. Success metrics
- Entity-resolution precision/recall; citation-domain target → earned-citation conversion (closes the loop with C6).

## 12. Open questions
- Which mention sources are licensable vs must-crawl per market? Cost ceiling for v2 index per market?
