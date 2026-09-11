# Pending items

**This file is rewritten, never appended.** It is the single current answer to "what is left".
`working_log.md` is the history; this is the state. If the two disagree, this file is wrong and
should be corrected from the source.

Last updated: 2026-09-11, against `origin/main` at `a65a34d` (#126 merged) with
`feat/empty-state-grammar` applied. Every row below was re-measured against the tree, not
carried forward — and doing so retired one row that had gone stale. See "What changed in this
audit".

Sequence and reasoning: `docs/reviews/2026-09-11-remaining-build-plan.md`. Read the linked
detail before starting an item — it is more precise than the one-liners here.

---

## Open

| # | Item | Size | State | Detail | Blocked by |
|---|---|---|---|---|---|
| 1 | **Layout pass 5c — breakpoints and field widths.** Seven breakpoints become three, named; `.serp-form-row .field { flex: 1 }` goes; Competitors' cards clamped and its control row labelled consistently. Also fixes `.flabel.check`. | S | next | **redesign plan, step 9** | — |
| 2 | **Brand strength as a Findings group.** The entity audit already runs on every crawl; what is missing is surfacing its strengths as a group on Findings. | S | open | v1 readiness, step 4, first bullet — **second half only** | — |
| 3 | **Two Tier 2 leftovers.** Delete `packages/connectors/src/google/oauth.ts`, its test and its line in `google/index.ts`; schedule `reapExpiredFlows` so `oauth_flows` stops growing forever. | S | open | ship-readiness review, Tier 2 | — |
| 4 | **`NIGHTLY_AUDIT_KINDS` is dead.** Declared in `deterministicAudits.ts:30` and read nowhere; `listDueAudits` hardcodes the kinds in its SQL instead. Found during this audit, not deleted — it is not this build's mess. | XS | open | — | — |
| 5 | **Driver, steps 2–11.** Connector tool calling, the agent loop, persistence (migration 0036+), the response protocol, the screen, write tools, injection controls, the bar, evaluation. | L | open | driver scoping, §7 + **§9a** | the probe's findings |

Item 1 is the only one that touches `styles.css`, so it is the only one bound by the
one-branch-at-a-time rule. Items 2, 3 and 4 are independent and fit in any branch.

**The Driver vendor probe is not in Open** — it is not pending work, it is blocked on a
credential. See the table below.

### What each row was measured against

Recorded so the next audit re-measures rather than trusting this line.

| Row | Measurement |
|---|---|
| 1 | Seven distinct `max-width` breakpoints — 560 (×9), 620 (×5), 640, 720, 760, 860 (×3), 1080. `.serp-form-row .field { flex: 1; min-width: 160px }` at `:650`; `.ci-blurb` at `:1004` sets no clamp. `.flabel` (`:598`) still sets no `display: flex`, so `.flabel.check`'s (`:235`) `flex-direction` and `gap` still render nothing. Pass 5b moved none of these |
| 2 | `runEntityAuditAfterCrawl` (`deterministicAudits.ts:218`) is called at `index.ts:2800` on the runner's finish route and records the run with `trigger: 'crawl'`. So the trigger exists. `grep -ri "brand strength" apps/dashboard/src` returns 0 |
| 3 | `google/oauth.ts` and `oauth.test.ts` both exist; `google/index.ts:3` re-exports them and nothing consumes the result. `reapExpiredFlows` (`oauthFlows.ts:139`) has one occurrence in the tree — its own definition |
| 4 | `NIGHTLY_AUDIT_KINDS` has one occurrence across `apps` and `packages` excluding `dist`: its declaration. `listDueAudits` (`:111`) selects `'offsite'::text as kind` and its siblings directly in SQL |

### What changed in this audit

Row 3 of the previous ledger said the entity audit "has no automatic trigger". That was wrong
against this tree: `runEntityAuditAfterCrawl` runs it after every crawl. The previous audit
measured the row by grepping `runQueue.ts` under `apps/api/src`, where no such file exists — it
lives at `packages/crawler/src/runQueue.ts`, and the trigger was never going to be there anyway,
because the API's finish route is what calls it. The row is now scoped to the half that is
genuinely open, and its measurement names a call site instead of an absence.

### What step 9 has left

Passes 5a and 5b are done. 5c is the last of the redesign.

Pass 5b shipped three named roles rather than the one the plan asked for, because measuring the
63 `.fq-note` uses first showed they were not one thing: 43 empty states, 21 failed requests and
19 standing explanations. `.emptybox`, `.errbox` and `.notebox` now carry those three, `.loading`
stays as the fourth state, and all four share box metrics. Three things the plan did not know:

- **`.serp-empty` was dead** — zero call sites — so it was deleted, not merged.
- **`.intg-note` was a seventh note class** whose declarations were identical to
  `.intg-body .fq-note`. It is now `.notebox.framed`.
- **`.intg-body .fq-note.warn` had never matched anything.** The warn variant is worn by
  `.intg-note`. Both `.intg-body` rules are gone.

`.gm-note` is a further note class with its own smaller type, used 5 times by the Google panels.
Step 9 did not name it, so it stays.

## Waiting on something outside the code

| Item | Waiting on |
|---|---|
| **The Driver vendor probe** (driver scoping §7 step 1) | A `SARVAM_API_KEY` that can be used locally. It is set as a Worker secret in production, but `wrangler secret list` returns names only and there is no copy in `apps/api/.dev.vars`. The probe is live vendor calls — parallel tool calls, streamable tool-call deltas, worst-case turn inside a Worker invocation, the cost of `reasoning_effort: high` — so it cannot be faked. Driver steps 2–11 depend on its answers |
| Engine's Google app registration | The user. Until it is done, `providerPanel`'s "not set up for this workspace yet" notice is the live path for every Google tile, so Connect cannot work. The location form is deliberately offered through that notice, which is the only reason Local is reachable at all today |
| `GITHUB_WEBHOOK_SECRET` and the App's webhook URL | Registering Engine's GitHub App, which is itself only worth doing when a customer wants PR-based deploys. Unset is safe: the endpoint fails closed and the nightly pass finds merges. See the build plan §2 |
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
| `getAccessToken` per-connection lock | The first provider that rotates refresh tokens. Harmless for Google — ship-readiness review's own judgment |
| Promote the Driver doc to `docs/feature-specs/D1-driver.md` | Before Driver step 2, folding §9a into §4 rather than appending |
| Gate "+ New client" inside `views/accounts.ts` | Never, unless the Clients grid becomes reachable without an agency account. #124 redirects `#/clients` to Home for every other kind, so the button is already unreachable |
| Fold `.oprow` and `.serp-row` into the row grammar | A figure appearing in either. Today `.oprow` has no numeric cell and aligns on baseline because its body is two lines of prose, and `.serp-row`'s one number leads the row inside an `<a>`. Widening the grammar to cover them would make it say nothing |
| Retire `.loading` | A fourth state stops being a distinct fact, or its five call sites in `copilot.ts` and `serp.ts` go. Pass 5b's plan assumed it would already be unused; it is not, and a request in flight is not an empty panel |
| Fold `.gm-note` into `.notebox` | The Google panels needing a note at body size. Today it is deliberately `--t-2xs`, which the note grammar is not |
| The crawl-coverage half of v1 readiness step 6 | Never — already shipped. `crawlCoverageLine` renders pages found, whether a sitemap was read, and how many links were followed |

## Done since the redesign began

Kept short on purpose; `working_log.md` has the detail. Redesign steps 1–8 (#105, #107, #108,
#113–#117, #119, #120, and the `kind` gate in #124), data screens 1, 4, 5 and 7, action-plan
waves 0–3, PR merge verification both ways, v1 readiness step 6 (#125), and step 9's passes 5a
(#126) and 5b (this build). 5b put the dashboard's empty states, errors and standing notes onto
three named classes across 70 call sites in 20 files, deleted two dead rules and one dead class,
and left the sheet three rule blocks smaller. Measured on the real stylesheet at 620px, the four
states went 80→67, 131→113, 64→48 and 64→48 pixels tall and all moved from centred to
left-aligned; a failed request is now `--risk` red instead of the same grey as an empty panel.
This audit also found that **the entity audit already runs on every crawl**, which retires the
first half of v1 readiness step 4.
