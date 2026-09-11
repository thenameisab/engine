# Pending items

**This file is rewritten, never appended.** It is the single current answer to "what is left".
`working_log.md` is the history; this is the state. If the two disagree, this file is wrong and
should be corrected from the source.

Last updated: 2026-09-11, against `feat/driver-screen-ui`, branched from `origin/main` at
`c8ee5d3` (#137 merged), plus this branch's work. Every row below was re-measured against the
tree with a command; none was carried forward on its previous wording.

Sequence and reasoning: `docs/reviews/2026-09-11-remaining-build-plan.md` and, for Driver,
`docs/reviews/2026-09-10-driver-scoping.md` §7 and §9a, with
`docs/reviews/2026-09-11-driver-vendor-probe.md` for the loop's bounds. Read the linked detail
before starting an item — it is more precise than the one-liners here.

---

## Open

| # | Item | Size | State | Detail | Blocked by |
|---|---|---|---|---|---|
| 1 | **Driver steps 7 and 8 — the write tools.** Tier 1 internal reversible actions that run without asking and are logged, then Tier 2 actions with the confirmation component, which §4.7 counts as a security control and not only a usability one. No write tool exists yet: all 19 catalogue entries are `tier: 0, access: 'read'`. `RunTurnOptions.tools` already accepts a narrowed catalogue, and `ToolTier`/`ToolAccess` are declared and read by nothing. | L | next | driver scoping §4.3, §7 | — |
| 2 | **Driver step 9 — injection controls, then `page_content`.** Hardened and tested against a deliberately poisoned crawled page, and the test is what gates the tool. `DEFERRED_TOOLS` still names `page_content`; shipping it is what completes §4.7's lethal trifecta, so the controls come first and the order is not negotiable. | M | open | §9a decision 7, §10 | step 8 |
| 3 | **Driver step 10 — the bar on other screens, with screen context.** `askBar.ts` was built as a component for exactly this and is mounted on Home only; `buildSystemPrompt` accepts a `screenContext` and the only caller passes none. A question asked from Findings should carry which findings are on screen. Under 860px there is deliberately no bar: the rail is already a fixed bottom bar and Ask is a destination in it. | S | open | §4.9 | — |
| 4 | **Driver step 11 — the evaluation harness.** Fifty questions with answers computed directly from the database, a grounding check that every numeral in the prose appears in a tool result, refusal quality, an injection suite, latency per model, and a tenancy test. §10 says this is part of the build, not a later phase, and it is the only row here that tells us whether any of the rest works. | M | open | §10 | — |
| 5 | **Org-level tool governance — full build, its own PR after step 8.** Decided 2026-09-11. Governance over a read-only catalogue is close to a no-op, and the read-against-write split only means something once Tier 1 and Tier 2 write tools exist to block. Needs an enabled/disabled state per account, a Settings admin panel, and the narrowing itself. | M | open | §9a decision 2 | step 8 |
| 6 | **Measure the final round's CPU on a real Worker, then decide streaming.** The probe's 5.96 ms for SSE parsing against 0.018 ms for the same turn as a JSON body was a laptop number, and the account's budget is 10 ms on Workers Free. 5b is built non-streaming and says so on screen ("this can take up to 45 seconds"); `RoundRecord` already carries what a streamed variant needs. `loop.ts` calls `converse` only, and a test asserts `streamConverse` throws if reached. | S | open | probe §2 and §5 | a production deploy of the loop |
| 7 | **A re-opened thread cannot show that a turn ran out of time.** New, from this build. The deadline notice needs `source`, and `driver_messages` stores no such column — `0036` has none — so `messagesWithParts` can rebuild the parts of an old answer but not the fact that the deterministic engine wrote it. A customer re-reading yesterday's conversation sees a narrower answer with no explanation, which is exactly what the notice exists to prevent. Fix is a nullable `source` on the message row: migration `0037`, the next free number. | S | open | `apps/dashboard/src/views/driver.ts`, `answerBlock`'s comment | — |
| 8 | **Nothing ever sets a thread's title.** New, from this build. `PATCH /threads/:threadId` accepts one and `askDriver` writes none, so every thread is untitled. `threadTitle` falls back to the first question when the caller has it and to the date otherwise — and the list route returns no question, so the sidebar reads "Conversation of 2026-09-11" for every row. Either the list carries the first message, or the first turn stores a title. | S | open | `format.ts` `threadTitle`, `listReadableThreads` | — |
| 9 | **A thread cannot be deleted.** Step 4 shipped list, read, rename, visibility and sharing, and no delete; `grep -c "app.delete('/projects/:projectId/driver/threads/:threadId'," apps/api/src/index.ts` is 0. A customer who starts a thread by accident is stuck with it. No longer blocked — 5b answered the question that held it, which was what deleting a shared thread does to its readers: the same thing unsharing does, and the sharing panel now says who those readers are. | S | open | — | — |
| 10 | **A vendor failure mid-turn loses the tool calls that already ran.** `runTurn` throws, and the partial transcript goes with it, so `askDriver`'s catch at line 292 calls `fallback(why)` with no `before` and no `gathered`. Two rounds of real tool calls can vanish from an audit trail that step 4 otherwise makes complete — and, since 5b, the customer loses the figures too. The deadline path already keeps both; only the thrown path does not. Fix is a typed error carrying the transcript. | S | open | `packages/driver/src/loop.ts`, `apps/api/src/driver/ask.ts:292` | — |
| 11 | **CI runs no database test at all.** `grep -rn "TEST_DATABASE_URL" .github/` returns nothing, so every `*.db.test.ts` hits its `describe.skipIf` and reports green — measured this build at **17 files and 215 tests skipped of 570** in `@engine/api`, against 41 files and 570 passing with the variable set. This build added 6 of those 215. Fix is a Postgres service container in the test job plus `pnpm db:migrate` against it. | M | open | `.github/workflows/ci.yml` | — |
| 12 | **A Driver fix card is a summary, not the Fix Queue card.** New, from this build. §4.5 asks for the Fix Queue's own card, and the `fix_queue` tool returns `{id, type, status, target, answersIssue, severity, entity, proposedAt, lastChangedAt}` with **no diff** — and the diff is that card's whole middle. So Driver renders what the tool returned and links to Fixes for the change. Closing it properly means the tool returning the before/after, which changes what the model sees and the seeded path test. A test pins Driver to not growing a diff renderer of its own in the meantime. | S | open | `apps/api/src/driver/site.ts` `fixQueue`, `driverParts.ts` `fixesPart` | — |
| 13 | **An account cannot be deleted or merged.** No `DELETE /accounts/:accountId` — the only `app.delete('/accounts…` route is the invitations one — and no way to move a project between accounts. Onboarding's stray-workspace cause was fixed in #135, so no *new* ones appear; the existing ones are reachable only from SQL. | S | open | `grep -n "app.delete('/accounts" apps/api/src/index.ts` returns only `/invitations/:invitationId` | — |

### What each row was measured against

Recorded so the next audit re-measures rather than trusting this line.

| Row | Measurement |
|---|---|
| 1 | `catalogue.ts` declares 19 tools; `tier: 0` appears 19 times and `access: 'read'` 19 times. Nothing reads either field |
| 2 | `DEFERRED_TOOLS` still names `page_content`, one occurrence |
| 3 | `grep -rn screenContext` outside tests hits `prompt.ts` (the declaration and its use), `ask.ts` (the pass-through), and one comment in `askBar.ts`. No caller supplies a value |
| 4 | No eval harness file exists anywhere under `packages/driver` or `apps/api` |
| 5 | `ToolAccess` and `ToolTier` are declared in `packages/driver/src/types.ts` and set on all 19 definitions. No admin surface exists |
| 6 | `loop.ts` mentions `streamConverse` once, in the test's assertion; the loop itself calls `converse` at line 232 |
| 7 | `grep -n source infra/migrations/postgres/0036_driver_conversations.sql` returns nothing. Highest migration on disk is `0036`, so the next is `0037` |
| 8 | `grep -rn title apps/api/src/driver/ask.ts` returns nothing |
| 9 | `grep -c "app.delete('/projects/:projectId/driver/threads/:threadId'," apps/api/src/index.ts` is 0; only the `/shares/:userId` route exists |
| 10 | `ask.ts:292` is `return fallback(why);` inside the catch — no `before`, no `rounds`, no `gathered`, all three of which the deadline path at line 261 passes |
| 11 | `@engine/api`'s own run reports `17 skipped (41)` files and `215 skipped (570)` tests without the variable, and `41 passed` / `570 passed` with it |
| 12 | `fixQueue` in `apps/api/src/driver/site.ts` maps nine fields and none of them is a diff |
| 13 | The one matching route is `app.delete('/accounts/:accountId/invitations/:invitationId'` at index.ts:3570 |

### What changed in this audit

**Driver step 5b is done, and with it the whole of step 5.** The screen exists: `#/driver` as a
rail destination, a thread list, a transcript rendering all seven part kinds, and the sharing
controls the step 4 routes had been serving to nobody. Before this build
`grep -rni driver apps/dashboard/src` returned nothing at all.

**The per-surface model picker landed with it**, as ledger row 2 said it would. `GET /ai/models`
sends a `surfaces` map built from each surface's declared context requirement; Settings owns the
default per surface and the panels keep an overridable select. Driver is offered one model today
because one clears 128K, and the screen names it rather than showing a select with one option.

**Three rows are new and all three came out of building the screen.** Row 7 (a re-opened thread
cannot say a turn timed out), row 8 (nothing titles a thread), row 12 (the fix card has no diff
because the tool returns none). Each is a gap the routes had that only a consumer could expose.

**Row 9 is unblocked rather than resolved.** Thread deletion was held on "what does deleting a
shared thread do to its readers", which was a step 5b question; 5b answered it by giving the
author a panel that names those readers.

**Row 11 got worse by six tests**, which is the honest direction to report it: this build added
6 database tests to the 209 CI already never runs.

### What this build leaves behind

**A browser walk found three defects no test would have.** The floating bar centred on the
viewport rather than the content column — **112 px off, exactly half the rail** — because
`position: fixed` makes the viewport the containing block. `.content` reserved no room for the
bar, so Home's last panel scrolled under it and could not be read at any scroll position. And
the composer's opening note stayed above the first exchange, explaining what to ask to someone
who had just asked. `#135` shipped without a walk and `#137` was the bill; this is what the walk
is for.

**The ⌘K ask bar is gone, and the engine under it is not.** The overlay posted to `/ai/stream` in
'ask' mode while Driver runs the agent loop, so the product had two places to type a question
that answered differently and no signposting between them. `packages/copilot` is untouched and is
still §4.8's fallback — it is reached through Driver now rather than beside it. A test asserts no
screen calls `mode: 'ask'` again.

**A finding is now built in one place and a fix is not.** `findingGroup.ts` was extracted from
`views/audit.ts` so §4.5's rule is a property rather than a promise, with a test naming the two
files that legitimately build a `.fgroup` that is not a finding — brand strength, which is a
measure and not an issue, and the loading skeleton. The fix card could not get the same treatment
and row 12 says why.

**The browser session carries no user id.** `SessionUser` is a name, an address and a provider,
so "did I write this thread" cannot be answered by comparing ids. The screen reads it from what
the route chose to send: `shares` comes back to the author and is withheld from everyone else, so
an array — empty or not — is the server saying the thread is yours. The share picker filters the
member list by email for the same reason. Adding an id to the session would be cleaner and would
touch every sign-in path that writes one.

**"Keep going" replays an answer the model did not write.** A deadline turn stores the
deterministic engine's prose as that turn's answer, and `loadHistory` replays question-and-answer
pairs — so continuing asks the model to follow on from something it did not say. It was chosen
over a fresh start deliberately: the alternative throws away the tool calls the first attempt
made. Worth revisiting once row 7 stores `source`, which would let the replay skip a fallback
answer.

**Nothing verifies the sharing panel against a real second user.** The routes are tested against
Postgres and the panel was driven with a stubbed member list; two people in one account sharing a
thread has not been walked. The Playwright harness cannot do it without two sessions.

## Waiting on something outside the code

| Item | Waiting on |
|---|---|
| Moving the test site to TartanHQ and dropping the empty workspace | The user, with SQL. Production is not reachable from the build environment, and row 13 means the product cannot do it either |
| Engine's Google app registration | The user, partly done. `apps/api/.dev.vars` carries the client id, secret and redirect URI, so a local deployment can run the connect flow. Whether production's `platform_credentials` row is set was not measured from here |
| `GITHUB_WEBHOOK_SECRET` and the App's webhook URL | Registering Engine's GitHub App, which is only worth doing when a customer wants PR-based deploys. Unset is safe: the endpoint fails closed and the nightly pass finds merges |
| A live Google connection on production | A customer completing the connect flow. All six Google tools report `not-connected` with the specific next step, and Driver now renders that as its own notice with an Open Integrations button |
| The Workers plan, if row 6's measurement says streaming needs Paid | The user. Not a decision yet — the measurement comes first |

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
| A router that narrows the catalogue before the model sees it | The probe measured the 20 tools at **2,974 tokens, 43% of the request**. Reopens if rounds start missing the wall-clock budget |
| Replaying tool results into later turns | Never, unless a measured need appears. The security and cost arguments are in `loadHistory` |
| `action` and `citation` response parts | Step 8 for `action`, which is the Tier 2 confirmation component. `citation` when something produces one. §4.5 lists eight kinds; the seven with a producer are built and all seven now render |
| Typing handler results so render paths are compile-checked | A seventh wrong path, or a second consumer of the same shapes. Today the seeded path test catches them and it caught six |
| Trimming a thread by tokens rather than by message count | A thread that hits `MAX_REPLAYED_MESSAGES` often enough that twenty is felt as a limit |
| A single-call fallback for tools | Never. Parallel calls are confirmed |
| Parsing tool-call arguments in the connector | Never. `validate.ts` in `packages/driver` is the layer that knows the schema |
| Promote the Driver doc to `docs/feature-specs/D1-driver.md` | Still due, now folding in §9a, the probe, step 4's sharing model, and 5b's four decisions |
| A user id on `SessionUser` | A second screen needing to know who the viewer is. Driver reads it from what the route sends instead |
| Markdown rendering for a Driver answer's prose | Never, unless the model is given part markers. Parsing its prose would let `**` and `|` become structure the grounding contract never approved |
| Gate "+ New client" inside `views/accounts.ts` | Never, unless the Clients grid becomes reachable without an agency account |
| Fold `.oprow` and `.serp-row` into the row grammar | A figure appearing in either |
| Retire `.loading` | A fourth state stops being a distinct fact, or its five call sites go |
| Fold `.gm-note` into `.notebox` | The Google panels needing a note at body size |
| Per-entity brand detail on Findings | Never, unless the Brand tab goes |

## Done since the redesign began

Kept short on purpose; `working_log.md` has the detail. **The redesign is finished, v1 data
readiness step 4 is finished, and Driver has reached step 7 of eleven.** Redesign steps 1–8
(#105, #107, #108, #113–#117, #119, #120, and the `kind` gate in #124), data screens 1, 4, 5 and
7, action-plan waves 0–3, PR merge verification both ways, v1 readiness step 6 (#125), step 9's
three passes — 5a (#126), 5b (#127), 5c (#128) — brand strength on Findings (#129), the Google
connection guide on the docs site (#132), the writable account type with Settings and
Integrations each holding one job (#135), the Integrations banner fix (#137), and Driver
**steps 1–6** — the connector's tool calling (#130), the vendor probe and the nineteen-tool read
catalogue (#131), the agent loop with `/driver/ask` (#133), conversation persistence with thread
sharing (#134), the response-part protocol (#136) — and, on this branch, **step 5b**: the Ask
screen, the command palette, the floating bar, and the per-surface model picker.
