# Pending items

**This file is rewritten, never appended.** It is the single current answer to "what is left".
`working_log.md` is the history; this is the state. If the two disagree, this file is wrong and
should be corrected from the source.

Last updated: 2026-09-11, against `origin/main` at `5b99dde` (#124 merged) with
`feat/local-tab-gate` applied. Every row below was re-measured against the tree, not carried
forward.

Sequence and reasoning: `docs/reviews/2026-09-11-remaining-build-plan.md`. Read the linked
detail before starting an item — it is more precise than the one-liners here.

---

## Open

| # | Item | Size | State | Detail | Blocked by |
|---|---|---|---|---|---|
| 1 | **Driver vendor probe** — does Sarvam return parallel tool calls, are tool-call deltas streamable, does a worst-case turn fit a Worker invocation, what does `reasoning_effort: high` cost. | S | next | driver scoping, §7 step 1 | — |
| 2 | **Layout pass 5a — rows and stat cells.** Nine list rows onto one grammar built on `.kw-row`; the two stat rows merged; `min-height: 0` removed. | M | next | **redesign plan, step 9** | — |
| 3 | **Layout pass 5b — empty states.** Six become one. `.fq-note` is used 63 times across 17 files and prices a one-line message as a centred full-height panel. | S | open | redesign plan, step 9 | 2 |
| 4 | **Layout pass 5c — breakpoints and field widths.** Seven breakpoints become three, named; `.serp-form-row .field { flex: 1 }` goes; Competitors' cards clamped and its control row labelled consistently. | S | open | redesign plan, step 9 | 3 |
| 5 | **Entity audit on a crawl.** Three of four deterministic audits run nightly; entity has no automatic trigger. Then brand strength as a Findings group. | S | open | **v1 readiness, step 4**, first bullet | 4 |
| 6 | **Two Tier 2 leftovers.** Delete `packages/connectors/src/google/oauth.ts`, its test and its line in `google/index.ts`; schedule `reapExpiredFlows` so `oauth_flows` stops growing forever. | S | open | ship-readiness review, Tier 2 | — |
| 7 | **Driver, steps 2–11.** Connector tool calling, the agent loop, persistence (migration 0036+), the response protocol, the screen, write tools, injection controls, the bar, evaluation. | L | open | driver scoping, §7 + **§9a** | 4, and 1's findings |

Item 6 has no dependencies and fits in any branch. Items 2–4 are serial: each touches
`styles.css`, which is the repo's one-branch-at-a-time rule. Item 1 is a scratch probe and a
written result, so it can run alongside item 2.

### What each row was measured against

Recorded so the next audit re-measures rather than trusting this line.

| Row | Measurement |
|---|---|
| 2 | Row classes still present in `styles.css`: `.kw-row` (5), `.gm-row` (10), `.row` (5), `.frow` (13), `.serp-row` (4), `.ci-row` (3), `.off-row` (4), `.ci-lead-row` (4), `.oprow` (6). Both stat rows present — `.fstrip` (15), `.hm-health-row` (6). `.gm-stats .cell .top { min-height: 0 }` at `styles.css:1066` |
| 3 | `fq-note` appears 63 times across 17 non-test files under `apps/dashboard/src`. **Down one from the 64 of the last audit**, and this build is the cause: the location form's note moved to Integrations as an `.fhint` |
| 4 | Seven media breakpoints — 560, 620, 640, 720, 760, 860, 1080. The other two `max-width` values (1180, 110) are element widths. `.serp-form-row .field { flex: 1; min-width: 160px }` at `:609` |
| 5 | `NIGHTLY_AUDIT_KINDS = ['offsite', 'competitor', 'local']` (`deterministicAudits.ts:30`) — no `entity`. `runQueue.ts` names `entity-audit` nowhere. No brand-strength string anywhere in the dashboard |
| 6 | `google/oauth.ts` and its test exist; `google/index.ts:3` re-exports them and nothing consumes the result. `reapExpiredFlows` (`oauthFlows.ts:139`) still has no caller anywhere under `apps/api/src` |

## Waiting on something outside the code

| Item | Waiting on |
|---|---|
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
| Fix `.flabel.check` (`styles.css:224`) | Layout pass 5a–5c. The rule sets `flex-direction` and `gap` but `.flabel` never sets `display: flex`, so the checkbox gap has never rendered. Pre-existing; folded into the passes that rewrite the file rather than opened as its own branch |
| The crawl-coverage half of v1 readiness step 6 | Never — already shipped. `crawlCoverageLine` renders pages found, whether a sitemap was read, and how many links were followed |

## Done since the redesign began

Kept short on purpose; `working_log.md` has the detail. Redesign steps 1–8 (#105, #107, #108,
#113–#117, #119, #120, and the `kind` gate in #124, which completes step 1), data screens 1, 4,
5 and 7, action-plan waves 0–3, and PR merge verification both ways (nightly pass and webhook).
This build closes **v1 readiness step 6**: the Local tab is gated on a Business Profile
connection or typed-in location facts, and the form that supplies those facts moved to the
Business Profile panel on Integrations, where it works with no Google connection and no
registered Google app. Its other two parts — the entity dropdown and crawl coverage — were
already done and were confirmed against the tree rather than rebuilt. Step 9 of the redesign
plan (the layout passes) is the only redesign step not started.
