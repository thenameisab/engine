# B2 — Content & Extractability Scoring · Reference Spec

**Pillar:** B · **Phase:** v1.5 · **Priority:** P0 · **Moat weight:** ◆◆◆
**PRD ref:** [Master PRD §4 B2](../00-Master-PRD.md) · **Status:** Draft

## 1. Problem & job-to-be-done
Getting cited by AI engines depends on whether a page is **extractable**: answer-first, self-contained passages, strong entity coverage, credible E-E-A-T. B2 scores this and — via the **proprietary extractability scorer trained on cited vs non-cited pages** — becomes a **compounding data moat**: every polling cycle labels more pages, the model improves, and the signal is one competitors can't buy. This is arguably the highest-moat item in Pillars A & B.

## 2. Users & roles
- **Analyst / content:** page-level scores + specific rewrite guidance.
- **Owner:** "Which pages should I fix to get cited?" → Fix Queue.
- **Agency:** content story per client.

## 3. Scope
**In (v1.5):** B2.1 entity/topic coverage, B2.2 answer-first structure, B2.3 passage self-containment, B2.4 E-E-A-T signal detection, B2.5 content-decay alerts, B2.6 **proprietary extractability scorer**.
**Out:** full content drafting (that's C3 / Content Studio; B2 scores, C3 fixes).

## 4. Functional requirements
1. Score **entity/topic coverage** vs the target entity set (from B3 graph).
2. Score **answer-first structure** (does the page lead with the answer?).
3. Score **passage self-containment** (can a passage stand alone as a quote?).
4. Detect **E-E-A-T signals** (authorship, citations, freshness, expertise markers).
5. **Content-decay alerts:** detect traffic/citation decline per page over time (joins A1/A2 history).
6. **Extractability scorer:** fine-tuned classifier trained on our own cited-vs-non-cited page corpus (from A2 archive) → per-page extractability probability.
7. Emit `Finding`s mapping to specific C3 rewrite actions.

## 5. Data & sources
- **Training signal (the moat):** A2 answer archive labels pages as cited/not-cited → continuously growing labeled corpus in R2/Parquet.
- Crawled content (B1) as features; page embeddings in Qdrant.
- Scores + decay series → ClickHouse.

## 6. Intelligence / models
- **Self-hosted fine-tuned classifier** (extractability) — retrained periodically on the growing corpus; retroactive reprocessing from the 24-mo lake when the model improves.
- Embeddings (multilingual-e5) for coverage/self-containment; LLM (routed, cached) for E-E-A-T heuristics and rewrite drafting hand-off.
- Cost: self-hosted inference; small-model routing.

## 7. Finding → Action mapping
| Finding | Action (C3) |
|---|---|
| Not answer-first | Answer-first paragraph rewrite |
| Poor self-containment | Restructure into quotable passages / FAQ blocks |
| Entity coverage gap | Add covering sections (grounded in entity data) |
| Weak E-E-A-T | Add authorship/citation/freshness signals |
| Content decay | Refresh/update action |

## 8. UX
- Lead: **extractability score** per page (with band), then the specific structural fixes.
- Content Studio surfaces the rewrite diff before approval (Fix Queue loop).

## 9. Non-functional
- Scorer quality tracked vs held-out cited/non-cited set (must beat heuristic baseline — Roadmap M2.1).
- Confidence bands on extractability probabilities (honesty signature).

## 10. Dependencies & risks
- Depends on A2 archive (labels), B3 (entity sets), B1 (content), GPU inference.
- **Risk:** early corpus too small → start with heuristic + few-shot LLM, swap to trained classifier as labels accumulate.

## 11. Success metrics
- Classifier AUC vs baseline; correlation of score improvement (post-fix) with actual citation-rate lift (closes the loop).

## 12. Open questions
- Minimum labeled corpus size before trained classifier beats heuristics? Per-language scorer vs multilingual single model?
