# Pending items

**This file is rewritten, never appended.** It is the single current answer to "what is left".
`working_log.md` is the history; this is the state. If the two disagree, this file is wrong and
should be corrected from the source.

Last updated: 2026-09-11, against `feat/driver-screen`, rebased on `origin/main` at `4da992f`
(#135 merged), plus this branch's work. Every row below was
re-measured against the tree.

Sequence and reasoning: `docs/reviews/2026-09-11-remaining-build-plan.md` and, for Driver,
`docs/reviews/2026-09-10-driver-scoping.md` §7 and §9a, with
`docs/reviews/2026-09-11-driver-vendor-probe.md` for the loop's bounds. Read the linked detail
before starting an item — it is more precise than the one-liners here.

---

## Open

| # | Item | Size | State | Detail | Blocked by |
|---|---|---|---|---|---|
| 1 | **Driver step 5b — the screen.** `#/driver` as a seventh rail destination, a thread list, the transcript rendering typed parts, and the sharing controls the step 4 routes already serve. The protocol is built and the server returns `parts` on both `/driver/ask` and `GET /threads/:threadId`; nothing renders them. **Blocked in one concrete way:** `request<T>` in `apps/dashboard/src/api.ts` hard-codes an 8-second abort against the loop's 45-second budget, so the Driver call needs its own fetch, the way `streamAi` already does. | L | next | driver scoping §4.5, §4.9 | — |
| 2 | **The per-surface model picker, with step 5b.** Decided 2026-09-11: it lands when the Driver screen does, so the two shipped call sites change once against a surface that has three consumers rather than twice. `contextTokens` and `llmModelsWithContext` are built and `createConversationalLlmConnector` filters on them; `GET /ai/models` still serves the list whole and `modelPicker.ts` still assumes one choice. | M | next | driver scoping §9a decision 5 | step 5b |
| 3 | **Measure the final round's CPU on a real Worker, then decide streaming.** Decided 2026-09-11: measure before committing either way. The probe's 5.96 ms for SSE parsing against 0.018 ms for the same turn as a JSON body was a laptop number, and the account's budget is 10 ms on Workers Free. Steps 4 and 5 are built non-streaming regardless; `RoundRecord` already carries what a streamed variant needs, so it stays a wrapper. | S | open | probe §2 and §5 | a production deploy of the loop |
| 4 | **Driver steps 7–11.** Tier 1 write tools, Tier 2 write tools with the confirmation component, injection controls hardened against a deliberately poisoned crawled page, `page_content`, the bar on other screens with screen context, and the evaluation harness. `buildSystemPrompt` already accepts `screenContext`; nothing passes it yet. | L | open | driver scoping §7 + §9a | step 5b |
| 5 | **Org-level tool governance — full build, its own PR after step 8.** Decided 2026-09-11. Governance over a read-only catalogue is close to a no-op, and the read-against-write split only means something once Tier 1 and Tier 2 write tools exist to block. Needs an enabled/disabled state per account, a Settings admin panel, and the narrowing itself, which has a seam already: `RunTurnOptions.tools` accepts a narrowed catalogue. | M | open | §9a decision 2 | step 8 |
| 6 | **A vendor failure mid-turn loses the tool calls that already ran.** `runTurn` throws, and the partial transcript goes with it, so `askDriver`'s catch has nothing to store beyond the question and the fallback answer. Two rounds of real tool calls can vanish from an audit trail that step 4 otherwise makes complete. Fix is a typed error carrying the transcript. | S | open | `packages/driver/src/loop.ts`, `apps/api/src/driver/ask.ts` | — |
| 7 | **A thread cannot be deleted.** Step 4 ships list, read, rename, visibility and sharing, and no delete. A customer who starts a thread by accident is stuck with it. Left out deliberately rather than missed: what deleting a shared thread does to its readers is a step 5b question. | S | open | — | step 5b |
| 8 | **CI runs no database test at all.** `TEST_DATABASE_URL` is never set in `.github/workflows/ci.yml`, so every `*.db.test.ts` hits its `describe.skipIf` and reports green — **17 files and 207 tests in `@engine/api` alone**. This build made the cost concrete: the local docker Postgres was a migration behind `main`, 34 tests failed on a missing `driver_threads`, and nothing in CI would ever have said so. Fix is a Postgres service container in the test job plus `pnpm db:migrate` against it. | M | open | `.github/workflows/ci.yml:31` | — |
| 9 | **An account cannot be deleted or merged.** Onboarding could create a workspace as a side effect of a radio button, and the product has no way to remove the result: no `DELETE /accounts/:accountId`, and no way to move a project between accounts. The cause is fixed on this branch, so no *new* stray workspaces appear, but existing ones are reachable only from SQL. | S | open | `grep -n "app.delete('/accounts" apps/api/src/index.ts` returns nothing | — |

### What each row was measured against

Recorded so the next audit re-measures rather than trusting this line.

| Row | Measurement |
|---|---|
| 1 | `grep -rni "driver" apps/dashboard/src` returns nothing at all. `/driver/ask` now returns `parts`; `api.ts:270` is the 8-second `setTimeout` against `DEFAULT_BOUNDS.wallClockMs` of 45,000 |
| 2 | `modelPicker` has two call sites, `copilot.ts:135` and `offsite.ts:425`. `index.ts` serves `LLM_MODEL_CHOICES` whole, with no per-surface filter. Unchanged by this branch |
| 3 | `loop.ts` calls `converse` only, and a test asserts `streamConverse` throws if reached. Unchanged by this branch |
| 4 | No write tool exists: `READ_TOOLS` is 19, every entry `tier: 0, access: 'read'` (19 of each), and `DEFERRED_TOOLS` still names `page_content`. `screenContext` has no caller outside `ask.ts` and `prompt.ts` |
| 5 | `ToolAccess` and `ToolTier` are declared in `packages/driver/src/types.ts` and set on all 19 definitions. Nothing reads them and no admin surface exists |
| 6 | `askDriver`'s `catch` calls `fallback(why)` with no `before`, because `runTurn` throws rather than returning what it had |
| 7 | `grep -c "app.delete('/projects/:projectId/driver/threads/:threadId'" apps/api/src/index.ts` is 0; only the `/shares/:userId` route exists |
| 8 | `grep -rn "TEST_DATABASE_URL" .github/` returns nothing. `@engine/api`'s own run reports `17 skipped (41)` files and `207 skipped (559)` tests without the variable, and `41 passed` / `559 passed` with it |
| 9 | `grep -n "app.delete('/accounts" apps/api/src/index.ts` returns nothing. The only account writes are `POST /accounts`, `PATCH /accounts/:accountId` (new here) and `PATCH /accounts/:accountId/branding` |

### What changed in this audit

**Driver step 5a is done: the response-part protocol.** `packages/driver/src/parts.ts` declares
the `ResponsePart` union and builds parts from a tool result; `apps/api/src/driver/parts.ts`
holds all nineteen render shapes in one file, guarded at module load by
`assertRenderCoversCatalogue`. Both `/driver/ask` and `GET /threads/:threadId` return `parts`.

**Step 5 is split.** 5a is the protocol and touched no dashboard file; 5b is the screen. The
split was also conflict avoidance, and it worked: #135 landed the account-type work in the four
dashboard files 5b needs while 5a was in flight, and the only rebase conflicts were this file
and the log.

**Row 1's blocker is now specific rather than general.** `request<T>` aborts at 8 seconds and a
Driver turn is budgeted at 45. A measured number against a measured number, and it decides how
5b makes the call.

**#135's changes are not restated here.** The account-type setter, the Settings and Integrations
moves and the stray-workspace fix landed on main while this branch was open. Their detail is in
`working_log.md`, their row 9 is above, and the caveats they left are kept below.

### What this build leaves behind

**A measured `zero` is not an absence, and the first version of 5a treated them alike.** A
non-`ok` result emitted one notice and dropped every figure, so `site_health` on a site scoring
73 with no open findings threw the score away to report an emptiness that was not there.
`not-connected` and `no-data-yet` now render a notice alone; `zero` renders the notice and its
figures. A test caught it, not a review.

**Six render paths were wrong before the test existed.** Three were caught by reading the
handlers; three more only fell out when the specs ran against live data — a collection named
`sources` that is really `channels`, and two snake_case columns the handler had already folded
to camelCase. The dotted-path design is why they were possible and the seeded test is why none
survive: it drives all nineteen tools to `ok` and fails on any path resolving to `undefined`.

**Parts are derived, never stored.** A stored thread rebuilds them by parsing the envelopes
already in `driver_messages`, so a change to a render shape improves every answer ever given
rather than only the next one. The cost is a parser that must stay in step with its encoder;
they live in one file with a round-trip test.

**Prose comes first and the evidence under it, always.** The model emits no part markers, so
interleaving a table into a sentence is not available at any price. If that reads badly, the fix
is in 5b's layout, not in the protocol.

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
| `action` and `citation` response parts | Step 8 for `action`, which is the Tier 2 confirmation component. `citation` when something produces one. §4.5 lists eight kinds; the seven with a producer are built |
| Typing handler results so render paths are compile-checked | A seventh wrong path, or a second consumer of the same shapes. Today the seeded path test catches them and it caught six |
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
readiness step 4 is finished, and Driver has reached step 5b of eleven.** Redesign steps 1–8
(#105, #107, #108, #113–#117, #119, #120, and the `kind` gate in #124), data screens 1, 4, 5 and
7, action-plan waves 0–3, PR merge verification both ways, v1 readiness step 6 (#125), step 9's
three passes — 5a (#126), 5b (#127), 5c (#128) — brand strength on Findings (#129), the Google
connection guide on the docs site (#132), Driver **steps 1, 2, 3, 4 and 6** — the connector's tool
calling (#130), the vendor probe and the nineteen-tool read catalogue (#131), the agent loop with
`/driver/ask` (#133), conversation persistence with thread sharing (#134) — and, on this branch,
the writable account type with Settings and Integrations each holding one job.
