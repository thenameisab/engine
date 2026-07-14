# B3 — Entity & Knowledge Graph Audit · Reference Spec

**Pillar:** B · **Phase:** v1.5 · **Priority:** P1 · **Moat weight:** ◆◆◆
**PRD ref:** [Master PRD §4 B3](../00-Master-PRD.md) · **Status:** Draft

## 1. Problem & job-to-be-done
The entity-first data model is Engine's architectural moat; B3 is the module that **operationalizes it as a diagnosis**. AI engines and Google's Knowledge Graph reason over entities, not URLs. B3 audits whether a business's entity is consistent, corroborated, and correctly mapped across the web — and fixes gaps via schema/knowledge-graph actions. This is what lets SEO and GEO be "one world," and it's what incumbents can't retrofit.

## 2. Users & roles
- **Analyst:** entity consistency, sameAs, Knowledge Panel status.
- **Owner:** "Do search + AI understand who I am correctly?"
- **Executive/Enterprise:** brand-entity integrity.

## 3. Scope
**In (v1.5):** B3.1 Wikidata/sameAs consistency, B3.2 schema entity mapping, B3.3 Knowledge Panel status, B3.4 cross-web entity corroboration score.
**Out:** building a full external knowledge graph (we map to Wikidata, not replace it).

## 4. Functional requirements
1. Resolve the customer's core entity to a canonical ID (Wikidata) and record `wikidata_id` on the entity.
2. Audit **sameAs / cross-web identity consistency** (social, directories, official profiles).
3. **Schema entity mapping:** verify on-site schema correctly identifies and links the entity.
4. **Knowledge Panel status:** presence + accuracy of the Google Knowledge Panel.
5. **Corroboration score:** how consistently the web corroborates the entity's attributes.
6. Emit `Finding`s → schema fixes (C2), sameAs corrections, content/entity actions.

## 5. Data & sources
- Wikidata + public knowledge sources, crawler (on-site schema), A6 mentions (corroboration), SERP (Knowledge Panel).
- Storage: entity graph in Postgres (canonical) + embeddings in Qdrant (resolution); corroboration events in ClickHouse.

## 6. Intelligence / models
- **Entity resolution/disambiguation** (embeddings + heuristics; MuRIL/e5) — the technical core, shared with A6.
- LLM (routed, cached) for attribute reconciliation.

## 7. Finding → Action mapping
| Finding | Action |
|---|---|
| Inconsistent sameAs | Schema/sameAs correction (C2) |
| Missing entity schema | JSON-LD entity markup injection (C2) |
| Weak corroboration | Content + digital-PR to corroborate (C3/C6) |
| Knowledge Panel inaccuracy | Correction workflow + schema support |

## 8. UX
- Lead: **entity strength/corroboration score**, then the specific inconsistencies mapped to fixes.
- Visualize the entity and its cross-web links (the "one entity" view that ties SEO+GEO).

## 9. Non-functional
- Entity-resolution precision is the quality bar (shared with A6).
- Powers cross-pillar joins — correctness here affects A3, A5, B2.

## 10. Dependencies & risks
- Foundational to the entity-first model; depends on resolution infra + crawler + A6.
- **Risk:** wrong entity resolution poisons downstream joins → conservative confidence thresholds, human confirmation for the core entity during onboarding.

## 11. Success metrics
- Resolution precision/recall; corroboration-score improvement after fixes; Knowledge Panel accuracy gains.

## 12. Open questions
- How much human confirmation at onboarding vs full auto-resolution? Non-Wikidata canonical sources for entities absent from Wikidata?
