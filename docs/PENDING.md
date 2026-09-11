# Pending items

**This file is rewritten, never appended.** It is the single current answer to "what is left".
`working_log.md` is the history; this is the state. If the two disagree, this file is wrong and
should be corrected from the source.

Last updated: 2026-09-11, against `origin/main` at `f2f74c9` (#125 merged) with
`feat/row-grammar` applied. Every row below was re-measured against the tree, not carried
forward.

Sequence and reasoning: `docs/reviews/2026-09-11-remaining-build-plan.md`. Read the linked
detail before starting an item — it is more precise than the one-liners here.

---

## Open

| # | Item | Size | State | Detail | Blocked by |
|---|---|---|---|---|---|
| 1 | **Layout pass 5b — empty states.** Six become one. `.fq-note` is used 63 times across 17 files and prices a one-line message as a centred full-height panel. | S | next | **redesign plan, step 9** | — |
| 2 | **Layout pass 5c — breakpoints and field widths.** Seven breakpoints become three, named; `.serp-form-row .field { flex: 1 }` goes; Competitors' cards clamped and its control row labelled consistently. | S | open | redesign plan, step 9 | 1 |
| 3 | **Entity audit on a crawl.** Three of four deterministic audits run nightly; entity has no automatic trigger. Then brand strength as a Findings group. | S | open | **v1 readiness, step 4**, first bullet | 2 |
| 4 | **Two Tier 2 leftovers.** Delete `packages/connectors/src/google/oauth.ts`, its test and its line in `google/index.ts`; schedule `reapExpiredFlows` so `oauth_flows` stops growing forever. | S | open | ship-readiness review, Tier 2 | — |
| 5 | **Driver, steps 2–11.** Connector tool calling, the agent loop, persistence (migration 0036+), the response protocol, the screen, write tools, injection controls, the bar, evaluation. | L | open | driver scoping, §7 + **§9a** | 2, and the probe's findings |

Item 4 has no dependencies and fits in any branch. Items 1–2 are serial: both touch
`styles.css`, which is the repo's one-branch-at-a-time rule.

**The Driver vendor probe has moved out of Open** — it is not pending work, it is blocked on a
credential. See the table below.

### What each row was measured against

Recorded so the next audit re-measures rather than trusting this line.

| Row | Measurement |
|---|---|
| 1 | `fq-note` appears 63 times across 17 non-test files under `apps/dashboard/src`. Unchanged by the row grammar, which moved no empty state |
| 2 | Seven media breakpoints — 560, 620, 640, 720, 760, 860, 1080. One `max-width` that is an element width remains (1180 on `.content`); the 110px one went with `.gm-bar`'s flex sizing. `.serp-form-row .field { flex: 1; min-width: 160px }` at `:639`; `.ci-blurb` at `:994` sets no clamp. This build added a second rule at 620 and removed one at 560, so the set is the same seven |
| 3 | `NIGHTLY_AUDIT_KINDS = ['offsite', 'competitor', 'local']` (`deterministicAudits.ts:30`) — no `entity`. `runQueue.ts` names `entity-audit` nowhere. No brand-strength string anywhere in the dashboard |
| 4 | `google/oauth.ts` and its test exist; `google/index.ts:3` re-exports them and nothing consumes the result. `reapExpiredFlows` (`oauthFlows.ts:139`) still has no caller anywhere under `apps/api/src` |

### What step 9 has left

Pass 5a is done. The sheet went from 827 rule blocks to 812, and the row count the plan worked
from was wrong in three ways worth not rediscovering:

- **`.row` was dead** — zero construction sites — so there were eight live row classes, not nine.
  It is now deleted. `.list`, `.dot` and `.mv` are dead alongside it and were left, since the step
  did not name them.
- **Only `.gm-row` was ragged.** The four grid rows already aligned by construction. The plan's
  own reasoning — that `.kw-row` is the right base because a fixed-track grid is the one mechanism
  that works — was right, and is now the shared rule.
- **`.oprow` and `.serp-row` are deliberately outside the grammar.** `.oprow` has no figures at all
  and aligns on the baseline; `.serp-row` puts its one number first inside an `<a>`. Both are in
  the deferred table with the trigger that would reopen them.

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
| Fix `.flabel.check` (`styles.css:224`) | Layout pass 5b–5c. The rule sets `flex-direction` and `gap` but `.flabel` never sets `display: flex`, so the checkbox gap has never rendered. Pre-existing; folded into the passes that rewrite the file rather than opened as its own branch |
| The crawl-coverage half of v1 readiness step 6 | Never — already shipped. `crawlCoverageLine` renders pages found, whether a sitemap was read, and how many links were followed |

## Done since the redesign began

Kept short on purpose; `working_log.md` has the detail. Redesign steps 1–8 (#105, #107, #108,
#113–#117, #119, #120, and the `kind` gate in #124, which completes step 1), data screens 1, 4,
5 and 7, action-plan waves 0–3, and PR merge verification both ways (nightly pass and webhook).
This build closes **v1 readiness step 6**: the Local tab is gated on a Business Profile
connection or typed-in location facts, and the form that supplies those facts moved to the
Business Profile panel on Integrations, where it works with no Google connection and no
registered Google app. Its other two parts — the entity dropdown and crawl coverage — were
already done and were confirmed against the tree rather than rebuilt. **Step 9's pass 5a** also
landed: five list rows onto one grammar, the two stat strips merged, the `min-height: 0` override
gone, and dead `.row` deleted — verified by a harness that measures every numeric column's x down
every list, which went from 5 ragged lists to 0 at 1440, 620 and 390. Passes 5b and 5c are what
remains of the redesign.
