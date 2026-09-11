# Pending items

**This file is rewritten, never appended.** It is the single current answer to "what is left".
`working_log.md` is the history; this is the state. If the two disagree, this file is wrong and
should be corrected from the source.

Last updated: 2026-09-11, against `feat/driver-agent-loop`, rebased on `origin/main` at `4344635`
(#132 merged), plus this branch's work. Every row below was re-measured against the tree.

Sequence and reasoning: `docs/reviews/2026-09-11-remaining-build-plan.md` and, for Driver,
`docs/reviews/2026-09-10-driver-scoping.md` §7 and §9a, with
`docs/reviews/2026-09-11-driver-vendor-probe.md` for the loop's bounds. Read the linked detail
before starting an item — it is more precise than the one-liners here.

---

## Open

| # | Item | Size | State | Detail | Blocked by |
|---|---|---|---|---|---|
| 1 | **Driver step 4 — conversation persistence.** Migration **0036**: `driver_threads`, `driver_messages`, `driver_tool_calls`, plus §9a decision 4's thread visibility (private / named / organisation) and a share table, and a read check on every thread and message route. `runTurn` already returns the whole transcript ready to persist, and `/driver/ask` accepts a `history` array it does not yet store. | M | next | driver scoping §4.4 + §9a decision 4 | — |
| 2 | **Driver step 5 — the response-part protocol and the screen.** Typed parts (`text`, `metric`, `table`, `series`, `findings`, `fixes`, `action`, `citation`), each tool declaring its render shape, reusing the Findings row and Fix Queue card. Plus `#/driver` as a seventh rail destination. Today `/driver/ask` returns prose and an audit trail, and there is no screen. | L | open | driver scoping §4.5, §4.9 | step 4 |
| 3 | **Decide whether Driver streams, and on which Workers plan.** The loop is deliberately non-streaming: the probe measured SSE parsing at 5.96 ms against 0.018 ms for the same turn as a JSON body, on an account with a 10 ms CPU budget. Streaming the final answer is worth doing and `RoundRecord` carries what it would need, but it costs either a move to Workers Paid or a measurement on a real Worker. **A decision, not code.** | S | next | probe §2 and §5 | the user |
| 4 | **Driver steps 7–11.** Tier 1 write tools, Tier 2 write tools with the confirmation component, injection controls hardened against a deliberately poisoned crawled page, `page_content`, the bar on other screens with screen context, and the evaluation harness. `buildSystemPrompt` already accepts `screenContext`; nothing passes it yet. | L | open | driver scoping §7 + §9a | step 5 |
| 5 | **`modelPicker.ts` still assumes one model choice across every surface.** `contextTokens` is declared and `llmModelsWithContext` filters on it — `createConversationalLlmConnector` uses exactly that to pin a 128K model for Driver — but the picker and the two screens that mount it (`copilot.ts:135`, `offsite.ts:425`) still offer whatever `GET`'s `models` array holds. §9a decision 5 moves the control into Settings, filtered per surface. **New scope — ask before starting.** | M | open | driver scoping §9a decision 5 | a decision |
| 6 | **Org-level tool governance, and thread sharing.** The other two §9a "new scope" items. Governance needs an enabled/disabled state on each tool definition plus a Settings surface; sharing needs the visibility model in row 1. `ToolAccess` (`read` \| `write`) and `ToolTier` are already declared on every definition, which is the half that was free. **New scope — ask before starting.** | M each | open | §9a decisions 2 and 4 | a decision |

### What each row was measured against

Recorded so the next audit re-measures rather than trusting this line.

| Row | Measurement |
|---|---|
| 1 | `ls infra/migrations/postgres/ \| tail -1` is `0035_account_kind.sql`, so Driver's first migration is still 0036. `runTurn` returns `messages` and `rounds`; nothing writes them. `/driver/ask` reads `body.history` and passes it to the loop, and no table holds it |
| 2 | `grep -rn "#/driver" apps/dashboard/src` returns nothing. `/driver/ask` returns `{source, answer, stopReason, partial, usage, rounds}` — prose plus the audit trail, no typed parts |
| 3 | `loop.ts` calls `converse` only, and a test asserts `streamConverse` throws if reached. Probe §2 measured the two costs on the same turn |
| 4 | No write tool exists: `READ_TOOLS` is 19, every entry is `tier: 0, access: 'read'`, and `DEFERRED_TOOLS` still names `page_content`. `PromptContext.screenContext` is optional and no call site sets it |
| 5 | `modelPicker` has two call sites, `copilot.ts:135` and `offsite.ts:425`. `index.ts` serves `LLM_MODEL_CHOICES` whole, with no per-surface filter. Unchanged by this branch |
| 6 | `ToolAccess` and `ToolTier` are declared in `packages/driver/src/types.ts` and set on all 19 definitions. Nothing reads them and no admin surface exists |

### What changed in this audit

**Driver step 3 is done.** The agent loop runs in `packages/driver/src/loop.ts`, wired to the
product through `apps/api/src/driver/ask.ts` and `POST /projects/:projectId/driver/ask`. All four
bounds are the probe's measured numbers rather than judgement: 4 rounds, 4 calls per round,
45 s, and a 96,000-token ceiling that will not bind in practice.

**The `usage` defect is fixed, so its row is gone.** `streamConverse` dropped the vendor's usage
frame through the guard that skips choice-less frames. `LlmTurn` now carries optional `usage`,
`LlmTurnChunk` has a `usage` chunk, and `readWireUsage` returns `undefined` rather than zeros
when the vendor reported nothing — a loop budgeting tokens must tell "not reported" from "cost
nothing".

**Row 3 is the probe's open question, unchanged and now the only thing gating a better surface.**
The loop works without it; the thinking-phase display does not.

**The Google guide row is gone: #132 shipped it.** `apps/web/docs/guides/connecting-google/`
holds the built page and 16 screenshots on `origin/main`.

### What this build leaves behind

**A partial answer costs an extra model round.** On max-rounds or the token ceiling the loop
spends one more call with `tool_choice: 'none'` to get an answer out of what it gathered. That is
deliberate — the alternative is handing the customer a turn with tool results and no prose — but
it means the worst case is 5 model calls, not 4. The deadline path does not do this, because
waiting longer is the one thing a deadline exists to prevent.

**A turn that hits the deadline returns no text at all**, and `askDriver` falls back to the
deterministic Copilot for it. That is the right behaviour today and it will look wrong once the
screen exists: the customer sees a narrower answer with no sign that a richer one was nearly
ready. Step 5 should decide what a deadline looks like on screen.

**`history` is accepted and not persisted.** `/driver/ask` passes whatever the caller sends
straight into the transcript. That is fine while the only caller is a test, and it is a trust
boundary the moment a browser calls it — a caller could forge an assistant turn. Row 1 closes it
by loading history from the database instead.

**The loop holds the whole transcript in memory and returns it.** Correct at four rounds and
~15,000 tokens. It is not a design that survives a long-running thread, and §4.1's "oldest turns
dropped first" is unimplemented because the probe measured that it is not needed yet.

## Waiting on something outside the code

| Item | Waiting on |
|---|---|
| Engine's Google app registration | The user, partly done. `apps/api/.dev.vars` carries the client id, secret and redirect URI, so a local deployment can run the connect flow. Whether production's `platform_credentials` row is set was not measured from here |
| `GITHUB_WEBHOOK_SECRET` and the App's webhook URL | Registering Engine's GitHub App, which is only worth doing when a customer wants PR-based deploys. Unset is safe: the endpoint fails closed and the nightly pass finds merges |
| A live Google connection on production | A customer completing the connect flow. `gsc_*` and `ga4_channel_daily` may still be empty — handled rather than merely noted: all six Google tools report `not-connected` with the specific next step, and the system prompt tells the model to check `integration_status` before concluding a site is quiet |

## Deferred, with the trigger that reopens it

From `2026-09-10-action-plan.md` unless noted. These are decisions, not backlog.

| Item | Trigger |
|---|---|
| Billing, plan limits, upgrade screen | Before the first paying customer |
| Bing sync | Customer demand. The honesty line is already on the tile |
| MCP (roadmap M3.6) | After the product works well |
| ClickHouse | `gsc_query_daily` ≈ 50M rows, or Pulse rollup p95 > 500 ms |
| Alerts and notifications | Its own feature, with push and in-app |
| `getAccessToken` per-connection lock | The first provider that rotates refresh tokens. Harmless for Google |
| Driver calling deploy or rollback | After the Tier 2 confirmation component has been in front of real customers. §9a decision 3 |
| `page_content` as a tool | Driver step 9. The poisoned-crawled-page test gates it. §9a decision 7. `DEFERRED_TOOLS` names it so step 9 has one place to look |
| A router that narrows the catalogue before the model sees it | The probe measured the 20 tools at **2,974 tokens, 43% of the request**. §9a decision 2 said offer all of them if latency allows, and latency does. Reopens if rounds start missing the wall-clock budget |
| History trimming in the loop | A thread that approaches the 128K window. The probe measured a worst-case turn at 12% of it, so §4.1's "oldest turns dropped first" is unbuilt on purpose |
| A single-call fallback for tools | Never. Parallel calls are confirmed, so the serial degradation path §4.8 would have needed does not exist |
| Parsing tool-call arguments in the connector | Never. `validate.ts` in `packages/driver` is the layer that knows the schema |
| Promote the Driver doc to `docs/feature-specs/D1-driver.md` | Still due, now folding in §9a and the probe |
| Gate "+ New client" inside `views/accounts.ts` | Never, unless the Clients grid becomes reachable without an agency account |
| Fold `.oprow` and `.serp-row` into the row grammar | A figure appearing in either |
| Retire `.loading` | A fourth state stops being a distinct fact, or its five call sites go |
| Fold `.gm-note` into `.notebox` | The Google panels needing a note at body size |
| Per-entity brand detail on Findings | Never, unless the Brand tab goes |

## Done since the redesign began

Kept short on purpose; `working_log.md` has the detail. **The redesign is finished, v1 data
readiness step 4 is finished, and Driver has reached step 4 of eleven.** Redesign steps 1–8
(#105, #107, #108, #113–#117, #119, #120, and the `kind` gate in #124), data screens 1, 4, 5 and
7, action-plan waves 0–3, PR merge verification both ways, v1 readiness step 6 (#125), step 9's
three passes — 5a (#126), 5b (#127), 5c (#128) — brand strength on Findings (#129), the Google
connection guide on the docs site (#132), and Driver **steps 1, 2, 3 and 6**: the connector's tool
calling (#130), the vendor probe and the nineteen-tool read catalogue (#131), and the agent loop
with the `/driver/ask` route (this branch).
