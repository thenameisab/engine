# X0 — Profound Agents Teardown

Gates the Phase 2 C-layer design freeze (Roadmap §X0). Question: how wide is
Profound's execution wedge today, and does it narrow or widen the gap Engine's
Fix Queue (C1) is betting on?

## What Profound Agents actually does (as of July 2026)

- **Content generation, not technical execution.** Agents draft content briefs,
  full articles, and landing pages grounded in Profound's own AI-citation data
  (what's actually being cited in a category), then stage them into a CMS
  (WordPress, Sanity, Contentful) or notify a team via Slack/Gamma. This is the
  A4→C3 seam in our own model (prompt research → content action) — Profound
  has shipped further into it than we have.
- **Human-in-the-loop, not autonomous deploy.** Every source describes Agents
  as drafting/staging work for review, not a proposed→approved→deployed→verified
  state machine with automatic rollback. Profound also just launched a second
  product, **Aim** (announced 2026-07-02): an always-on background agent that
  monitors AI answers, explains *what changed and why*, and converts the
  highest-impact opportunities into scoped "Projects" — again "a human on every
  approval."
- **No technical/schema/crawler-fix layer.** Nothing in the research surfaces
  Profound touching structured data, meta tags, robots/AI-crawler access, or
  Core Web Vitals — i.e. no B1/C2/C4 equivalent. Their execution wedge is
  entirely on the content side (C3), not the technical side (C2/C4).
- **No verified-deploy or auto-rollback primitive.** Nothing found resembling
  C1.7/C1.8 — a staged deploy with a health check that reverts itself and logs
  who/why. Third-party framing (Conductor, indexableai) independently converges
  on the same read: Profound is "analytics-first with content agents emerging,"
  not an execution-first platform. One comparison piece frames "execution-first"
  platforms as operating at "L4–L5: agents that deploy schema, restructure
  pages, fix technical blockers... with approval rules you define" — which is
  a near-exact description of what Engine's C1–C2 already ship, today, verified
  against a live runtime (PRs #13–#15, #21–#26).

## What this means for Engine's wedge

1. **C2 (technical fixes: schema/meta/robots, deployed+verified+auto-rolled-back)
   is not contested.** Nobody surveyed does this. This is the part of the C-layer
   that should keep getting investment first — it's already built and it's the
   part of the market Profound has explicitly not entered.
2. **C3 (content generation) is contested, and Profound is ahead on breadth**
   (multi-CMS staging, Slack/Gamma integration) even though it's shallower on
   trust (no verify/rollback loop, no audit trail, human approves everything).
   Engine's differentiator here isn't "generate content too" — it's "generation
   flows through the same proposed→approved→deployed→verified contract as a
   schema fix," so a content change gets the same rollback safety net a
   technical one does. That's a design constraint for C3, not a reason to skip it.
3. **C4/C5 (GitHub PRs, broader execution) remain genuinely open** — no
   evidence any competitor ships code-level fixes through source control.

## Design-freeze recommendation

- **Do not over-invest in a Profound-style standalone content-drafting agent.**
  It would compete on Profound's home turf (content breadth, multi-CMS reach)
  without Engine's structural advantage (the verified Fix Queue contract).
- **C3 should be built as a generator that emits `Action`s into the existing
  Fix Queue**, not a parallel drafting tool — reusing `packages/actions`'
  `build.ts` state machine and `packages/deploy`'s verify/rollback pattern the
  same way `schema.ts`/`meta.ts`/`robots.ts` already do. This keeps every
  future content fix inside C1.7's automatic-rollback safety net, which is the
  one thing no competitor teardown found evidence of.
- **C2 stays the priority lane into Phase 2** — no signal from this teardown
  changes that; if anything it confirms technical execution is the least
  contested, most defensible ground to keep deepening (e.g. CWV auto-fixes,
  more B1 rule coverage) before spending more on C3 breadth.
- **Freeze released**: Phase 2 C-layer work (M2.3 "content + technical fixes
  GA") can proceed on this basis — C3 content generators as Fix-Queue
  producers, C2 depth continues, C4 (GitHub PRs) is a fresh green field with
  no observed competitor.

Sources: [Profound Aim launch coverage](https://www.digitalapplied.com/blog/profound-aim-geo-marketing-agent), [Profound Aim GEO operations](https://www.realinternetsales.com/profound-aim-ai-search-agent-geo-operations/), [Profound Review 2026](https://thepromptinsider.com/ai-tools/profound-review-2026/), [Profound $1B Series C profile](https://everything-pr.com/profound-reaches-1-billion-valuation-with-96m-series-c-cementing-category-leadership-in-ai-search-marketing), [Profound alternatives: analytics-first vs execution-first](https://indexableai.com/comparison/profound-alternative/), [Considering Profound Agents for AEO](https://www.conductor.com/academy/profound-agents/), [Profound Agent Analytics, explained](https://naridon.com/en/blog/profound-agent-analytics-explained)
