# Pending items

**This file is rewritten, never appended.** It is the single current answer to "what is left".
`working_log.md` is the history; this is the state. If the two disagree, this file is wrong and
should be corrected from the source.

Last updated: 2026-09-11, against `feat/driver-persistence`, branched from `origin/main` at
`9e0151d` (#133 merged), plus this branch's work. Every row below was re-measured against the
tree.

Sequence and reasoning: `docs/reviews/2026-09-11-remaining-build-plan.md` and, for Driver,
`docs/reviews/2026-09-10-driver-scoping.md` §7 and §9a, with
`docs/reviews/2026-09-11-driver-vendor-probe.md` for the loop's bounds. Read the linked detail
before starting an item — it is more precise than the one-liners here.

---

## Open

| # | Item | Size | State | Detail | Blocked by |
|---|---|---|---|---|---|
| 1 | **Driver step 5 — the response-part protocol and the screen.** Typed parts (`text`, `metric`, `table`, `series`, `findings`, `fixes`, `action`, `citation`), each tool declaring its render shape, reusing the Findings row and Fix Queue card. Plus `#/driver` as a seventh rail destination, a thread list, and the sharing controls the step 4 routes already serve. Today `/driver/ask` returns prose and an audit trail, and there is no screen. | L | next | driver scoping §4.5, §4.9 | — |
| 2 | **The per-surface model picker, with step 5.** Decided 2026-09-11: it lands when the Driver screen does, so the two shipped call sites change once against a surface that has three consumers rather than twice. `contextTokens` and `llmModelsWithContext` are built and `createConversationalLlmConnector` filters on them; `GET /ai/models` still serves the list whole and `modelPicker.ts` still assumes one choice. | M | next | driver scoping §9a decision 5 | step 5 |
| 3 | **Measure the final round's CPU on a real Worker, then decide streaming.** Decided 2026-09-11: measure before committing either way. The probe's 5.96 ms for SSE parsing against 0.018 ms for the same turn as a JSON body was a laptop number, and the account's budget is 10 ms on Workers Free. Steps 4 and 5 are built non-streaming regardless; `RoundRecord` already carries what a streamed variant needs, so it stays a wrapper. | S | open | probe §2 and §5 | a production deploy of the loop |
| 4 | **Driver steps 7–11.** Tier 1 write tools, Tier 2 write tools with the confirmation component, injection controls hardened against a deliberately poisoned crawled page, `page_content`, the bar on other screens with screen context, and the evaluation harness. `buildSystemPrompt` already accepts `screenContext`; nothing passes it yet. | L | open | driver scoping §7 + §9a | step 5 |
| 5 | **Org-level tool governance — full build, its own PR after step 8.** Decided 2026-09-11. Governance over a read-only catalogue is close to a no-op, and the read-against-write split only means something once Tier 1 and Tier 2 write tools exist to block. Needs an enabled/disabled state per account, a Settings admin panel, and the narrowing itself, which has a seam already: `RunTurnOptions.tools` accepts a narrowed catalogue. | M | open | §9a decision 2 | step 8 |
| 6 | **A vendor failure mid-turn loses the tool calls that already ran.** `runTurn` throws, and the partial transcript goes with it, so `askDriver`'s catch has nothing to store beyond the question and the fallback answer. Two rounds of real tool calls can vanish from an audit trail that step 4 otherwise makes complete. Fix is a typed error carrying the transcript. | S | open | `packages/driver/src/loop.ts`, `apps/api/src/driver/ask.ts` | — |
| 7 | **A thread cannot be deleted.** Step 4 ships list, read, rename, visibility and sharing, and no delete. A customer who starts a thread by accident is stuck with it. Left out deliberately rather than missed: what deleting a shared thread does to its readers is a step 5 question. | S | open | — | step 5 |
| 8 | **CI runs no database test at all.** `TEST_DATABASE_URL` is never set in `.github/workflows/ci.yml`, so every `*.db.test.ts` hits its `describe.skipIf` and reports green. That is **17 files and 203 tests in `@engine/api` alone**, and it now includes step 4's thread read check — the code that decides whether one person can read another's conversation is tested only on a laptop. Pre-existing, not introduced here, and larger than any row above. Fix is a Postgres service container in the test job plus `pnpm db:migrate` against it. | M | open | `.github/workflows/ci.yml:31` | — |

### What each row was measured against

Recorded so the next audit re-measures rather than trusting this line.

| Row | Measurement |
|---|---|
| 1 | `grep -rn "#/driver" apps/dashboard/src` returns nothing. `/driver/ask` returns `{source, answer, threadId, stopReason, partial, usage, rounds}` — prose plus the audit trail, no typed parts |
| 2 | `modelPicker` has two call sites, `copilot.ts:135` and `offsite.ts:425`. `index.ts` serves `LLM_MODEL_CHOICES` whole, with no per-surface filter. Unchanged by this branch |
| 3 | `loop.ts` calls `converse` only, and a test asserts `streamConverse` throws if reached. Unchanged by this branch |
| 4 | No write tool exists: `READ_TOOLS` is 19, every entry is `tier: 0, access: 'read'` (19 of each), and `DEFERRED_TOOLS` still names `page_content`. `PromptContext.screenContext` is optional and no call site sets it |
| 5 | `ToolAccess` and `ToolTier` are declared in `packages/driver/src/types.ts` and set on all 19 definitions. Nothing reads them and no admin surface exists |
| 6 | `askDriver`'s `catch` calls `fallback(why)` with no `before`, because `runTurn` throws rather than returning what it had |
| 7 | `grep -n "app.delete('/projects/:projectId/driver/threads" apps/api/src/index.ts` matches only the `/shares/:userId` route |
| 8 | `grep -rn "TEST_DATABASE_URL" .github/` returns nothing. `find apps packages -name "*.db.test.ts"` is 17 files; the API package's own run reports 203 tests across them with the variable set, and skips all of them without it |

### What changed in this audit

**Driver step 4 is done, and the trust boundary is closed.** Migration **0036** adds
`driver_threads`, `driver_thread_shares`, `driver_messages` and `driver_tool_calls`.
`/driver/ask` takes a `threadId` and no longer accepts a `history` array: `AskInput.history` is
gone and history is read from `driver_messages`. A route test drives the real route with a
forged `history` in the body and asserts the vendor request carries only the system message and
the question.

**Thread sharing shipped with the migration, without its UI.** Decided 2026-09-11: schema and
enforcement now, controls with the screen in step 5. `visibility` is `private | named |
organisation`, `readableThread` is self-contained — its `organisation` branch joins
`account_members` rather than trusting the route guard to have run — and five routes reach the
schema: list, read, patch, share, unshare. Rows 5 and 6 of the previous audit are therefore
half resolved: sharing is built, governance is scheduled.

**Three §9a decisions and the streaming question were answered before any code.** They are
rows 2, 3 and 5 above. Only row 3 is still work rather than a plan.

**Row 3 is no longer "the user". It is a measurement.** The decision was taken: measure the
final round on a real Worker before committing to streaming either way.

### What this build leaves behind

**Stored and replayed are deliberately different.** Everything a turn produced is persisted for
§4.4's audit; only the question and the final answer are replayed to the model. Tool results are
§4.7 untrusted content, and replaying them re-injects one poisoned page into every later turn of
the thread — it also makes a thread's token cost quadratic in its length. The cost is that the
model must call a tool again rather than re-read an old result, which is the intended behaviour.
`docs/reviews/2026-09-10-driver-scoping.md` §4.1's "oldest turns dropped first" is now partly
implemented as this filter plus a `MAX_REPLAYED_MESSAGES = 20` cap, rather than as trimming.

**The replay cap is a round number, not a measurement.** Twenty messages is ten exchanges. The
probe measured one turn, not a thread, so there is no measured figure to use here yet. It is a
bound that prevents the unbounded case, not a tuned one.

**`visibility` is the authority and the share table is the recipient list.** The read check
consults shares only on the `named` branch, so rows that survive a trip through `organisation`
grant nothing. `shareThread` promotes `private` to `named` in the same transaction, because
otherwise "share with one person" is a two-step act whose first step silently does nothing.

**The `seq` race is prevented by an ordering, not by a constraint.** Two concurrent turns on one
thread would both compute `max(seq) + 1` and the second would die on `unique (thread_id, seq)`.
It does not happen because the `last_message_at` update takes the thread's row lock before the
`max(seq)` read. That is commented at the line; moving the update to the end of the transaction
would reintroduce it silently.

**A failed write no longer loses the answer, and that took a review to catch.** `record`
returned an un-awaited promise from inside a `try`, so a `persistTurn` rejection escaped both the
`catch` and the route and became a 500 on a turn that had already produced a complete grounded
answer. Persistence failures are now caught where they happen: logged, and the answer returned
without a `threadId`. Routing them into the `catch` would have been the wrong fix — that path
degrades to the deterministic Copilot, so an audit write failing would have cost the customer a
worse answer as well.

**A partial answer still costs an extra model round**, and a turn that hits the deadline still
returns no text and falls back to the deterministic Copilot. Both unchanged from step 3, and
step 5 still has to decide what a deadline looks like on screen.

## Waiting on something outside the code

| Item | Waiting on |
|---|---|
| Engine's Google app registration | The user, partly done. `apps/api/.dev.vars` carries the client id, secret and redirect URI, so a local deployment can run the connect flow. Whether production's `platform_credentials` row is set was not measured from here |
| `GITHUB_WEBHOOK_SECRET` and the App's webhook URL | Registering Engine's GitHub App, which is only worth doing when a customer wants PR-based deploys. Unset is safe: the endpoint fails closed and the nightly pass finds merges |
| A live Google connection on production | A customer completing the connect flow. `gsc_*` and `ga4_channel_daily` may still be empty — handled rather than merely noted: all six Google tools report `not-connected` with the specific next step, and the system prompt tells the model to check `integration_status` before concluding a site is quiet |
| The Workers plan, if row 3's measurement says streaming needs Paid | The user. Not a decision yet — the measurement comes first |

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
| Replaying tool results into later turns | Never, unless a measured need appears. The security and cost arguments are in `loadHistory` |
| Trimming a thread by tokens rather than by message count | A thread that hits `MAX_REPLAYED_MESSAGES` often enough that the twenty-message cap is felt as a limit rather than as a ceiling |
| A single-call fallback for tools | Never. Parallel calls are confirmed, so the serial degradation path §4.8 would have needed does not exist |
| Parsing tool-call arguments in the connector | Never. `validate.ts` in `packages/driver` is the layer that knows the schema |
| Promote the Driver doc to `docs/feature-specs/D1-driver.md` | Still due, now folding in §9a, the probe, and step 4's sharing model |
| Gate "+ New client" inside `views/accounts.ts` | Never, unless the Clients grid becomes reachable without an agency account |
| Fold `.oprow` and `.serp-row` into the row grammar | A figure appearing in either |
| Retire `.loading` | A fourth state stops being a distinct fact, or its five call sites go |
| Fold `.gm-note` into `.notebox` | The Google panels needing a note at body size |
| Per-entity brand detail on Findings | Never, unless the Brand tab goes |

## Done since the redesign began

Kept short on purpose; `working_log.md` has the detail. **The redesign is finished, v1 data
readiness step 4 is finished, and Driver has reached step 5 of eleven.** Redesign steps 1–8
(#105, #107, #108, #113–#117, #119, #120, and the `kind` gate in #124), data screens 1, 4, 5 and
7, action-plan waves 0–3, PR merge verification both ways, v1 readiness step 6 (#125), step 9's
three passes — 5a (#126), 5b (#127), 5c (#128) — brand strength on Findings (#129), the Google
connection guide on the docs site (#132), and Driver **steps 1, 2, 3, 4 and 6**: the connector's
tool calling (#130), the vendor probe and the nineteen-tool read catalogue (#131), the agent loop
with the `/driver/ask` route (#133), and conversation persistence with thread sharing (this
branch).
