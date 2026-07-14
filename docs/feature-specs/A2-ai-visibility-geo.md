# A2 — AI Visibility (GEO) · Reference Spec

**Pillar:** A · **Phase:** MVP · **Priority:** P0 · **Moat weight:** ◆◆◆
**PRD ref:** [Master PRD §3 A2](../00-Master-PRD.md) · **Status:** Draft

## 1. Problem & job-to-be-done
Answer engines (ChatGPT, Perplexity, Gemini, Copilot, Google AI Overviews/AI Mode) increasingly mediate discovery. Businesses need to know **whether, where, and how accurately** they show up in AI answers, and their **share vs competitors** (Share of Model). Critically — per the competitor teardown — *measuring AI citations is now table stakes* (Profound, Peec do it). So A2's job is **not** to be a differentiator on its own; it is to be (a) the AI half of the Unified Visibility Score and (b) the **highest-signal trigger source for the Fix Queue**. Our edge here is **honesty** (confidence bands + n-sampling) and **feeding execution**, not raw measurement.

## 2. Users & roles
- **Owner:** "Do AI engines mention me, yes/no, and is it accurate?"
- **Analyst:** per-engine, per-prompt citation rates with bands; raw answer archive.
- **Executive:** Share of Model trend in the unified score.
- **Agency:** per-client GEO rollups.

## 3. Scope
**In (MVP):** A2.1 prompt monitoring across 5 engines, A2.2 citation-source tracking, A2.3 sentiment, A2.4 accuracy, A2.5 Share of Model, A2.6 **n-sampling + confidence bands**, A2.7 API↔consumer reconciliation, A2.8 prompt-bank mgmt, A2.9 engine drilldown, A2.10 answer archive.
**Out:** Baidu/Naver/Yandex answer surfaces (Phase 3); fully automated prompt discovery (basic auto-suggest only at MVP).

## 4. Functional requirements
1. **Adapter-per-engine** behind a common interface (OpenAI, Gemini, Perplexity Sonar, Anthropic + AI Overviews via SERP capture).
2. Run each prompt **n=3–5×/cycle**; aggregate to a citation-rate **confidence band** `{low, point, high}` — never a point estimate.
3. **Two capture modes:** API (daily) + consumer-surface headless capture (weekly, stratified sample); **statistically reconcile** the two and label method.
4. For each answer: detect brand/entity citation, capture **which sources were cited**, score **sentiment** and **accuracy** of the brand mention.
5. Compute **Share of Model** = your citations ÷ total competitor citations for a prompt set.
6. Manage a **prompt bank** per project/category (curated + auto-suggested + user-added).
7. Archive **raw answer text** to the lake (24-mo) for reprocessing when scorers improve.
8. Emit `Finding`s: "not cited for high-value prompt X where competitor is," "inaccurate claim about brand," "cited source Y we could earn."

## 5. Data & sources
- **Sources:** LLM APIs; headless consumer capture; SERP adapter for AI Overviews.
- **Storage:** citation events + scores → **ClickHouse**; raw answers → **R2/Parquet**; prompt banks → **Postgres**; answer/entity embeddings → **pgvector/Qdrant**.
- **Entity linkage:** citations attach to `entity_id`, joining with rankings (A1) and local (B5) in A3.

## 6. Intelligence / models
- **Citation/entity detection & accuracy:** entity extraction (MuRIL/IndicBERT for Indic, multilingual-e5 embeddings) + LLM verification for accuracy scoring.
- **Sentiment:** classifier on the answer passage mentioning the brand.
- **Cost control (critical):** **category-level prompt caching shared across customers** in the same category (biggest lever, 40–60% saving); small-model routing for detection/classification, frontier model only where needed; n-sampling budget gated by plan cadence.

## 7. Finding → Action mapping
| Finding | Action(s) |
|---|---|
| Absent for high-value prompt | Content extractability rewrite (C3), schema (C2), citation-earning playbook (C6) |
| Inaccurate brand claim in answers | Content/entity correction (C3/B3), knowledge-graph fix (B3) |
| Competitor cites source we lack | Digital-PR outreach target (C6) |

## 8. UX
- **Honesty is the visual signature:** every AI-visibility chart renders confidence bands; point values shown only with their range.
- Lead metric: **Share of Model** (one number) → drill into engine → prompt → raw answer.
- "Directional, not exact" framing baked into copy.

## 9. Non-functional
- n-sampling mandatory; bands stored, not computed client-side.
- Dashboard queries <500ms; polling is async (Cloudflare Queues/Cron → engine adapters).
- Method transparency: every datapoint labeled api/consumer/reconciled.

## 10. Dependencies & risks
- Depends on LLM gateway, prompt-cache infra, entity model.
- **Risk:** LLM providers block programmatic capture → API-first (sanctioned), consumer capture only sampled, pursue publisher/API partnerships (e.g. Perplexity).
- **Risk:** non-determinism undermines trust → n-sampling + bands + honest framing (this *is* the mitigation and the differentiator).

## 11. Success metrics
- Citation-detection precision/recall vs human label ≥0.9; reconciliation error band within target; prompt-cache hit rate ≥40%.

## 12. Open questions
- Consumer-capture sampling rate vs cost per market? Accuracy-scoring model: self-host vs frontier API tradeoff?
