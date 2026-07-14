# A4 — Keyword & Prompt Research · Reference Spec

**Pillar:** A · **Phase:** MVP · **Priority:** P0 · **Moat weight:** ◆◆
**PRD ref:** [Master PRD §3 A4](../00-Master-PRD.md) · **Status:** Draft

## 1. Problem & job-to-be-done
Users need to decide *what to track and target* — both classic keywords **and** the prompts people ask AI engines. This is the on-ramp: it populates A1's tracked keywords and A2's prompt bank. The wedge: **vernacular + prompt research**. Incumbents are English-first and keyword-only; Engine covers Hinglish/Indic-script/transliteration and treats *prompts* as first-class research objects.

## 2. Users & roles
- **Owner:** "Suggest what I should target" (guided).
- **Analyst:** full research surface — volume, difficulty, clustering, exports, query builder.
- **Agency:** research per client.

## 3. Scope
**In (MVP):** A4.1 volume, A4.2 difficulty, A4.3 intent classification, A4.4 semantic clustering, A4.5 question mining, A4.6 query fan-out discovery, A4.7 **vernacular/transliterated keywords (English + Hindi at MVP)**, A4.8 prompt research, A4.9 SERP↔answer overlap.
**Out:** full 6-language vernacular (Phase 2); autonomous prompt generation at scale.

## 4. Functional requirements
1. Return volume + modeled difficulty per keyword (managed API sourced).
2. Classify **intent** (informational/navigational/commercial/transactional).
3. **Semantic clustering** via HDBSCAN over multilingual-e5 embeddings.
4. **Question mining** (PAA + question-shaped queries) and **query fan-out** (sub-queries an AI engine expands a prompt into).
5. **Vernacular:** generate/normalize Hinglish, Devanagari, and transliteration variants of seed terms; cluster them with their English equivalents via embeddings.
6. **Prompt research:** surface prompts users actually ask AI engines in the category (seed from answer-archive + LLM expansion) → populate A2 prompt bank.
7. **Overlap:** flag which keywords also trigger AI answers (bridges A1↔A2).
8. One-click push discovered items into A1 tracking / A2 prompt bank.

## 5. Data & sources
- **Sources:** managed keyword-data API (volume/difficulty), our A2 answer archive (prompt mining), SERP adapter (SERP/AI-overlap).
- **Storage:** research sets → Postgres; embeddings → pgvector/Qdrant; overlap/volume history → ClickHouse.

## 6. Intelligence / models
- Embeddings (multilingual-e5, self-hosted), HDBSCAN clustering, IndicBERT/MuRIL for Indic entity/intent handling.
- LLM (mid-tier, routed via gateway) for prompt expansion + fan-out; cached at category level.
- Cost: self-hosted embeddings + small-model routing keep this cheap.

## 7. Finding → Action mapping
- Not a diagnosis module, but **content-gap discoveries** here seed `Finding`s consumed by Content Studio / C3 (e.g., "high-value prompt with no covering page" → draft content action).

## 8. UX
- Lead: "Top opportunities" (one prioritized list), then the full table/query builder.
- Vernacular variants grouped with their base concept, not scattered.
- Clear "add to tracking / add to prompt bank" affordances.

## 9. Non-functional
- Clustering scalable to large seed sets; research queries responsive.
- Vernacular normalization quality is a tracked bar (transliteration accuracy).

## 10. Dependencies & risks
- Depends on embeddings infra, keyword-data API, A2 answer archive.
- **Risk:** vernacular/transliteration accuracy → invest in IndicBERT/MuRIL fine-tuning; treat Hindi as the MVP quality bar.

## 11. Success metrics
- % of tracked keywords/prompts sourced via A4; vernacular variant precision; opportunity→tracked conversion.

## 12. Open questions
- Which keyword-data vendor for Indic volume (coverage is thin)? Blend multiple?
