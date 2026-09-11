# Driver — scoping document

**Status:** **decided.** §9 was answered on 2026-09-10; the answers are §9a, and they are the
spec until this document is promoted. Three of them add scope this document did not carry.
**Gates:** wave 4 of `docs/reviews/2026-09-10-action-plan.md`, which requires this document
to answer five questions before any implementation. Those answers are §8.
**Becomes:** `docs/feature-specs/D1-driver.md`. That promotion is now due and has not been done;
§9a has to be folded into §4 when it happens, not appended to it.
**Re-audited 2026-09-11** against `origin/main` at `91bf455`. §1's measurements have drifted —
see the note at the head of §1 — and §6's second bullet is no longer true.

Driver is the conversational surface of Engine: a standalone chat screen, plus an entry bar
on every other screen. It answers questions over the customer's own marketing data and takes
actions inside the product. It is the product's benchmark feature, so this document scopes it
against what the code actually does today rather than against the build plan's one-paragraph
description of an "Ask Engine bar".

---

## 1. What exists today, measured

Read from `main` at `90eccd8` on 2026-09-10. Every claim here is from the source, not the plan.
Counts and line numbers are against that commit.

> **Drift, measured 2026-09-11 at `91bf455`.** The counts below have all moved, and one was wrong
> when written. Tables: **42**, not 39. Migrations: **0035** is the latest. Routes: `index.ts`
> alone now declares **80**, and `routes/integrations.ts` adds **22**, so **102** — the "76
> routes" figure in §1.5 counted `index.ts` only and was already an undercount of about twenty
> when this document was written. None of it changes a conclusion: §1.5's point is that the write
> surface exists as HTTP routes, which more routes only strengthens, and §1.4's point is that the
> Copilot reads three tables out of all of them, which is worse at 42 than at 39. The structural
> claims still hold as written: `llmSarvam.ts` sends no `tools`, `llmStream.ts` has no tool-call
> chunk type, there is no conversation state, and `copilot.ts` still blocks its panel on a
> setting that #105 deleted.

### 1.1 The current Copilot is a phrasing layer, not an AI feature

| Layer | File | What it does |
|---|---|---|
| Intent | `packages/copilot/src/intent.ts` | Keyword rules resolve a question to one of **four** intents. No model call. |
| Retrieval | `apps/api` `answerQuestion` | Joins three sources: `serp_positions`, `citation_events`, `findings`. |
| Answer | `packages/copilot/src/answer.ts` | Assembles prose deterministically. Citations, drilldown and the suggested action are fixed here. |
| Model | `apps/api/src/index.ts:858` `/ai/stream` | Sends the finished answer back to Sarvam with `PHRASING_SYSTEM_PROMPT` and streams a reword. |

The taxonomy is `entity_visibility`, `organic_vs_ai`, `top_findings`, `keyword_rank`, and
`unknown`. `types.ts` states the design intent plainly: "an intent is a *route into an existing
query*, never an open-ended generator." Anything unmatched returns `unknown`, and `index.ts:938`
then skips the model entirely, because rewording nothing "would invite it to answer the question
itself, which is the one thing the phrasing layer forbids."

**The model has never answered a question in this product.** It has only ever reworded an answer
the database produced.

### 1.2 The connector has no tool-calling plumbing

`packages/connectors/src/llmSarvam.ts` sends:

```ts
{ model, messages: [{ role: 'user', content: prompt }], max_tokens, stream? }
```

One turn. No `tools`, no `tool_choice`, no `assistant` or `tool` message roles, no loop.
`llmStream.ts` parses SSE into two chunk types, `thinking` and `text`. Tool-call deltas have no
representation.

**This file is being edited right now** on `feat/measurement-methodology`, together with
`llmEngine.ts`, `llmGemini.ts`, `llmOpenAI.ts` and `factory.ts`. Treat the connector interface as
moving. Driver's agent loop should be designed against the interface that branch lands, not
against today's.

### 1.3 There is no conversation state

`copilot_queries` stores question, intent, latency and entity id. It is telemetry. There is no
thread, no message history, no stored tool call. Every question today is independent, so there is
no follow-up, no "that one", no correction of a previous turn.

### 1.4 Driver can currently reach three tables out of thirty-nine

The schema has 39 tables. The Copilot reads three. Everything the integrations pull is
unreachable from chat:

`gsc_query_daily`, `gsc_page_daily`, `gsc_site_daily`, `ga`, `crawled_pages`, `competitor_gaps`,
`competitor_sets`, `citation_opportunities`, `local_audits`, `local_profiles`,
`entity_graph_audits`, `actions`, `audit_runs`, `deterministic_audit_runs`, `keyword_configs`,
`answer_mentions`, `integration_connections`, `audit_requests`.

### 1.5 The write surface already exists as HTTP routes

The API exposes 76 routes. The ones that change something are already built, tested and used by
the dashboard. Driver does not need new execution machinery, it needs a policy for calling the
machinery that exists. Full inventory in §5.

---

## 2. What Sarvam supports

Checked against the vendor documentation on 2026-09-10, because the whole architecture forks on it.

| Capability | Supported | Note |
|---|---|---|
| `tools` (functions) | Yes | Function type only. |
| `tool_choice` | Yes | Enum, or `{type:'function', function:{name}}` to force one. |
| Message roles | Yes | `system`, `user`, `assistant`, `tool`. |
| Streaming with tool calls | Yes | Tool-call information is carried in the stream. |
| Structured output | Yes | By forcing a single tool whose parameters are the schema. |
| `reasoning_effort` | Yes | `low` / `medium` (default) / `high`, or off. |
| `wiki_grounding` | Yes | Boolean, default false. |
| Parallel tool calls | **Undocumented** | Must be tested against the live vendor before it is designed around. |
| Unsupported | — | `stream_options`, `max_completion_tokens`, `service_tier`. |

**Context windows matter for the model choice.** `sarvam-105b` is 128K; `sarvam-105b-conversations`
is 32K. The default was changed to the conversations model on 2026-09-10 so live answers match the
instrument the citation poll measures with. That reasoning is sound for the "try a prompt" surface
and wrong for Driver: an agent loop carrying a system prompt, a tool catalogue, several turns and
several tool results will not fit 32K reliably. Driver should pin `sarvam-105b` and say so, which
means the picker's "one choice across surfaces" assumption in `modelPicker.ts` needs revisiting.

Default `max_tokens` is 2048; the catalogue already sets 16000 for `sarvam-105b`.

---

## 3. What Driver is, and what it is not

`docs/50-X0-Profound-Teardown.md` established Engine's wedge: the verified execution contract
(`proposed → approved → deployed → verified → rollback`) that no surveyed competitor ships.
Profound's agents draft content and stage it for a human; nobody found evidence of a competitor
deploying a technical fix and verifying it on the live page.

That determines what Driver should be.

**Driver is the conversational front-end to the execution contract.** Its differentiator is not
that you can chat with your marketing data — several analytics products do that. It is that a
sentence in a chat box can become a fix that is proposed, approved, deployed to the live site and
verified against the deployed page, with an audit trail and a rollback, and that every number it
quotes on the way carries the table it came from.

**Driver is not a content-drafting agent.** The teardown's design-freeze recommendation applies
here unchanged: do not build a parallel drafting tool that competes on Profound's home turf.
Content generation reaches the customer as `Action`s in the Fix Queue, through the same state
machine as a schema fix.

**Driver is not a text-to-SQL box.** See §4.2.

---

## 4. Architecture

### 4.1 Agent loop

New module, `packages/driver`, sitting beside `packages/copilot` rather than replacing it (see §4.8).

The loop: build messages → call the model with the tool catalogue → if the response contains tool
calls, execute them server-side and append `role: 'tool'` results → repeat → emit the final answer.

Bounds that have to be decided and enforced rather than left to the model:

- Maximum tool-call rounds per turn.
- Maximum tool calls per round.
- Wall-clock budget per turn, with a partial answer on expiry rather than a timeout.
- Token budget, with oldest turns dropped from history first and a note in the transcript.

The loop runs in the Cloudflare Worker. Worker CPU and subrequest limits need checking against a
worst-case turn before this is committed to; that is a research task, not an assumption.

### 4.2 Read tools — the semantic layer

The external state of the art converges on one point: agentic analytics without a governed
semantic layer produces agents that fabricate metric definitions and bypass access controls.
Engine's version of that layer is the tool catalogue. **Each tool is a named, parameterised,
project-scoped query with a documented meaning** — not SQL the model writes.

Rules that make it a semantic layer rather than a query API:

1. **The model never supplies `projectId` or `accountId`.** Scope is injected server-side from the
   session. A tool signature that accepts a project id is a cross-tenant read waiting to happen.
2. **Every tool returns data plus provenance** — the table, the row ids, the period, and the
   sample count where one applies.
3. **A tool that has no data says so distinctly from a tool that returns zero.** "Not connected",
   "no data yet" and "zero" are three different answers and the product already distinguishes them
   in `providerNextStep` and `source: 'connected' | 'missing' | 'no-data-yet'`.
4. **Confidence bands survive.** `citation_events` figures are bands by design. A tool must not
   flatten a band to a point, or the model will quote the point.

Draft catalogue, grouped by the question a customer asks:

| Question | Tool | Source |
|---|---|---|
| How is search performance? | `search_performance(period, compare)` | `gsc_site_daily` |
| What queries bring people here? | `top_queries(period, limit, brand?)` | `gsc_query_daily` |
| Which pages get search traffic? | `top_pages(period, limit)` | `gsc_page_daily` |
| What is nearly ranking? | `queries_within_reach(period)` | `gsc_query_daily` |
| Where does traffic come from? | `traffic_by_channel(period)` | `ga` |
| How much traffic comes from AI? | `ai_referral_traffic(period)` | `ga` |
| Where do we rank? | `keyword_positions(keyword?, period)` | `serp_positions` |
| Which keywords are tracked? | `tracked_keywords()` | `keyword_configs` |
| Are we named in AI answers? | `ai_citations(entity?, period)` | `citation_events`, `answer_mentions` |
| Who else is cited? | `cited_domains(period)` | `citation_events` |
| What is wrong with the site? | `findings(severity?, type?, page?)` | `findings` |
| What did the crawl reach? | `crawl_coverage()` | `audit_runs`, `crawled_pages` |
| What does a page contain? | `page_content(url)` | `crawled_pages` — **untrusted, see §4.7** |
| What fixes are in flight? | `fix_queue(status?)` | `actions` |
| Did a fix work? | `fix_verification(actionId)` | `actions`, verify requests |
| How strong is the brand entity? | `entity_strength(entity?)` | `entity_graph_audits` |
| How do we compare to a competitor? | `competitor_gaps(competitor?)` | `competitor_gaps`, `competitor_sets` |
| How is the local listing? | `local_visibility(entity)` | `local_audits`, `local_profiles` |
| What is connected? | `integration_status()` | `integration_connections` |
| What is the site's health? | `site_health()` | `audit_runs`, `findings` |

Twenty tools is a large catalogue for one model call. Whether they are all offered on every turn,
or a router narrows them first, is an open decision (§9).

### 4.3 Write tools, and the tier they sit in

The production pattern in current practice is to classify every agent action by reversibility and
blast radius, then assign an oversight mode per tier. Applied to Engine's existing routes:

**Tier 0 — no side effects. Runs without asking.**
Every read tool in §4.2.

**Tier 1 — internal, cleanly reversible. Agent acts, logs enough to reverse.**

| Action | Route |
|---|---|
| Queue a crawl | `POST /projects/:id/audit-requests` |
| Run the entity audit | `POST /projects/:id/entity-audit` |
| Run the local audit | `POST /projects/:id/entities/:id/local-audit` |
| Run the competitor audit | `POST /projects/:id/entities/:id/competitor-audit` |
| Run the offsite audit | `POST /projects/:id/entities/:id/offsite-audit` |
| Live rank check | `POST /projects/:id/rank/poll` |
| Keyword research | `POST /projects/:id/keywords/research` |
| Propose a fix | `POST /projects/:id/findings/:findingId/propose` |
| Propose across a group | `POST /projects/:id/findings/propose-batch` |

Proposing is Tier 1 because a proposed action is a draft. It changes nothing on the customer's
site and the Fix Queue already exists to review it.

**Tier 2 — confirmed in the UI before the call is made.**

| Action | Route | Why |
|---|---|---|
| Track a keyword | `POST /projects/:id/entities/:id/keywords` | Recurring cost per poll. |
| Add a competitor | `POST /projects/:id/entities/:id/competitors` | Recurring cost, changes reported gaps. |
| Edit AI prompts | `PUT /projects/:id/entities/:id/prompts` | Changes what the citation band measures. |
| Approve a fix | `POST /projects/:id/actions/:actionId/approve` | Moves a change toward the live site. |
| Set the deploy target | `PUT /projects/:id/deploy-target` | Decides where every future fix lands. |
| Invite a user | `POST /accounts/:id/invitations` | Grants access to someone else. |

**Tier 3 — Driver never calls these.**

| Action | Why |
|---|---|
| `POST .../actions/:id/deploy` | Writes to the customer's live site. |
| `POST .../actions/:id/rollback` | Recovery must be a deliberate human act. |
| `POST /accounts/:id/billing/checkout` | Money. |
| `PATCH /accounts/:id/branding`, `POST /accounts`, `POST /accounts/:id/projects` | Account shape. |
| Anything under `/auth/*`, `/internal/*`, `/platform/*` | Credentials and service-only surfaces. |

Deploy is the interesting one. Engine's wedge is that a fix reaches the live site and is verified,
so it is tempting to let Driver complete the loop. The recommendation is still no for v1: the same
verified-deploy contract is what makes the product trustworthy, and the first time an agent deploys
something nobody asked for, that trust is what is spent. Driver can walk a customer to the Deploy
button and explain what it will do. See §9.

### 4.4 Conversation state

A migration, numbered **0036 or later**. This said "0034 or later (0033 is taken by
`email_login`)" when written; 0034 went to `measurement_methodology` six minutes after this
document merged, and 0035 to `account_kind`. Check `infra/migrations/postgres/` rather than this
line — with branches in flight, number past the highest across all of them, not just `main`:

- `driver_threads` — id, project_id, created_by, title, created_at, last_message_at.
- `driver_messages` — id, thread_id, role, content, created_at, and for assistant turns the model
  id and token counts.
- `driver_tool_calls` — id, message_id, tool name, arguments, result reference, duration, error.

Persisting tool calls separately is what makes an answer auditable after the fact: a customer who
asks "where did that number come from" three days later needs the call and its result, not the
prose. It is also the raw material for evaluation (§10).

Retention and whether a thread is visible to other members of the account are open (§9).

### 4.5 Response protocol

The action plan asks for "widgets, tables, charts, rich text". Two ways to get there:

1. The model emits markdown and the client parses it.
2. Each tool declares its own render shape; the model chooses which tool to call, never which
   chart to draw.

**Recommendation: (2).** A model that picks chart types will pick badly and inconsistently, and the
repo already has a house `dataviz` discipline that a model does not know. A response is then a
sequence of typed parts:

```
{ kind: 'text',  markdown }
{ kind: 'metric', label, value, band?, period, provenance }
{ kind: 'table', columns, rows, provenance }
{ kind: 'series', points, unit, period, provenance }
{ kind: 'findings', groups }          // reuses the Findings row component
{ kind: 'fixes', actions }            // reuses the Fix Queue card
{ kind: 'action', tool, arguments, tier, confirmLabel }
{ kind: 'citation', source, label, ref }
```

Reusing the existing components matters. A finding rendered in Driver should be the same row a
customer clicks in Findings, with the same actions on it. Two different renderings of the same
object is how a product starts to feel like two products.

### 4.6 The grounding contract

The existing rule is in `answer.ts` and it must survive: figures and citations are retrieval-built
and never model-authored. Under tool calling that becomes four rules:

1. Every number rendered as a `metric`, `table` or `series` part comes from a tool result. The
   model selects and labels; it does not supply values.
2. Prose may reference figures, but a figure appearing only in prose and in no tool result is a
   defect the pipeline should catch, not a thing the reader has to notice.
3. Every part carries provenance, and the UI can show it without a round trip.
4. Bands stay bands. A single point for an AI-citation figure is wrong even when it is convenient.

Point 2 needs a mechanism, not a promise. The cheapest is a post-generation check that extracts
numerals from the prose and flags any that appear in no tool result for that turn. That is a
research task with a real failure mode: percentages and rounded values will trip it. Worth
prototyping before committing.

### 4.7 Security — Driver has all three legs of the lethal trifecta

Current security research is consistent: the exploitable pattern is an agent with **access to
private data**, **exposure to untrusted content**, and **the ability to act or communicate
outward**. Driver has all three the moment `page_content` and the write tools ship together.

The untrusted content is specific and unavoidable:

- `crawled_pages.body_text` and `body_html` — the customer's own site, but a site with user-generated
  content, a compromised CMS, or an injected third-party script is attacker-controlled.
- AI answer text in `citation_events` and `answer_mentions` — third-party model output.
- Competitor pages reached by the competitor audit.
- Later, any customer-connected MCP server (roadmap M3.6), which is arbitrary third-party tools.

Controls that belong in v1:

1. **Tool results are data, never instructions.** Wrap them in a delimited envelope and state in the
   system prompt that content inside is never to be followed. This is necessary and not sufficient.
2. **Tier 2 confirmation is a security control, not only a usability one.** The human approval step
   is what stops an injected instruction from completing a write. This is the strongest single
   defence and it is why the tiering in §4.3 is not negotiable.
3. **No outward channel.** Driver must not send email, post to Slack, call a customer webhook, or
   fetch an arbitrary URL. Without an exfiltration path an injection cannot leak the private data
   it reaches.
4. **The model never chooses scope.** Project and account scoping is server-side (§4.2 rule 1).
5. **Truncate and label.** `page_content` returns a bounded excerpt, labelled with its source URL,
   so both the model and the reader know it came from a crawled page.
6. **Log every tool call** (§4.4), so an incident is reconstructable.

Prompt injection is listed as the top driver of agentic AI security failures in production. This
section is not boilerplate; it is the part most likely to be skipped under delivery pressure.

### 4.8 Degradation

`packages/copilot` stays. It answers four intents in under three seconds with no model key, and it
is the fallback when Sarvam is unavailable, when the deployment has no key, or when the agent loop
exceeds its budget. Keeping it costs nothing and means chat never hard-fails.

A related bug to fix in passing: `copilot.ts:248` blocks the panel with "Set an API base URL under
Settings first." That setting was deleted in #105. The message points at a field that no longer
exists.

### 4.9 Surfaces

- **Standalone screen** at `#/driver`, a seventh rail destination, with thread history.
- **The bar**, a persistent entry on other screens that opens into the screen or answers inline.
  The detailed surface work is in the build plan's step 2 and my earlier brief; it is the smallest
  part of this.
- **Context passing.** Driver on the Findings screen should already know which findings are on
  screen. A question asked from a screen carries that screen's context as a system note.
- **Mobile.** Under 860px the rail is already a fixed bottom bar. A second persistent bar costs
  roughly 56px of a 780px screen. Recommendation: no persistent bar on mobile; Driver is a
  destination in the bottom bar.

---

## 5. What can be built — capability inventory

The point of the inventory is to show the ceiling, so the tool catalogue is designed against the
whole surface rather than the three tables the Copilot happens to reach today.

### 5.1 Questions Driver could answer from data that already has a pipeline

**Search** — clicks, impressions, CTR and average position over any period with a comparison;
queries that are nearly ranking; brand versus non-brand split; which pages earn which queries;
what changed week over week and which query drove it.

**Traffic** — sessions by channel; engaged sessions and key events; traffic that came from AI
assistants, including sources GA4 left unclassified that Engine reclassifies; how AI referral
traffic converts against organic.

**AI visibility** — how often the brand is named in sampled AI answers, as a band with its sample
count; which domains are cited instead; which prompts produce a citation and which do not;
mentions without a link versus citations with one, which the codebase already separates as
`citedByName` and `citedByDomain`.

**Rankings** — position for a tracked keyword over time; live position for any keyword on demand;
which SERP features appear.

**Technical** — every finding by severity, type and page; what the crawl reached and what it was
refused; whether a page has structured data, a title, a description, a canonical, hreflang;
whether AI crawlers are blocked in robots.txt.

**Brand entity** — Wikidata mapping, on-site entity schema, sameAs consistency, cross-web
corroboration, each with its component score.

**Competitors** — gaps against a competitor by domain; who is cited in answers where the brand is
not.

**Local** — GBP completeness, NAP consistency, review health per location.

**Execution** — what is proposed, approved, deployed and verified; what a specific fix would change,
before and after; whether a deployed fix was found on the live page; what is blocked and why.

### 5.2 Things Driver could do that no screen currently offers

These are the reason a chat surface earns its place, rather than being a slower way to reach a
dashboard.

- **Cross-source questions.** "Which pages get search traffic but have no structured data" joins
  `gsc_page_daily` to `findings`. No screen does this, and each new join is a screen nobody has to
  build.
- **Arbitrary periods and comparisons.** Every screen is fixed at 28 days.
- **Bulk reasoning over findings.** "Which of these 149 findings would actually move anything" is a
  ranking question over predicted impact and page value that the Findings list does not ask.
- **Explaining a movement.** "Why did clicks drop last week" is a decomposition across queries,
  pages and positions.
- **Walking a setup.** "Why is my AI visibility empty" reads `integration_status`, `tracked_keywords`
  and prompts, and names the one missing step.
- **Turning an answer into work.** Every answer that surfaces a fixable finding ends at the propose
  action, which is the existing `SuggestedAction` bridge generalised.

### 5.3 Deliberately out of v1

- Autonomous background monitoring. Profound shipped this as a separate product, Aim. It is a
  scheduled job that writes findings, not a chat feature, and it belongs behind the same execution
  contract.
- Content drafting as a chat output. It reaches the customer as an `Action`, per the teardown.
- Customer MCP servers (roadmap M3.6). Third-party tools multiply the §4.7 surface and should land
  after the trifecta controls are proven.
- Voice, scheduled reports, exports.

---

## 6. Data reality

Driver will be judged on its first answer, and the first answer is only as good as the data behind
it. Two facts about the current deployment matter:

- Whether any customer has completed the Google connect flow on production. The pipeline itself is
  in place — `ENCRYPTION_KEY` is bound on the Worker, Engine's OAuth client lives in
  `platform_credentials` since migration 0019 rather than in the environment, and the nightly sync
  cron runs. What is not established is that `gsc_*` and `ga` hold rows for a real account. Check
  `GET /health/integrations` and the Integrations screen before assuming the search and traffic
  tools have anything to return.
- ~~Wave 3 of the action plan — what we measure and how often — has not been done.~~ **Done on
  2026-09-10**, merged as #111 and deployed; the database is at 0035. Rank polling, AI answer
  polling with stored answers, share of voice over mined mentions, and per-tier cadence all exist.
  The action plan sequenced Driver last because it "should cite trustworthy data, which waves 1
  and 3 produce" — both have now produced it, so that gate is cleared.

What remains of this section is the first bullet, and it is the one that matters: the pipeline is
in place but **no customer has been observed completing the Google connect flow on production**,
so `gsc_*` and `ga` may still be empty. Decision 6 in §9a settles what to do about it — ship
regardless — which makes §4.2's three-state rule (not connected / no data yet / a real zero) load
bearing rather than a nicety.

The "build before or after wave 3" question in §9 is therefore moot, and is marked so in §9a.

---

## 7. Build sequence

Each step is independently mergeable and leaves the product working.

| # | Step | Size | Depends on |
|---|---|---|---|
| 1 | Vendor probe: tool calling, parallel calls, streaming tool deltas, `reasoning_effort` against real latency, worker CPU and subrequest limits under a worst-case turn. Written up before any design is fixed. | S | `feat/measurement-methodology` landing |
| 2 | Connector: multi-turn messages, `tools`, `tool_choice`, tool-call deltas in the stream. | M | 1 |
| 3 | `packages/driver`: agent loop with budgets, and five read tools end to end. | L | 2 |
| 4 | Conversation persistence, migration 0034+. | M | 3 |
| 5 | Response-part protocol and the standalone screen rendering text, metric, table, findings. | L | 3, 4 |
| 6 | The remaining read tools. | M | 3 |
| 7 | Tier 1 write tools. | M | 5 |
| 8 | Tier 2 write tools and the confirmation component. | M | 7 |
| 9 | Injection controls hardened and tested with a deliberately poisoned crawled page. | M | 7 |
| 10 | The bar on other screens, and screen context. | S | 5 |
| 11 | Evaluation harness (§10). | M | 4 |

Step 1 is not optional. Three architectural choices depend on answers nobody has yet: whether
parallel tool calls work, whether a full turn fits the worker's CPU limit, and what
`reasoning_effort: high` costs in seconds on a 20-tool catalogue.

---

## 8. Answers to the five questions the action plan asks

**Actions.** In-app actions, tiered by reversibility in §4.3. Tier 0 reads run freely. Tier 1
internal and reversible actions run without asking and are logged. Tier 2 actions with recurring
cost or an effect on the live path require confirmation in the UI. Tier 3 — deploy, rollback,
billing, account shape, auth — Driver never calls. Nothing goes out through integrations to third
parties in v1, and Driver has no outward channel at all, which is also a security control.

**Grounding and citation.** The existing rule survives verbatim: figures and citations are
retrieval-built, never model-authored. Under tool calling this is enforced by the response-part
protocol — values live in typed parts sourced from tool results, and the model supplies selection
and prose only. Bands stay bands. §4.6.

**Surface.** A standalone screen at `#/driver` with thread history, plus a bar on other screens
that carries screen context. Rich responses are typed parts, each tool declaring its own render
shape, reusing the existing Findings and Fix Queue components. The model picks the tool, never the
chart. §4.5, §4.9.

**Model.** `sarvam-105b` pinned for Driver, for its 128K context, not the 32K conversations model
that the citation poll now defaults to. The same model plans and answers in v1; a separate planner
is not justified until the single-model loop is measured. Fallback is the existing deterministic
four-intent Copilot, which needs no key and answers in under three seconds. §2, §4.8.

**Trust.** When Driver cannot answer it says which tool returned nothing and what would fill it,
using the three-state vocabulary the product already has — not connected, no data yet, zero. Every
answer is auditable through stored tool calls. A Tier 1 action is undone through the existing Fix
Queue. A Tier 2 action was confirmed by a person before it happened. Tier 3 never happens.
§4.3, §4.4, §4.6.

---

## 9. Open decisions — all answered, see §9a

**Closed on 2026-09-10.** This section is kept as the record of what was asked and what was
recommended, because three of the answers went against the recommendation and the reasoning is
only legible with both halves. **§9a is what to build.** Nothing here is still open.

1. **Sequencing against wave 3.** Build Driver now on thin data, or after wave 3 so its first
   answers are substantial? *Recommendation: start steps 1 and 2 now — they are vendor and
   connector work that wave 3 does not touch — and gate the surface on `gsc_*` and `ga` holding
   rows for at least one real customer.*

2. **Tool catalogue size per turn.** Offer all twenty tools every turn, or route to a subset first?
   *Recommendation: measure in step 1. Offer all of them if latency allows; a router is a second
   place for the product to be wrong about intent.*

3. **Deploy.** Stays Tier 3, or becomes Tier 2 with confirmation? *Recommendation: Tier 3 for v1.
   Revisit once the confirmation component has been in front of customers.*

4. **Thread visibility.** Private to the author, or visible to the account? *Recommendation:
   account-visible for agencies, since the whole point of the client layer is shared work — but
   this needs a view on whether a question is ever sensitive.*

5. **Model picker.** `modelPicker.ts` assumes one model choice across surfaces because "a person
   who picked the quick model means it on the other screen too." Driver needs 128K. Does the picker
   become per-surface, or does Driver simply not offer a choice? *Recommendation: Driver offers no
   model choice and says which model answered.*

6. **`page_content` in v1.** It is the most useful tool for content questions and the main injection
   vector. *Recommendation: ship it in step 9, after the controls, not before.*

---

## 9a. The decisions, taken 2026-09-10

The six questions in §9 are answered. Three of them add scope §4 does not describe, marked
**new scope**; those are the ones to read before estimating.

**1. Sequencing against wave 3 — moot.** Wave 3 shipped the same day this document merged, so
there is no longer a choice to make. See the correction in §6.

**2. Tool catalogue size — measure it in step 1, as recommended.** Offer all twenty tools per turn
if latency allows; a router is a second place to be wrong about intent.

**new scope** — with a requirement this document does not carry: **an admin control that allows
or blocks individual tools for the whole organisation, and sets read against write access.** That
is org-level tool governance. It lands on §4.2 and §4.3 — the tool definitions need an
enabled/disabled state and a read-or-write classification that an admin can set — and on Settings,
which needs the surface to set it. It does not touch the loop in §4.1.

**3. Deploy stays Tier 3 for v1, to be revisited.** Driver never calls deploy or rollback; it
walks the customer to the button. Reconsider once the Tier 2 confirmation component in §4.3 has
been in front of real customers.

**4. Threads are private by default, with explicit sharing.** Not "private to the author" and not
"visible to the account" — the two options §9 offered. Modelled on how Claude shares artifacts:
share with named people in the organisation, or with the whole organisation.

**new scope.** §4.4's `driver_threads` sketch cannot express this. It needs a visibility state on
the thread (private / named / organisation) and a share table naming the people a private thread
has been shared with, plus a read check on every thread and message route. Budget the migration
and the routes accordingly; the sketch in §4.4 is now incomplete rather than wrong.

**5. The model control moves into Settings, filtered per surface.** Neither of §9's options: not a
per-screen picker, and not "Driver offers no choice". Settings lists, for each surface, only the
models that can run it, so Driver never offers a 32K model in the first place.

**new scope**, and it changes a shipped surface rather than only Driver. `modelPicker.ts` assumes
one choice across surfaces; that assumption is now wrong and the picker is what gives way. Because
more LLMs are expected, **a model declares its context size once and every surface filters on
it** — the rule, not a hardcoded list of which model suits which screen. This also resolves the
contradiction §2 raises: wave 3 correctly made `sarvam-105b-conversations` (32K) the default for
live answers so try-a-prompt matches the citation poll's instrument, while Driver needs
`sarvam-105b` (128K) for a system prompt plus a 20-tool catalogue plus several tool results. Both
defaults are right for their own surface; only the picker's one-choice assumption was wrong.

**6. Ship the Driver surface regardless of Google data.** No gate on `gsc_*` and `ga` holding
rows, which is the opposite of §9's recommendation. Consequence to design for: early on, most
search and traffic answers will be "not connected". §4.2's rule 3 — three distinct states, never
one — therefore carries the whole first impression and is load bearing, not a nicety.

**7. `page_content` ships at step 9, after the injection controls**, as recommended. The
poisoned-crawled-page test in §10 gates it.

### What these change, by section

| Section | Change |
|---|---|
| §4.1 Agent loop | none |
| §4.2 Read tools | tools need an enabled/disabled state and a read-or-write class; rule 3 becomes load bearing |
| §4.3 Write tools | the tier table gains an admin override; deploy stays Tier 3 |
| §4.4 Conversation state | the migration is 0036+, and needs thread visibility plus a share table |
| §4.9 Surfaces | Settings gains a per-surface model list and an org tool-governance panel |
| §7 Build sequence | unchanged in order; steps 1 and 2 are unblocked and nothing waits on wave 3 |

---

## 10. How we will know it works

Chat features are easy to demo and hard to trust, so evaluation is part of the build, not a later
phase.

- **A question set with known answers.** Fifty questions across the catalogue, each with the
  answer computed directly from the database. Run on every change to the loop or the prompts.
- **Grounding check.** Every numeral in the prose appears in a tool result for that turn.
- **Refusal quality.** Questions the product genuinely cannot answer must produce the specific
  missing step, not a generic apology and not an invented answer.
- **Injection suite.** A crawled page fixture containing instructions, asserting no write tool is
  called and nothing is exfiltrated.
- **Latency.** Time to first token, and time to a complete grounded answer, per model and per
  `reasoning_effort`.
- **Tenancy.** A test that a tool called in one project can never return another project's rows.

---

## Sources

Vendor: [Sarvam Chat Completion API](https://docs.sarvam.ai/api-reference/chat/chat-completions),
[Sarvam LangChain integration](https://docs.sarvam.ai/api/integration/langchain),
[Sarvam Vercel AI SDK integration](https://docs.sarvam.ai/api/integration/vercel-ai-sdk).

Agentic analytics and the semantic layer:
[Cube — best agentic analytics platforms 2026](https://cube.dev/articles/best-agentic-analytics-platforms-2026),
[Strategy — agentic BI needs a semantic layer](https://www.strategy.com/software/blog/google-next-26-just-validated-agentic-bi-needs-a-semantic-layer),
[Databricks — what is agentic BI](https://www.databricks.com/blog/what-is-agentic-bi),
[Looker updates for agentic BI](https://cloud.google.com/blog/products/business-intelligence/looker-updates-for-agentic-bi-at-next26).

Human-in-the-loop and action tiering:
[Atlassian — human-in-the-loop patterns for AI agents](https://www.atlassian.com/software/jira/guides/agentic-engineering/human-in-the-loop),
[Human-in-the-loop escalation design 2026](https://www.digitalapplied.com/blog/human-in-the-loop-escalation-design-ai-agents-2026).

Prompt injection:
[Airia — the lethal trifecta and how to defend](https://airia.com/blog/ai-security-in-2026-prompt-injection-the-lethal-trifecta-and-how-to-defend/),
[Help Net Security — prompt injection drives most agentic AI failures](https://www.helpnetsecurity.com/2026/06/11/owasp-prompt-injection-ai-security-failures/),
[Trust No Tool: LLM agents under untrusted tool feedback](https://arxiv.org/pdf/2605.17453).

Internal: `docs/50-X0-Profound-Teardown.md`, `docs/reviews/2026-09-10-action-plan.md` §wave 4,
`docs/10-Roadmap.md` M2.4 and M3.6.
