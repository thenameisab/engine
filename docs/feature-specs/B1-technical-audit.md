# B1 — Technical Audit · Reference Spec

**Pillar:** B · **Phase:** MVP · **Priority:** P0 · **Moat weight:** ◆◆
**PRD ref:** [Master PRD §4 B1](../00-Master-PRD.md) · **Status:** Draft

## 1. Problem & job-to-be-done
The Diagnosis Engine's foundation: crawl a site, find what's technically wrong, and — crucially — emit **executable** findings. In the MVP this is the primary feedstock for the Fix Queue (schema + meta actions), so its `Finding → Action` mapping is the single most important contract in the release. Standard technical SEO auditing **plus** the GEO-native **AI-crawler access audit** (is GPTBot/ClaudeBot/PerplexityBot even allowed to read you?), which no classic auditor centers.

## 2. Users & roles
- **Analyst:** full issue inventory, severity, exports.
- **Owner:** "What's broken and what will you fix?" → straight to Fix Queue cards.
- **Agency:** per-client audit + white-label report.

## 3. Scope
**In (MVP):** B1.1 cloud crawler w/ JS rendering (cap 100k URLs), B1.2 Core Web Vitals, B1.3 indexability, B1.4 structured-data validation, B1.5 redirect/canonical, B1.6 **AI-crawler access audit**, B1.7 crawl diff/regressions, B1.8 severity+impact scoring, B1.9 hreflang/i18n audit.
**Out:** log-file analysis (B4, Phase 3); content scoring (B2, v1.5).

## 4. Functional requirements
1. **Playwright-based** cloud crawl with JS rendering, polite rate-limiting, per-project budget (cap 100k URLs; enterprise lifts).
2. Measure **Core Web Vitals** (field via CrUX/GSC where available + lab).
3. **Indexability:** noindex, robots.txt, sitemap coverage, canonicalization signals.
4. **Structured-data validation:** schema.org validity, coverage, errors — feeds C2 schema injection.
5. **Redirect/canonical analysis:** chains, loops, conflicting signals.
6. **AI-crawler access audit:** parse robots.txt + response headers for GPTBot / ClaudeBot / PerplexityBot / Google-Extended allow/deny → flag blocked AI crawlers (a top GEO issue) → feeds C4.4.
7. **hreflang** audit (missing/conflicting).
8. **Crawl diff:** what changed vs last crawl (regressions surface as findings).
9. Score each issue by **severity + predicted impact**; emit `Finding` objects with `actionTemplates`.

## 5. Data & sources
- **Source:** own Playwright crawler (containers, orchestrated via Cloudflare Queues); GSC/CrUX for field CWV.
- **Storage:** crawl results + issue events → ClickHouse; raw rendered snapshots → R2/Parquet; crawl configs → Postgres.
- **Entity linkage:** crawled URLs resolve to entities.

## 6. Intelligence / models
- Mostly deterministic rule engine for issues.
- **Severity/impact scoring** model (weights issue type × page value × traffic). Light ML, no LLM in the hot path.

## 7. Finding → Action mapping (the MVP-critical contract)
| Finding | Action template | Deploy target |
|---|---|---|
| Missing/invalid schema | Generate JSON-LD (C2) | CMS plugin / Cloudflare Worker |
| Weak/missing meta title/desc | Regenerate meta (C3.2) | CMS plugin / edge / GitHub PR |
| AI crawler blocked | robots.txt AI-crawler policy (C4.4) | CMS / edge / GitHub PR |
| Redirect chain / bad canonical | Redirect/canonical fix (C4.1/C4.2) | edge / GitHub PR |
| Missing/broken hreflang | hreflang generation (C4.3) | CMS / edge / GitHub PR |

Every finding **must** carry ≥1 action template or ship a documented reason it can't (product bug otherwise).

## 8. UX
- Lead: **technical health score** (one number) + count of auto-fixable issues, then the issue inventory.
- Each issue row shows the fix it maps to and a "send to Fix Queue" affordance with predicted impact.
- Crawl diff highlighted (regressions first).

## 9. Non-functional
- Crawl budget capped/metered by plan; queries <500ms.
- Crawler politeness (rate limits, robots respect) is mandatory.

## 10. Dependencies & risks
- Depends on crawler infra, entity model, and the frozen `Finding/Action` contract (Arch §3.1).
- **Risk:** JS-rendering cost/scale → container pool sizing + budget caps.
- **Risk:** execution breaks a site → handled downstream by C (staged/rollback), but B must score impact honestly.

## 11. Success metrics
- Issue-detection accuracy vs manual audit; % of findings with a valid action mapping (target 100% of P0 issue types); crawl completion rate.

## 12. Open questions
- CWV field-data coverage for low-traffic pages (lab-only fallback thresholds)?
- Crawl scheduling model — full recrawl vs incremental delta crawl at MVP?
