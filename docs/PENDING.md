# Pending items

**This file is rewritten, never appended.** It is the single current answer to "what is left".
`working_log.md` is the history; this is the state. If the two disagree, this file is wrong and
should be corrected from the source.

Last updated: 2026-09-11, against `feat/driver-tool-calling` at `87dd2f7`. That branch is
stacked on `feat/brand-strength-findings` (PR #129, open), which is `origin/main` at `7438b1a`
(#128 merged). **Merge #129 first.** Every row below was re-measured against the tree, not
carried forward.

Sequence and reasoning: `docs/reviews/2026-09-11-remaining-build-plan.md` and, for Driver,
`docs/reviews/2026-09-10-driver-scoping.md` §7 and §9a. Read the linked detail before starting
an item — it is more precise than the one-liners here.

---

## Open

| # | Item | Size | State | Detail | Blocked by |
|---|---|---|---|---|---|
| 1 | **Driver step 3 — `packages/driver`: the agent loop and the read tools.** The loop's four bounds (rounds per turn, calls per round, wall-clock, token budget) need the probe. **The read-tool catalogue does not** — twenty named, project-scoped queries with provenance and the three-state vocabulary are ordinary SQL and can be built and tested now. | L | next | driver scoping §4.1, §4.2 | the loop half only |
| 2 | **Driver steps 4–11.** Conversation persistence (migration 0036+, with thread visibility and a share table), the response-part protocol and the screen, the remaining read tools, Tier 1 and Tier 2 write tools, injection controls, the bar, evaluation. | L | open | driver scoping §7 + §9a | step 3 |
| 3 | **`modelPicker.ts` still assumes one model choice across every surface.** `contextTokens` is now declared on the model and `llmModelsWithContext` filters on it, but the picker and the two screens that mount it (`copilot.ts:135`, `offsite.ts:425`) still offer whatever `GET`'s `models` array holds. §9a decision 5 moves the control into Settings, filtered per surface. | M | open | driver scoping §9a decision 5 | — |
| 4 | **The Google integration guide.** 14 screenshots sit untracked in `docs/guides/img/` with no guide document beside them, and the `working_log.md` entry describing them is uncommitted. **Another session owns this** — recorded because it is state, not because it is unassigned. | S | in progress elsewhere | that log entry; `docs/40-Integrations.md` step 3 describes Google's retired consent-screen wizard | — |

**The Driver vendor probe is not in Open** — it is not pending work, it is blocked on a
credential. See the table below.

### What each row was measured against

Recorded so the next audit re-measures rather than trusting this line.

| Row | Measurement |
|---|---|
| 1 | `ls packages` returns 19 packages and `driver` is not among them. §4.2's catalogue is twenty tools; §1.4 measured that the Copilot reaches 3 tables of 39, so the queries are new work, not wiring |
| 2 | Unchanged from the scoping document's §7 table, with §9a's amendments folded in: the migration is 0036+, not 0034+, and it needs thread visibility plus a share table |
| 3 | `modelPicker` has two call sites, `copilot.ts:135` and `offsite.ts:425`. `index.ts:855` serves `LLM_MODEL_CHOICES` whole, with no per-surface filter. `contextTokens` and `llmModelsWithContext` exist in `llmModels.ts` and are read only by `createConversationalLlmConnector` |
| 4 | `find docs/guides -type f` returns 14 files, all PNGs under `img/`; there is no `.md` in the directory. `git status --short docs/guides` reports it untracked in full |

### What changed in this audit

**Driver step 2 is done.** The connector now holds a multi-turn conversation and asks for tools:
`llmTools.ts` carries the vocabulary and the OpenAI-shaped serialisation, `SarvamConnector` gains
`converse` and `streamConverse`, and `sample`, `complete` and `stream` go through them instead of
through four near-identical `fetch` blocks. Connectors tests are 152, up from 124.

**Step 2 was not blocked by step 1, and the ledger said so wrongly by omission.** The previous
row lumped steps 2–11 together behind the probe. §2 of the scoping document had already checked
the vendor documentation: `tools`, `tool_choice`, the four message roles and streaming-with-tools
are supported, and only *parallel* tool calls are undocumented — a question for the loop, not the
wire format. Steps are now listed by what each actually waits on.

**Row 3 is new, and it is half of my own doing.** §9a decision 5 has two halves: a model declares
its context size, and every surface filters on it. The first half shipped in this build because
`createConversationalLlmConnector` needed it. The second half changes `modelPicker.ts`, a shipped
surface with two call sites, and belongs with the Settings work rather than with a connector
change.

**Row 4 is unchanged and now has an owner.** It is another session's work, kept here because this
file is the state of the tree and the tree has 14 untracked screenshots in it.

### What this build leaves behind

`converse` returns a truncated turn instead of throwing on one, which is the opposite of what
`sample` does. That is deliberate and is the one behavioural asymmetry in the file: a citation
sample must refuse a turn cut off mid-thought, and an agent loop may retry it with a larger
budget. `streamConverse` still throws when a turn produced nothing at all, but a turn that spent
its budget deciding to call a tool now counts as having produced something.

`ToolCallAccumulator` keys argument fragments by the vendor's `index` rather than concatenating
them in arrival order. That is the only form that survives two interleaved calls, which is
precisely what the probe is meant to determine — so the probe's answer changes nothing here.

## Waiting on something outside the code

| Item | Waiting on |
|---|---|
| **The Driver vendor probe** (driver scoping §7 step 1) | A `SARVAM_API_KEY` that can be used locally. `apps/api/.dev.vars` exists and its ten keys do not include it. What the probe still owns: whether parallel tool calls work, whether a worst-case turn fits the Worker's CPU and subrequest limits, and what `reasoning_effort: high` costs in seconds on a twenty-tool catalogue. Those three set the loop's bounds in step 3; the connector no longer waits on any of them, and `reasoningEffort` is now a parameter the probe can be run through |
| Engine's Google app registration | The user, partly done. `apps/api/.dev.vars` carries `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REDIRECT_URI`, so a local deployment can run the connect flow. Whether production's `platform_credentials` row is set was not measured from here |
| `GITHUB_WEBHOOK_SECRET` and the App's webhook URL | Registering Engine's GitHub App, which is only worth doing when a customer wants PR-based deploys. Unset is safe: the endpoint fails closed and the nightly pass finds merges |
| A live Google connection on production | A customer completing the connect flow. `gsc_*` and `ga` may still be empty, which is why Driver's three-state rule is load bearing |

## Deferred, with the trigger that reopens it

From `2026-09-10-action-plan.md` unless noted. These are decisions, not backlog.

| Item | Trigger |
|---|---|
| Billing, plan limits, upgrade screen | Before the first paying customer |
| Bing sync | Customer demand. The honesty line is already on the tile |
| MCP (roadmap M3.6) | After the product works well |
| ClickHouse | `gsc_query_daily` ≈ 50M rows, or Pulse rollup p95 > 500 ms |
| Alerts and notifications | Its own feature, with push and in-app |
| `getAccessToken` per-connection lock | The first provider that rotates refresh tokens. Harmless for Google — ship-readiness review's own judgment, and the third of that review's Tier 2 items, deliberately not done with the other two |
| Driver calling deploy or rollback | After the Tier 2 confirmation component has been in front of real customers. §9a decision 3 |
| `page_content` as a tool | Driver step 9. The poisoned-crawled-page test gates it. §9a decision 7 |
| Parsing tool-call arguments in the connector | Never. The layer that knows the tool's schema is the layer that should decide what a malformed argument means |
| Promote the Driver doc to `docs/feature-specs/D1-driver.md` | Before Driver step 3, folding §9a into §4 rather than appending |
| Gate "+ New client" inside `views/accounts.ts` | Never, unless the Clients grid becomes reachable without an agency account. #124 already redirects `#/clients` to Home for every other kind |
| Fold `.oprow` and `.serp-row` into the row grammar | A figure appearing in either |
| Retire `.loading` | A fourth state stops being a distinct fact, or its five call sites go — four in `copilot.ts`, one in `serp.ts` |
| Fold `.gm-note` into `.notebox` | The Google panels needing a note at body size. Today it is deliberately `--t-2xs` |
| Per-entity brand detail on Findings | Never, unless the Brand tab goes. The group names the weakest entity and links to the tab that breaks it down |
| The crawl-coverage half of v1 readiness step 6 | Never — already shipped |

## Done since the redesign began

Kept short on purpose; `working_log.md` has the detail. **The redesign is finished, v1 data
readiness step 4 is finished, and Driver has started.** Redesign steps 1–8 (#105, #107, #108,
#113–#117, #119, #120, and the `kind` gate in #124), data screens 1, 4, 5 and 7, action-plan
waves 0–3, PR merge verification both ways, v1 readiness step 6 (#125), step 9's three passes —
5a (#126), 5b (#127), 5c (#128) — brand strength on Findings with the `.intg-grid` breakpoint
corrected and three small items closed (#129), and Driver step 2, the connector's tool calling
(this branch).
