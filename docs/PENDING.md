# Pending items

**This file is rewritten, never appended.** It is the single current answer to "what is left".
`working_log.md` is the history; this is the state. If the two disagree, this file is wrong and
should be corrected from the source.

Last updated: 2026-09-11, against `feat/account-type-and-settings-homes`, branched from
`origin/main` at `deef5b6` (#134 merged), plus this branch's work. Every row below was
re-measured against the tree.

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
| 8 | **CI runs no database test at all.** `TEST_DATABASE_URL` is never set in `.github/workflows/ci.yml`, so every `*.db.test.ts` hits its `describe.skipIf` and reports green — **17 files and 207 tests in `@engine/api` alone**. This build made the cost concrete: the local docker Postgres was a migration behind `main`, 34 tests failed on a missing `driver_threads`, and nothing in CI would ever have said so. Fix is a Postgres service container in the test job plus `pnpm db:migrate` against it. | M | open | `.github/workflows/ci.yml:31` | — |
| 9 | **An account cannot be deleted or merged.** Onboarding could create a workspace as a side effect of a radio button, and the product has no way to remove the result: no `DELETE /accounts/:accountId`, and no way to move a project between accounts. The cause is fixed on this branch, so no *new* stray workspaces appear, but existing ones are reachable only from SQL. | S | open | `grep -n "app.delete('/accounts" apps/api/src/index.ts` returns nothing | — |

### What each row was measured against

Recorded so the next audit re-measures rather than trusting this line.

| Row | Measurement |
|---|---|
| 1 | `grep -rn "#/driver" apps/dashboard/src` returns nothing. `/driver/ask` returns `{source, answer, threadId, stopReason, partial, usage, rounds}` — prose plus the audit trail, no typed parts |
| 2 | `modelPicker` has two call sites, `copilot.ts:135` and `offsite.ts:425`. `index.ts` serves `LLM_MODEL_CHOICES` whole, with no per-surface filter. Unchanged by this branch |
| 3 | `loop.ts` calls `converse` only, and a test asserts `streamConverse` throws if reached. Unchanged by this branch |
| 4 | `READ_TOOLS` is 19, asserted at `packages/driver/src/driver.test.ts:22`, and `DEFERRED_TOOLS` still names `page_content`. `PromptContext.screenContext` is optional and no call site sets it |
| 5 | `ToolAccess` and `ToolTier` are declared in `packages/driver/src/types.ts` and set on all 19 definitions. Nothing reads them and no admin surface exists |
| 6 | `askDriver`'s `catch` calls `fallback(why)` with no `before`, because `runTurn` throws rather than returning what it had |
| 7 | `grep -n "app.delete('/projects/:projectId/driver/threads" apps/api/src/index.ts` matches only the `/shares/:userId` route, at 1145 |
| 8 | `grep -rn "TEST_DATABASE_URL" .github/` returns nothing. `@engine/api`'s own run reports `17 skipped (41)` files and `207 skipped (559)` tests without the variable, and `41 passed` / `559 passed` with it |
| 9 | `grep -n "app.delete('/accounts" apps/api/src/index.ts` returns nothing. The only account writes are `POST /accounts`, `PATCH /accounts/:accountId` (new here) and `PATCH /accounts/:accountId/branding` |

### What changed in this audit

**`accounts.kind` became writable, and that is what unlocks the client layer.** `PATCH
/accounts/:accountId` is guarded by owner **or** platform admin; a member gets 403 and a
non-member 404, matching `requirePlatformAdmin` rather than confirming the account exists.
Leaving `agency` is refused with 409 while the caller belongs to more than one account —
downgrading does not delete clients, it hides the only screen that reaches them, and the type
control itself sits behind the same gate. `listAccountsForUser` now returns the caller's `role`
so Settings can render the control read-only instead of offering a change the API would refuse.

**Three panels went back to Settings, and Integrations became one thing.** "Where fixes go" and
report branding (agency-only) were moved to Integrations in `91b77a2` on the argument that a
GitHub PR target needs the GitHub connection granted there. That confused a library of
third-party connections with settings about this account. Integrations now holds the connections
and a banner naming the vendors whose Engine app is unregistered, instead of making a customer
open eight tiles to discover the same blocker eight times.

**One tile no longer shows three contradictory states.** "Setup required" was a static badge
built from `entry.setupSteps`, rendering beside "NOT CONNECTED" and "Connected under \<other
client\>". It now reads "Needs \<vendor\> setup", which is what it always meant: a standing
prerequisite at the provider, true whether or not you are connected.

**The stray-workspace bug had a specific cause.** Onboarding's `chosenAccount()` fell back to
`accounts[0]` for a company or an individual, and `listAccountsForUser` orders newest first — so
"add a site" filed it under whichever workspace was created last rather than the one in use, and
created a duplicate whenever the list was empty because the load had failed. Every kind now reads
an explicit workspace select, and "whose site it is" only appears when creating one.

**The vocabulary guard needed a documented exception, not a reword.** `vocabulary.test.ts`
forbids "client" outside agency-only copy. Settings' account-type control is the one screen where
a non-agency must read the word, because the option has to say what an agency *is* to someone who
is not one yet. Added as `ACCOUNT_TYPE_CHOICE` with that reasoning, rather than writing around
the rule.

### What this build leaves behind

**The type setter is ungated by billing, deliberately.** Decided 2026-09-11: build the shape now,
wire the gate in the billing wave. Stripe scaffolding already exists — `upsertSubscription`,
`PlanTier`, `STRIPE_PRICE_TO_TIER` — so the eventual shape is owner presses upgrade → checkout →
webhook sets `kind`, with the direct setter reserved for platform admins. Today an owner can
become an agency for free.

**Nothing verifies the moves in a browser.** `turbo typecheck test` is green at 65/65 and the API
is 559/559 with a database, but Settings' new sections and the Integrations banner were not
walked. The Playwright harness exists and was not run for this branch.

**Stored and replayed are deliberately different.** Everything a turn produced is persisted for
§4.4's audit; only the question and the final answer are replayed to the model. Tool results are
§4.7 untrusted content, and replaying them re-injects one poisoned page into every later turn of
the thread. `MAX_REPLAYED_MESSAGES = 20` is a round number, not a measurement — the probe
measured one turn, not a thread.

**The `seq` race is prevented by an ordering, not by a constraint.** The `last_message_at` update
takes the thread's row lock before the `max(seq)` read. That is commented at the line; moving the
update to the end of the transaction would reintroduce it silently.

**A partial answer still costs an extra model round**, and a turn that hits the deadline still
returns no text and falls back to the deterministic Copilot. Step 5 still has to decide what a
deadline looks like on screen.

## Waiting on something outside the code

| Item | Waiting on |
|---|---|
| Moving the test site to TartanHQ and dropping the empty workspace | The user, with SQL. Production is not reachable from the build environment, and row 9 means the product cannot do it either |
| Engine's Google app registration | The user, partly done. `apps/api/.dev.vars` carries the client id, secret and redirect URI, so a local deployment can run the connect flow. Whether production's `platform_credentials` row is set was not measured from here |
| `GITHUB_WEBHOOK_SECRET` and the App's webhook URL | Registering Engine's GitHub App, which is only worth doing when a customer wants PR-based deploys. Unset is safe: the endpoint fails closed and the nightly pass finds merges |
| A live Google connection on production | A customer completing the connect flow. All six Google tools report `not-connected` with the specific next step |
| The Workers plan, if row 3's measurement says streaming needs Paid | The user. Not a decision yet — the measurement comes first |

## Deferred, with the trigger that reopens it

From `2026-09-10-action-plan.md` unless noted. These are decisions, not backlog.

| Item | Trigger |
|---|---|
| Gating the account type on payment | The billing wave. Decided 2026-09-11 to build the setter ungated first |
| Billing, plan limits, upgrade screen | Before the first paying customer |
| Bing sync | Customer demand. The honesty line is already on the tile |
| MCP (roadmap M3.6) | After the product works well |
| ClickHouse | `gsc_query_daily` ≈ 50M rows, or Pulse rollup p95 > 500 ms |
| Alerts and notifications | Its own feature, with push and in-app |
| `getAccessToken` per-connection lock | The first provider that rotates refresh tokens. Harmless for Google |
| Driver calling deploy or rollback | After the Tier 2 confirmation component has been in front of real customers. §9a decision 3 |
| `page_content` as a tool | Driver step 9. The poisoned-crawled-page test gates it. §9a decision 7 |
| A router that narrows the catalogue before the model sees it | The probe measured the 20 tools at **2,974 tokens, 43% of the request**. Reopens if rounds start missing the wall-clock budget |
| Replaying tool results into later turns | Never, unless a measured need appears. The security and cost arguments are in `loadHistory` |
| Trimming a thread by tokens rather than by message count | A thread that hits `MAX_REPLAYED_MESSAGES` often enough that twenty is felt as a limit |
| A single-call fallback for tools | Never. Parallel calls are confirmed |
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
connection guide on the docs site (#132), Driver **steps 1, 2, 3, 4 and 6** — the connector's tool
calling (#130), the vendor probe and the nineteen-tool read catalogue (#131), the agent loop with
`/driver/ask` (#133), conversation persistence with thread sharing (#134) — and, on this branch,
the writable account type with Settings and Integrations each holding one job.
