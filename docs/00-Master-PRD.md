# Engine — Master Product Requirements Document (PRD)

**Product:** Engine — *"The AI visibility platform that fixes what it finds."*
**Status:** v1.0 · Living document · Last updated 2026-07-14
**Owner:** Product
**Source inputs:** AI SEO Platform Blueprint v1.0 (internal), Visio Competitive Landscape Note (internal)

> Working note on naming: the blueprint used "Visio" as a placeholder. This product is **Engine**. Where the blueprint says Visio, read Engine.

---

## 0. How to read this document

This is the **master feature catalogue** — the full universe of what Engine could be, from a single granular capability up to the end-to-end micro-SaaS. It is deliberately exhaustive so nothing is lost; the [Roadmap](10-Roadmap.md) decides *when* each item is built, and the [per-feature reference specs](feature-specs/) decide *how*.

Each feature carries:
- **ID** — stable reference (e.g. `A1.3`) used across roadmap and specs.
- **Phase** — MVP / v1.5 / v2 / v3 (mirrors the blueprint's phasing).
- **Priority** — P0 (must), P1 (should), P2 (later/nice).
- **Moat weight** — how much this feature contributes to defensibility (◆ low → ◆◆◆ high).

The strategic spine (from the competitor teardown): **measurement is table stakes; the Fix Queue is the product.** Visibility tracking is the necessary *input*, execution is the *headline*. Every feature below is justified against that spine.

---

## 1. Product vision & positioning

**One-line vision:** The single platform where any business — from a Delhi kirana store to a Fortune 500 — sees its complete visibility across Google, AI answer engines, and agentic commerce, and where the platform doesn't just diagnose problems, it *fixes* them.

**Positioning statement:** *"The AI visibility platform that fixes what it finds."*
- vs **Ahrefs/Semrush:** unified AI-era visibility + execution at a fraction of the cost, no credit games.
- vs **Profound/Peec:** everything they measure, plus classic SEO, plus the deploy-verify-rollback fix layer into production surfaces.
- vs **enterprise suites:** 48-hour time-to-value instead of a 3-month ramp.

**The three bets:**
1. **Visibility is fragmenting, budgets are not.** One unified visibility model at one price beats five point tools.
2. **Measurement without execution is theater.** The moat is an agentic execution layer that pushes approved fixes into the customer's CMS, code, and Google Business Profile.
3. **The next billion SEO customers are not English-first.** Vernacular NLP (Indian languages first), region-tiered pricing, multi-engine coverage open markets incumbents ignore.

**Competitive reality (from the teardown):**
- "We measure AI citations" is *not* a differentiator in 2026 — Profound and Peec already do it.
- Profound already ships an "Agents" layer → our wedge must be sharper: **deploy → verify → rollback into the customer's own CMS/code/GBP with audit logs**, not agent *suggestions*.
- Incumbents own distribution → we win on entity-first architecture, execution, and price, not on out-measuring.
- **Action item carried into P0:** hands-on teardown of Profound Agents to pin exact execution scope. → tracked as [`X0`](#8-cross-cutting--non-functional-requirements).

---

## 2. Product pillars — the map

| Pillar | Name | The job it does | Strategic role |
|---|---|---|---|
| **A** | Unified Visibility Engine | "See everything" | Necessary input (table stakes, must be excellent) |
| **B** | Diagnosis Engine | "What's wrong" | Feeds the moat — every finding must be executable |
| **C** | Agentic Execution Layer | "Fix it" | **The moat / headline** |
| **D** | Intelligence & Reporting | "Explain & prove it" | Retention + expansion + enterprise buy-in |

**Current build focus: Pillars A & B** (see Roadmap). C and D are catalogued here in full so A & B are built with the fix-loop as their downstream contract.

---

## 3. PILLAR A — Unified Visibility Engine

> Reference specs: [`A1` Rank Tracking](feature-specs/A1-rank-tracking.md) · [`A2` AI Visibility/GEO](feature-specs/A2-ai-visibility-geo.md) · [`A3` Unified Share of Voice](feature-specs/A3-unified-share-of-voice.md) · [`A4` Keyword & Prompt Research](feature-specs/A4-keyword-prompt-research.md) · [`A5` Competitor Intelligence](feature-specs/A5-competitor-intelligence.md) · [`A6` Backlink & Mention Index](feature-specs/A6-backlink-mention-index.md)

### A1 — Rank Tracking `Phase: MVP · P0 · ◆`
| ID | Feature | Notes |
|---|---|---|
| A1.1 | Multi-geo rank tracking | Country → region → city → postcode granularity |
| A1.2 | Multi-device tracking | Desktop / mobile split |
| A1.3 | Multi-language tracking | Query language independent of geo |
| A1.4 | SERP feature tracking | Featured snippets, PAA, image/video packs, local pack, shopping, AI Overview presence |
| A1.5 | Volatility index | Per-project + per-market SERP turbulence score |
| A1.6 | Historical SERP snapshots | Full-page snapshots for point-in-time reconstruction |
| A1.7 | Ranking distribution & movement | Position buckets, gainers/losers, cannibalization detection |
| A1.8 | Scheduled polling cadence | Weekly (Starter) → daily (Growth+) → on-demand |
| A1.9 | Tag/segment tracking | Group keywords by campaign, funnel stage, product line |

### A2 — AI Visibility (GEO) `Phase: MVP · P0 · ◆◆◆`
| ID | Feature | Notes |
|---|---|---|
| A2.1 | Prompt-level monitoring | Across ChatGPT, Perplexity, Gemini, Copilot, Google AI Overviews, AI Mode |
| A2.2 | Citation source tracking | Which domains/pages the engine cited; your presence vs absence |
| A2.3 | Sentiment scoring | Sentiment of the mention of your brand in the answer |
| A2.4 | Accuracy scoring | Is what the engine says about you factually correct? |
| A2.5 | Share of Model | Your share of citations vs competitors for a prompt set |
| A2.6 | n-sampling engine | Each prompt run n=3–5×/cycle; results as **ranges with confidence bands**, never point estimates |
| A2.7 | API vs consumer-surface reconciliation | Daily API polling + weekly stratified consumer-app capture; statistically reconciled |
| A2.8 | Prompt bank management | Curated + auto-suggested prompts per project/category |
| A2.9 | Engine-level drilldown | Per-engine citation rate, answer text capture, diff over time |
| A2.10 | Answer text archive | Raw answers retained for reprocessing (24-month lake) |

### A3 — Unified Share of Voice `Phase: MVP · P0 · ◆◆`
| ID | Feature | Notes |
|---|---|---|
| A3.1 | Unified Visibility Score | Single blended score: organic SoV + AI SoV + local SoV |
| A3.2 | Traffic-mix weighting | Weighted by the customer's actual channel mix |
| A3.3 | Score decomposition | Drill from the one number into each contributing surface |
| A3.4 | Trend & anomaly view | 30/90/365-day trend, algorithm-update overlays |
| A3.5 | Benchmark vs competitors | Your unified score vs tracked competitors |

### A4 — Keyword & Prompt Research `Phase: MVP · P0 · ◆◆`
| ID | Feature | Notes |
|---|---|---|
| A4.1 | Search volume | Managed API sourced |
| A4.2 | Keyword difficulty | Modeled difficulty score |
| A4.3 | Intent classification | Informational / navigational / commercial / transactional |
| A4.4 | Semantic clustering | HDBSCAN on embeddings |
| A4.5 | Question mining | PAA + question-shaped queries |
| A4.6 | Query fan-out discovery | Sub-queries an AI engine expands a prompt into |
| A4.7 | Vernacular & transliterated keywords | Hinglish / Indic-script / transliteration variants |
| A4.8 | Prompt research | Discover prompts real users ask AI engines in a category |
| A4.9 | SERP/answer overlap analysis | Which keywords also trigger AI answers |

### A5 — Competitor Intelligence `Phase: v1.5 · P1 · ◆◆`
| ID | Feature | Notes |
|---|---|---|
| A5.1 | Keyword gap | Keywords competitors rank for that you don't |
| A5.2 | Citation gap | Prompts where competitors are cited and you aren't |
| A5.3 | Content gap | Topics/entities competitors cover that you don't |
| A5.4 | Entity gap | Entity coverage & strength differential |
| A5.5 | Backlink gap | Referring domains competitors have that you don't |
| A5.6 | Competitor set management | Auto-suggested + manual competitor sets per market |

### A6 — Backlink & Mention Index `Phase: v1.5→v2 · P1 · ◆◆◆`
| ID | Feature | Notes |
|---|---|---|
| A6.1 | Licensed backlink data | DataForSEO-class link data initially |
| A6.2 | Unlinked brand-mention tracking | Mentions correlate ~3× stronger than backlinks with AI Overview visibility |
| A6.3 | Web-scale mention index (proprietary) | Build a *mention* index (cheaper than a link graph) in v2 |
| A6.4 | Citation-domain intelligence | Which domains AI engines cite in your category |
| A6.5 | Link/mention quality scoring | Authority, relevance, sentiment |

---

## 4. PILLAR B — Diagnosis Engine

> Reference specs: [`B1` Technical Audit](feature-specs/B1-technical-audit.md) · [`B2` Content & Extractability Scoring](feature-specs/B2-content-extractability.md) · [`B3` Entity & Knowledge Graph Audit](feature-specs/B3-entity-knowledge-graph.md) · [`B4` Log File Analysis](feature-specs/B4-log-file-analysis.md) · [`B5` Local SEO Audit](feature-specs/B5-local-seo-audit.md)

**Contract with Pillar C:** *every* Pillar B finding must emit a structured `Finding` object that maps to zero-or-more executable `Action` templates. A diagnosis with no path to a fix is a product bug, not a feature.

### B1 — Technical Audit `Phase: MVP · P0 · ◆◆`
| ID | Feature | Notes |
|---|---|---|
| B1.1 | Cloud crawler with JS rendering | Playwright cluster; per-project crawl budget (cap 100k URLs) |
| B1.2 | Core Web Vitals | LCP/INP/CLS field + lab |
| B1.3 | Indexability analysis | noindex, canonicalization, robots, sitemap coverage |
| B1.4 | Structured data validation | Schema.org validity, coverage, errors |
| B1.5 | Redirect & canonical analysis | Chains, loops, mixed signals |
| B1.6 | **AI-crawler access audit** | GPTBot / ClaudeBot / PerplexityBot / Google-Extended allow-list analysis |
| B1.7 | Crawl diff & regressions | What changed since last crawl |
| B1.8 | Severity + impact scoring | Each issue scored for the Fix Queue |
| B1.9 | hreflang & internationalization audit | Missing/conflicting hreflang |

### B2 — Content & Extractability Scoring `Phase: v1.5 · P0 · ◆◆◆`
| ID | Feature | Notes |
|---|---|---|
| B2.1 | Entity/topic coverage scoring | Coverage vs the entity set for a topic |
| B2.2 | Answer-first structure scoring | Does the page lead with the answer? |
| B2.3 | Passage self-containment | Can a passage be quoted standalone by an AI engine? |
| B2.4 | E-E-A-T signal detection | Authorship, citations, freshness, expertise signals |
| B2.5 | Content decay alerts | Traffic/citation decline detection over time |
| B2.6 | **Proprietary extractability scorer** | Fine-tuned classifier trained on cited vs non-cited pages — compounding data moat |

### B3 — Entity & Knowledge Graph Audit `Phase: v1.5 · P1 · ◆◆◆`
| ID | Feature | Notes |
|---|---|---|
| B3.1 | Wikidata / sameAs consistency | Cross-web identity consistency |
| B3.2 | Schema entity mapping | Map site entities to canonical IDs |
| B3.3 | Knowledge Panel status | Presence + accuracy |
| B3.4 | Cross-web entity corroboration score | How consistently the web corroborates your entity |

### B4 — Log File Analysis `Phase: v2 (enterprise) · P2 · ◆`
| ID | Feature | Notes |
|---|---|---|
| B4.1 | Crawl budget analysis | Bot hit distribution vs value |
| B4.2 | AI-bot traffic analysis | GPTBot/ClaudeBot/PerplexityBot crawl behavior |
| B4.3 | Orphan page detection | Pages no crawler reaches |
| B4.4 | Log ingestion connectors | Cloudflare/CDN/server log pipelines |

### B5 — Local SEO Audit `Phase: v1.5 · P1 · ◆◆`
| ID | Feature | Notes |
|---|---|---|
| B5.1 | GBP completeness | Profile field coverage & accuracy |
| B5.2 | Citation consistency (NAP) | Name/Address/Phone consistency across directories |
| B5.3 | Review velocity & sentiment | Volume trend + sentiment |
| B5.4 | Local pack tracking | Map-pack presence by geo (links to A1.4) |

---

## 5. PILLAR C — Agentic Execution Layer (the moat) `Focus: later phase; contract defined now`

> The headline differentiator. Every finding → an executable action in a **Fix Queue** with human-in-the-loop approval.
> Loop: **proposed → previewed (diff) → approved (one-click or auto-rules) → deployed → measured → (rollback if needed).**

### C1 — Fix Queue core `Phase: MVP (schema+meta only) → expands · P0 · ◆◆◆`
| ID | Feature | Notes |
|---|---|---|
| C1.1 | Fix Queue kanban | Proposed → Approved → Deployed → Verified |
| C1.2 | Predicted impact + effort per card | Drives prioritization |
| C1.3 | Diff/preview view | See exactly what will change before approval |
| C1.4 | Approval workflow | One-click approve; auto-approve rules; role gating |
| C1.5 | Deploy orchestration | Executes via the right connector/worker |
| C1.6 | Verification loop | Did the fix move the metric? Re-measure & report |
| C1.7 | **Automatic rollback** | Staged rollout + one-click / automatic revert |
| C1.8 | Audit log | Insurance-grade, immutable, per-action |

### C2 — Schema injection `Phase: MVP · P0 · ◆◆◆`
| ID | Feature | Notes |
|---|---|---|
| C2.1 | JSON-LD generation | Entity-grounded structured data |
| C2.2 | Bulk deploy across pages | CMS plugin **or** Cloudflare Worker (edge) — no dev ticket |
| C2.3 | Schema templates by page type | Product, Article, FAQ, LocalBusiness, etc. |

### C3 — Content actions `Phase: v1.5 · P1 · ◆◆`
| ID | Feature | Notes |
|---|---|---|
| C3.1 | AI-drafted extractability rewrites | Answer-first paragraphs, FAQ blocks |
| C3.2 | Meta title/description regeneration at scale | |
| C3.3 | Internal-link insertion suggestions | Applied on approval |

### C4 — Technical fixes `Phase: v1.5 · P1 · ◆◆`
| ID | Feature | Notes |
|---|---|---|
| C4.1 | Redirect rules | Deploy via connector or edge worker |
| C4.2 | Canonical corrections | |
| C4.3 | hreflang generation | |
| C4.4 | robots.txt AI-crawler policies | Allow/deny GPTBot/ClaudeBot/etc. |
| C4.5 | **GitHub PR export** | For headless sites — fixes as reviewable PRs |

### C5 — GBP automation `Phase: v1.5 · P1 · ◆◆`
| ID | Feature | Notes |
|---|---|---|
| C5.1 | GBP posts | |
| C5.2 | Q&A responses | |
| C5.3 | Attribute updates | |
| C5.4 | Review reply drafts | |

### C6 — Citation-earning playbooks `Phase: v2 · P2 · ◆◆`
| ID | Feature | Notes |
|---|---|---|
| C6.1 | Auto-generated digital PR target lists | Domains AI engines cite in your category |
| C6.2 | Outreach drafts | |
| C6.3 | Third-party profile completeness tasks | G2, Capterra, JustDial, etc. by market |

---

## 6. PILLAR D — Intelligence & Reporting Layer `Phase: v1.5→v3`

### D1 — AI Copilot `Phase: v1.5 · P1 · ◆◆◆`
| ID | Feature | Notes |
|---|---|---|
| D1.1 | Natural-language querying | Over all platform data ("Why did AI citations drop in Germany?") |
| D1.2 | Cited, drill-downable answers | Grounded in ClickHouse via RAG |
| D1.3 | Persistent ⌘K copilot | Available on every screen, not a tab |
| D1.4 | Semantic caching + small-model routing | Cost control |

### D2 — Attribution & forecasting `Phase: v2 · P1 · ◆◆`
| ID | Feature | Notes |
|---|---|---|
| D2.1 | AI-referral revenue attribution | GA4 + server-side tagging |
| D2.2 | Ranking→traffic→revenue forecasting | Executive buy-in |
| D2.3 | Anomaly detection | Tied to algorithm-update timelines (Prophet-class) |

### D3 — Reporting `Phase: v1.5 · P1 · ◆`
| ID | Feature | Notes |
|---|---|---|
| D3.1 | White-label PDF / live dashboards | |
| D3.2 | Looker Studio connector | |
| D3.3 | Scheduled client reports | |
| D3.4 | Agency multi-workspace management | |

### D4 — API + MCP server `Phase: v2→v3 · P1 · ◆◆◆`
| ID | Feature | Notes |
|---|---|---|
| D4.1 | Full REST + GraphQL data API | |
| D4.2 | MCP server | Customers' own AI agents (Claude/ChatGPT) query & act — agent-native from day one |
| D4.3 | Webhooks & alerts | Slack, email, Teams |
| D4.4 | ACP/UCP agent-ready commerce feeds | Positions for agentic-commerce era |

---

## 7. Platform, billing & account features (the "micro-SaaS wrapper")

These are the end-to-end features that make Engine a sellable SaaS, not just an engine.

### E — Onboarding & activation `MVP · P0`
- E1 Domain + GSC connect wizard · E2 First insights <10 min · E3 First proposed fix <48h (tracked KPI) · E4 Free "AI Visibility Report" lead magnet (enter domain → instant citation snapshot) · E5 Guided setup checklist · E6 Sample-data demo workspace.

### F — Accounts, orgs & roles `MVP · P0`
- F1 Orgs → workspaces → projects hierarchy · F2 Roles (owner/admin/analyst/viewer/client) · F3 Seat management · F4 Agency multi-client workspaces · F5 White-label (logo, domain, colors) · F6 SSO/SAML (enterprise) · F7 Audit trail of user actions.

### G — Billing & pricing `MVP · P0`
- G1 Plan tiers (Starter/Growth/Agency/Enterprise) · G2 **Region-fair pricing** enforced via billing address + payment method · G3 Stripe (global) + UPI/Razorpay (India) · G4 Usage metering (projects, keywords, prompts, polling cadence) · G5 Free tier (1 project, 25 kw, 10 prompts, weekly) · G6 Non-credit model (explicit anti-Ahrefs stance) · G7 Upgrade/downgrade/proration · G8 Invoices, tax (GST/VAT).

### H — Notifications & alerts `MVP→v1.5 · P1`
- H1 Anomaly/threshold alerts · H2 Fix-verified notifications · H3 Weekly digest · H4 Slack/email/Teams channels · H5 Per-user alert preferences.

### I — Settings, data & trust `MVP→v2 · P0/P1`
- I1 Data-source connection manager · I2 Data residency (EU + India regions) · I3 GDPR/DPDP/CCPA tooling (export, delete, consent) · I4 Customer data ownership terms · I5 No-training-without-opt-in enforcement · I6 API key management.

### J — Localization `MVP→v1.5 · P1`
- J1 UI i18n (English, Hindi, Spanish, Portuguese, Japanese, German at launch; RTL-ready) · J2 Vernacular content throughout · J3 Locale-aware formatting.

### K — Frontend/UX system `MVP · P0`
- K1 "One number, then depth" IA (max 2 levels) · K2 Home/Pulse screen · K3 Role-adaptive views (Owner/Analyst/Executive/Agency) · K4 Confidence bands on all AI charts (honesty as visual signature) · K5 Performance budget (FMP <1.5s, dashboard queries <500ms) · K6 Light-first + true dark mode · K7 ⌘K copilot everywhere · K8 Skeleton loading + offline-tolerant report viewing.

---

## 8. Cross-cutting & non-functional requirements

| ID | Requirement | Target |
|---|---|---|
| X0 | **Profound Agents teardown** (pre-build research) | Complete before C-layer design freeze |
| X1 | AI-metric honesty | Confidence bands + n-sampling everywhere; never point estimates for AI visibility |
| X2 | Scale | Architecture serves 100 → 100,000 customers without redesign |
| X3 | Dashboard performance | Every dashboard query <500ms (ClickHouse) |
| X4 | Time-to-first-value | <10 min to first insight, <48h to first proposed fix — tracked KPIs |
| X5 | Execution safety | Human-in-the-loop default, staged rollout, auto-rollback, edge-worker sandboxing, immutable audit logs |
| X6 | Cost control | LLM gateway routes to cheapest capable model; category-level prompt caching (40–60% saving) |
| X7 | Data retention | 24-month raw lake for retroactive reprocessing when scoring models improve |
| X8 | Legal | ToS review per vendor/LLM; GDPR + DPDP + CCPA; data residency roadmap |
| X9 | Reliability | Multi-vendor API abstraction (SERP + LLM) so no single provider is a single point of failure |

---

## 9. Success metrics (product KPIs)

- **Activation:** % of new projects reaching first insight <10 min; first proposed fix <48h.
- **Moat engagement:** Fix Queue actions proposed → approved → deployed → *verified as impactful* (the funnel that matters).
- **Outcome:** demonstrable citation-rate lift and ranking/traffic movement attributable to deployed fixes.
- **Retention/expansion:** net revenue retention; agency seat expansion; free→paid conversion.
- **Unit economics:** 65–75% gross margin held as scale grows (COGS discipline via caching + model routing).

---

## 10. Explicit non-goals (year one)

- **No Google SERP scraper** — managed APIs (DataForSEO primary, SerpAPI failover). Revisit only at >$50k/mo API spend.
- **No web-scale backlink graph** in year one — license it; build a *mention* index in v2.
- **No unsupervised auto-deploy** — human-in-the-loop is the default; auto-approve is opt-in and rule-scoped.
- **No training on customer private data** without explicit opt-in.

---

## 11. Kill/pivot triggers (carried from blueprint)

- If Google ships clean AI-click data in GSC → drop proprietary AI-CTR estimation, double down on execution.
- If one answer engine takes >50% of AI referrals → concentrate polling there.
- If SERP API costs spike >3× → accelerate first-party-data strategy.

---

*See [Roadmap](10-Roadmap.md) for phasing and milestones, [Architecture](20-Architecture.md) for the technical foundation, and [feature-specs/](feature-specs/) for per-feature deep dives.*
