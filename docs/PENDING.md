# Pending items

**This file is rewritten, never appended.** It is the single current answer to "what is left".
`working_log.md` is the history; this is the state. If the two disagree, this file is wrong and
should be corrected from the source.

Last updated: 2026-09-11, against `origin/main` at `c6a0730` (#122 merged).

Sequence and reasoning: `docs/reviews/2026-09-11-remaining-build-plan.md`. Read the linked
detail before starting an item — it is more precise than the one-liners here.

---

## Open

| # | Item | Size | State | Detail | Blocked by |
|---|---|---|---|---|---|
| 1 | **The `kind` gate** — a single-site company still sees a clients column, and 16 strings say "client" unconditionally. `accounts.kind` is stored and read in one place. | S | next | redesign plan, step 1, decision 3 | — |
| 2 | **Local** — gate the tab on a Business Profile connection *or* manually entered profile facts, and give the facts a form. | S/M | open | **v1 readiness, step 6** | — |
| 3 | **Driver vendor probe** — does Sarvam return parallel tool calls, are tool-call deltas streamable, does a worst-case turn fit a Worker invocation, what does `reasoning_effort: high` cost. | S | open | driver scoping, §7 step 1 | — |
| 4 | **Layout pass 5a — rows and stat cells.** Nine list rows onto one grammar built on `.kw-row`; the two stat rows merged; `min-height: 0` removed. | M | open | **redesign plan, step 9** | — |
| 5 | **Layout pass 5b — empty states.** Six become one. `.fq-note` is used 63 times across 17 files and prices a one-line message as a centred full-height panel. | S | open | redesign plan, step 9 | 4 |
| 6 | **Layout pass 5c — breakpoints and field widths.** Seven breakpoints become three, named; `.serp-form-row .field { flex: 1 }` goes; Competitors' cards clamped and its control row labelled consistently. | S | open | redesign plan, step 9 | 5 |
| 7 | **Entity audit on a crawl.** Three of four deterministic audits already run nightly; entity has no automatic trigger because `runQueue.ts` never calls it. Then brand strength as a Findings group. | S | open | **v1 readiness, step 4**, first bullet | 6 |
| 8 | **Two Tier 2 leftovers.** Delete `packages/connectors/src/google/oauth.ts` and its test (imported by nothing else); schedule `reapExpiredFlows` so `oauth_flows` stops growing forever. | S | open | ship-readiness review, Tier 2 | — |
| 9 | **Driver, steps 2–11.** Connector tool calling, the agent loop, persistence (migration 0036+), the response protocol, the screen, write tools, injection controls, the bar, evaluation. | L | open | driver scoping, §7 + **§9a** | 6, and 3's findings |

Item 8 has no dependencies and fits in any branch. Everything else is serial: each touches
`styles.css`, `shell.ts`, `format.ts`, `api.ts` or `index.ts`, which is the repo's
one-branch-at-a-time rule. Item 3 is the exception — a scratch probe and a written result — so it
can run alongside item 4.

## Waiting on something outside the code

| Item | Waiting on |
|---|---|
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

## Done since the redesign began

Kept short on purpose; `working_log.md` has the detail. Redesign steps 1–8 (#105, #107, #108,
#113–#117, #119, #120), data screens 1, 4, 5 and 7, action-plan waves 0–3, and PR merge
verification both ways (nightly pass and webhook). Step 9 is the only redesign step not started.
