# Pending items

**This file is rewritten, never appended.** It is the single current answer to "what is left".
`working_log.md` is the history; this is the state. If the two disagree, this file is wrong and
should be corrected from the source.

Last updated: 2026-09-11, against `feat/driver-read-tools` at `1af3f82` plus this branch's work.
`origin/main` is `1af3f82` (#130 merged). Every row below was re-measured against the tree.

Sequence and reasoning: `docs/reviews/2026-09-11-remaining-build-plan.md` and, for Driver,
`docs/reviews/2026-09-10-driver-scoping.md` §7 and §9a, now joined by
`docs/reviews/2026-09-11-driver-vendor-probe.md` for the loop's bounds. Read the linked detail
before starting an item — it is more precise than the one-liners here.

---

## Open

| # | Item | Size | State | Detail | Blocked by |
|---|---|---|---|---|---|
| 1 | **Driver step 3b — the agent loop.** The read-tool half is done (this branch). What is left is the loop itself: build messages → call the model with the catalogue → execute tool calls server-side → append `tool` results → repeat → emit the answer. The probe has set all four bounds, so nothing here is still a guess. | M | next | driver scoping §4.1; probe §6 for the numbers | — |
| 2 | **Decide whether Driver streams, and on which Workers plan.** The probe's one open question. The account is on Workers **Free** (10 ms CPU); parsing one turn as SSE measured 5.96 ms against that budget, versus 0.018 ms non-streamed. Either the plan moves to Paid, or the final round is measured on a real Worker before the loop commits to streaming. The laptop measurement is not the edge and the writeup says so. | S | next | probe §2 and §5 | a decision, not code |
| 3 | **`streamConverse` discards the vendor's `usage` frame.** The probe found token counts arriving in a penultimate SSE frame with `"choices": []`, which `llmStream.ts` drops through its `if (!choice) continue` guard. The loop needs those counts for a token budget, and a second call to get them would double the cost. | S | open | probe §4 | — |
| 4 | **Driver steps 4–11.** Conversation persistence (migration 0036+, with thread visibility and a share table), the response-part protocol and the screen, Tier 1 and Tier 2 write tools, injection controls hardened, `page_content`, the bar, evaluation. Step 6 — "the remaining read tools" — is now **done ahead of schedule**; the catalogue shipped whole rather than five-at-a-time. | L | open | driver scoping §7 + §9a | steps 3b |
| 5 | **`modelPicker.ts` still assumes one model choice across every surface.** `contextTokens` is declared on the model and `llmModelsWithContext` filters on it, but the picker and the two screens that mount it (`copilot.ts:135`, `offsite.ts:425`) still offer whatever `GET`'s `models` array holds. §9a decision 5 moves the control into Settings, filtered per surface. **New scope — ask before starting.** | M | open | driver scoping §9a decision 5 | a decision |
| 6 | **Org-level tool governance, and thread sharing.** The other two §9a "new scope" items. Governance needs an enabled/disabled state on each tool definition plus a Settings surface; sharing needs thread visibility (private / named / organisation) and a share table. `ToolAccess` (`read` \| `write`) is already declared on every definition, which is the half of governance that was free. **New scope — ask before starting.** | M each | open | §9a decisions 2 and 4 | a decision |
| 7 | **The Google integration guide is written and published, and uncommitted.** A page of the public docs site — `apps/web/content/guides/connecting-google.html` plus **16** screenshots in `content/guides/img/`, rendered to `/docs/guides/connecting-google` by a new `buildGuides()` in `build-docs.mjs`. `docs/guides/` is gone: its screenshots were genericised in place and its text was not, so it was a divergent duplicate. The leak guard passes with **`BANNED` untouched** (47 insertions, 0 deletions). What is left is committing it, and deciding whether guides belong in `NAV` — they are deliberately unlisted today. **Another session owns this.** | S | in progress elsewhere | `docs/40-Integrations.md` steps 2 and 3 still describe the retired consent-screen wizard and imply all six Google APIs can be enabled | — |

**The Driver vendor probe is no longer waiting on anything** — the key landed and it ran. It has
moved out of the table below and into Done.

### What each row was measured against

Recorded so the next audit re-measures rather than trusting this line.

| Row | Measurement |
|---|---|
| 1 | `packages/driver/src/` holds `types.ts`, `catalogue.ts`, `envelope.ts`, `validate.ts`, `index.ts` and no loop. `READ_TOOLS` is 19 and `assertRegistryMatchesCatalogue()` passes, so every declared tool runs; nothing calls a model |
| 2 | `apps/api/working_log.md` and `apps/api/src/email.ts` both state the account stays on Workers Free. Probe §2 measured 5.96 ms SSE against 0.018 ms non-streamed for the same turn |
| 3 | Probe §4 captured the frame. `packages/connectors/src/llmStream.ts` still has the `if (!choice) continue` guard that drops it |
| 4 | Unchanged from §7 with §9a folded in, minus step 6. `ls infra/migrations/postgres/ \| tail -1` is `0035_account_kind.sql`, so Driver's first migration is still 0036. `grep -rn "#/driver" apps/dashboard/src` returns nothing |
| 5 | `modelPicker` has two call sites, `copilot.ts:135` and `offsite.ts:425`. `index.ts:855` serves `LLM_MODEL_CHOICES` whole, with no per-surface filter. Unchanged by this branch |
| 6 | `ToolAccess` and `ToolTier` are declared in `packages/driver/src/types.ts` and set on all 19 definitions. Nothing reads them yet and no admin surface exists |
| 7 | `docs/guides` no longer exists. `ls apps/web/content/guides/img/*.png` returns 16 and `connecting-google.html` is the page source. `git diff --stat apps/web/build-docs.mjs` is 47 insertions, 0 deletions. All of it is untracked or unstaged |

### What changed in this audit

**Driver step 1 is done.** The probe ran against the live vendor — 23 calls, all 200 — through
`SarvamConnector.converse` and `streamConverse` rather than a parallel reimplementation, so the
wire format it records is the bytes the connector sends. Three answers: parallel tool calls work
(four in one turn, streaming and not, and `ToolCallAccumulator`'s `index` assumption is
confirmed); a worst-case turn fits on subrequests (~25 of 50) but **CPU is the binding limit and
only when streaming**; and `reasoning_effort` has no measurable effect on latency — `high` was
faster than `medium` at the median, and completion tokens explain wall clock at r = 0.9996.

**Driver step 3's larger half is done, and step 6 with it.** `packages/driver` holds the semantic
layer — the catalogue, the envelope, argument validation, the result vocabulary — and
`apps/api/src/driver/` holds the handlers. All nineteen read tools work against a real Postgres.

**The catalogue is nineteen, not twenty, and that is the spec.** `page_content` is absent rather
than present-and-disabled: §9a decision 7 ships it at step 9 behind the poisoned-crawled-page
test, and a definition the loop can see is one somebody can switch on. `DEFERRED_TOOLS` names it.

**Row 2 is new and it is the probe's own open question**, raised rather than answered because the
decision belongs with the loop.

**Row 3 is new and is a defect in already-merged code**, found by the probe rather than by a test.

**Row 6 is new only as a row.** Both items were already in §9a; they are listed here because this
build declared `ToolAccess` on every tool, which is the cheap half of governance, and the
expensive half should not look done as a result.

### The architectural decision this build took

**Database access stayed in `apps/api`.** `packages/driver` declares what the tools mean and opens
no connection. Measured reason: no package in this repo touches the database — 19 of 19 before
this one, and `packages/db` is the migration runner, not a query layer. Design reason: six of the
nineteen tools answer questions `googleMetrics.ts` already answers for Pulse, and a second copy of
"what counts as a brand query", "what is within reach" and "which referrers are AI assistants"
would be exactly the fabricated metric definition §4.2 exists to prevent. Those definitions are
imported. The cost is that a definition and its query sit in two directories, and
`assertRegistryMatchesCatalogue()` runs at module load to make that split fail loudly rather than
drift. **If this is the wrong call it is a file move, not a rewrite.**

### What this build leaves behind

The handler returns provenance and `registry.ts` then *intersects* it with the tables the
definition declares, so a handler cannot claim to have read a table the catalogue never named. It
can still narrow. There is no check that a handler actually queried every table it names — that
would need query interception, and the honest position is that provenance is a declared contract
enforced at one end only.

`competitor_gaps` filters by competitor with `held_by::text ilike '%name%'` over a jsonb column.
It matches, and it would also match a competitor whose name is a substring of another's. The
column is `jsonb` with no documented inner shape, so a structural query would be guessing at it;
this is the honest version of a filter the catalogue's description already calls approximate.

The Google tools read `integration_connections` and `integration_assignments` on every call to
decide the three-state answer. That is two extra queries per tool call, and with four tool calls
in a round it is eight. It stayed because correctness of the state matters more than the round
trip at this stage, and the probe's subrequest measurement (~25 of 50) already counted it.

## Waiting on something outside the code

| Item | Waiting on |
|---|---|
| Engine's Google app registration | The user, partly done. `apps/api/.dev.vars` carries `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REDIRECT_URI`, so a local deployment can run the connect flow. Whether production's `platform_credentials` row is set was not measured from here |
| `GITHUB_WEBHOOK_SECRET` and the App's webhook URL | Registering Engine's GitHub App, which is only worth doing when a customer wants PR-based deploys. Unset is safe: the endpoint fails closed and the nightly pass finds merges |
| A live Google connection on production | A customer completing the connect flow. `gsc_*` and `ga4_channel_daily` may still be empty — which is now handled rather than merely noted: all six Google tools report `not-connected` with the specific next step, and there are tests for each branch |

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
| `page_content` as a tool | Driver step 9. The poisoned-crawled-page test gates it. §9a decision 7. `DEFERRED_TOOLS` in `packages/driver` names it so step 9 has one place to look |
| A router that narrows the catalogue before the model sees it | The probe measured the 20 tools at **2,974 tokens, 43% of the request** — three times the system prompt. §9a decision 2 said offer all of them if latency allows, and latency does allow. Reopens if rounds start missing the wall-clock budget |
| Parsing tool-call arguments in the connector | Never. `validate.ts` in `packages/driver` is the layer that knows the schema, and it now exists |
| Promote the Driver doc to `docs/feature-specs/D1-driver.md` | Still due, and now folding in the probe as well as §9a |
| Gate "+ New client" inside `views/accounts.ts` | Never, unless the Clients grid becomes reachable without an agency account |
| Fold `.oprow` and `.serp-row` into the row grammar | A figure appearing in either |
| Retire `.loading` | A fourth state stops being a distinct fact, or its five call sites go |
| Fold `.gm-note` into `.notebox` | The Google panels needing a note at body size |
| Per-entity brand detail on Findings | Never, unless the Brand tab goes |

## Done since the redesign began

Kept short on purpose; `working_log.md` has the detail. **The redesign is finished, v1 data
readiness step 4 is finished, and Driver has reached step 3.** Redesign steps 1–8 (#105, #107,
#108, #113–#117, #119, #120, and the `kind` gate in #124), data screens 1, 4, 5 and 7, action-plan
waves 0–3, PR merge verification both ways, v1 readiness step 6 (#125), step 9's three passes —
5a (#126), 5b (#127), 5c (#128) — brand strength on Findings (#129), Driver step 2, the
connector's tool calling (#130), and on this branch **Driver step 1 (the vendor probe) and the
larger half of step 3 — the nineteen-tool read catalogue, which also completes step 6.**
