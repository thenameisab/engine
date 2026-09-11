# Pending items

**This file is rewritten, never appended.** It is the single current answer to "what is left".
`working_log.md` is the history; this is the state. If the two disagree, this file is wrong and
should be corrected from the source.

Last updated: 2026-09-11, against `feat/brand-strength-findings` at `bf452a7`, which is
`origin/main` at `7438b1a` (#128 merged) plus this build. Every row below was re-measured
against the tree, not carried forward. See "What changed in this audit".

Sequence and reasoning: `docs/reviews/2026-09-11-remaining-build-plan.md`. Read the linked
detail before starting an item — it is more precise than the one-liners here.

---

## Open

| # | Item | Size | State | Detail | Blocked by |
|---|---|---|---|---|---|
| 1 | **The Google integration guide is captured but unwritten and uncommitted.** 14 screenshots sit untracked in `docs/guides/img/`, there is no guide document beside them, and the `working_log.md` entry describing the work is uncommitted too. | S | next | that log entry, and `docs/40-Integrations.md` step 3, which still describes Google's retired consent-screen wizard | — |
| 2 | **Driver, steps 2–11.** Connector tool calling, the agent loop, persistence (migration 0036+), the response protocol, the screen, write tools, injection controls, the bar, evaluation. | L | open | driver scoping, §7 + **§9a** | the probe's findings |

That is the whole list. The four small rows of the previous ledger are closed — three by code
in this build, one by a decision. Nothing in Open touches `styles.css`.

**The Driver vendor probe is not in Open** — it is not pending work, it is blocked on a
credential. See the table below.

### What each row was measured against

Recorded so the next audit re-measures rather than trusting this line.

| Row | Measurement |
|---|---|
| 1 | `find docs/guides -type f` returns 14 files, all of them PNGs under `img/`; there is no `.md` in the directory. `git status --short docs/guides` reports it untracked in full, and `working_log.md` has an uncommitted 12-line entry dated today describing the Cloud Console work that produced them |
| 2 | Unchanged. The probe's blocker is measured below |

### What changed in this audit

**Row 1 of the previous ledger — brand strength as a Findings group — is done**, which
finishes v1 data readiness step 4. The trigger half was already shipped; this build added the
surfacing half in `views/audit.ts` on the row grammar from pass 5a, keeping Visibility › Brand
as the per-entity detail screen rather than following the redesign plan's "remove
`entityGraph.ts`", which predates Visibility having tabs.

**Rows 2 and 3 are done.** `packages/connectors/src/google/oauth.ts` and its test are deleted
with the `export *` line that carried them, `reapExpiredFlows` runs on the nightly chain, and
`NIGHTLY_AUDIT_KINDS` is gone with the fact it carried moved onto `listDueAudits`.

**Row 4 is closed as a decision, not a change,** and one of its measurements was wrong. The
rule is now written on `.ci-controls` in `styles.css`: the class means "the row of controls
above a screen's results", and whether a control carries a visible label is a decision per
control — Competitors' four name themselves and wear `aria-label`, while Off-site's and
Local's lone selects have nothing else to name them and keep `.ci-lbl`. The correction: the
old row counted three `.ci-controls` rows in that shape and there are two. `localProfile.ts:112`
uses `.ci-lbl` inside an `.intg-section` form, not in a control row at all.

**Pass 5c's `.intg-grid` breakpoint was reverted from 860 to 560.** 5c moved it by the plan's
mechanical "nearest of the three" rule, which put a two-up grid of 380px tiles onto the
breakpoint where the *sidebar* goes — the width at which the content column gets wider, not
narrower — and so rendered one 820px tile through the 561–860 band. 560 is the phone rule,
which is what a multi-column tile grid collapsing is. Asserted in `styles.test.ts`.
`.summary-row`'s `flex-wrap` stays at 860: it wraps only when it needs to.

One new row appeared, and it is not code. A parallel session captured the Google Cloud Console
walkthrough — 14 screenshots — and left them untracked with an uncommitted log entry and no
guide written. That is recorded here rather than folded into this build's commit: committing a
log entry without the work it describes is the failure already recorded against #74.

### What this build leaves behind

Findings makes a fourth request on load, for entity strengths, alongside the three it already
made. It is best-effort like the other two optional ones: a failure drops the brand group and
leaves the findings list alone. `brandStrengthSummary([])` returns null rather than a 0% group,
because "nobody has looked" and "you have no brand" are different claims.

The weights behind the score are duplicated into `format.ts` from `@engine/entity-audit`'s
`rules.ts`, because the explanation a customer reads names them and the dashboard does not
import that package. `format.test.ts` asserts the four sum to 1 and that the sentence names
both numbers, so a change in one place without the other fails rather than going quietly wrong.

Dashboard tests are 194, up from 186. API is 438, unchanged. Connectors is 124, down from 149,
which is exactly the 25 tests of the deleted duplicate.

## Waiting on something outside the code

| Item | Waiting on |
|---|---|
| **The Driver vendor probe** (driver scoping §7 step 1) | A `SARVAM_API_KEY` that can be used locally. `apps/api/.dev.vars` exists and was written today, and its ten keys do not include it. The probe is live vendor calls — parallel tool calls, streamable tool-call deltas, worst-case turn inside a Worker invocation, the cost of `reasoning_effort: high` — so it cannot be faked. Driver steps 2–11 depend on its answers |
| Engine's Google app registration | The user, and now partly done rather than not started. `apps/api/.dev.vars` carries `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REDIRECT_URI` as of today, so a local deployment can run the connect flow. Whether production's `platform_credentials` row is set was not measured from here. Until it is, `providerPanel`'s "not set up for this workspace yet" notice is the live path on production for every Google tile |
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
| `getAccessToken` per-connection lock | The first provider that rotates refresh tokens. Harmless for Google — ship-readiness review's own judgment, and the third of that review's Tier 2 items, deliberately not done with the other two |
| Promote the Driver doc to `docs/feature-specs/D1-driver.md` | Before Driver step 2, folding §9a into §4 rather than appending |
| Gate "+ New client" inside `views/accounts.ts` | Never, unless the Clients grid becomes reachable without an agency account. #124 redirects `#/clients` to Home for every other kind, so the button is already unreachable |
| Fold `.oprow` and `.serp-row` into the row grammar | A figure appearing in either. Today `.oprow` has no numeric cell and aligns on baseline because its body is two lines of prose, and `.serp-row`'s one number leads the row inside an `<a>` |
| Retire `.loading` | A fourth state stops being a distinct fact, or its five call sites go — four in `copilot.ts`, one in `serp.ts`. A request in flight is not an empty panel |
| Fold `.gm-note` into `.notebox` | The Google panels needing a note at body size. Today it is deliberately `--t-2xs`, which the note grammar is not |
| Per-entity brand detail on Findings | Never, unless the Brand tab goes. Four averaged signals answer "which one do I go and fix"; which entity is weakest is a second question, and the group names the weakest and links to the tab that answers it |
| The crawl-coverage half of v1 readiness step 6 | Never — already shipped. `crawlCoverageLine` renders pages found, whether a sitemap was read, and how many links were followed |

## Done since the redesign began

Kept short on purpose; `working_log.md` has the detail. **The redesign is finished, and so is
v1 data readiness step 4.** Steps 1–8 (#105, #107, #108, #113–#117, #119, #120, and the `kind`
gate in #124), data screens 1, 4, 5 and 7, action-plan waves 0–3, PR merge verification both
ways, v1 readiness step 6 (#125), step 9's three passes — 5a (#126), 5b (#127), 5c (#128) —
and this build: brand strength on Findings, the `.intg-grid` breakpoint corrected, and the two
Tier 2 leftovers plus the dead `NIGHTLY_AUDIT_KINDS` closed.
