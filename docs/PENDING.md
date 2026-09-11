# Pending items

**This file is rewritten, never appended.** It is the single current answer to "what is left".
`working_log.md` is the history; this is the state. If the two disagree, this file is wrong and
should be corrected from the source.

Last updated: 2026-09-11, against `origin/main` at `bdb05b4` (#127 merged) with
`feat/layout-breakpoints` applied. Every row below was re-measured against the tree, not carried
forward. See "What changed in this audit".

Sequence and reasoning: `docs/reviews/2026-09-11-remaining-build-plan.md`. Read the linked
detail before starting an item — it is more precise than the one-liners here.

---

## Open

| # | Item | Size | State | Detail | Blocked by |
|---|---|---|---|---|---|
| 1 | **Brand strength as a Findings group.** The entity audit already runs on every crawl; what is missing is surfacing its strengths as a group on Findings. | S | next | v1 readiness, step 4, first bullet — **second half only** | — |
| 2 | **Two Tier 2 leftovers.** Delete `packages/connectors/src/google/oauth.ts`, its test and its line in `google/index.ts`; schedule `reapExpiredFlows` so `oauth_flows` stops growing forever. | S | open | ship-readiness review, Tier 2 | — |
| 3 | **`NIGHTLY_AUDIT_KINDS` is dead.** Declared in `deterministicAudits.ts:30` and read nowhere; `listDueAudits` hardcodes the kinds in its SQL instead. Carried from the previous audit, still true. | XS | open | — | — |
| 4 | **Three control rows are a different shape from Competitors'.** Off-site, Local and the local profile each build `.ci-controls` as one labelled control plus a bare button. Pass 5c unlabelled Competitors' four controls, so `.ci-controls` now means two things. | XS | open | found in pass 5c — `working_log.md`, 2026-09-11 | — |
| 5 | **Driver, steps 2–11.** Connector tool calling, the agent loop, persistence (migration 0036+), the response protocol, the screen, write tools, injection controls, the bar, evaluation. | L | open | driver scoping, §7 + **§9a** | the probe's findings |

**Nothing in Open touches `styles.css`,** so the one-branch-at-a-time rule binds nothing now that
the redesign is finished. Items 1–4 are independent and fit in any branch.

**The Driver vendor probe is not in Open** — it is not pending work, it is blocked on a
credential. See the table below.

### What each row was measured against

Recorded so the next audit re-measures rather than trusting this line.

| Row | Measurement |
|---|---|
| 1 | `runEntityAuditAfterCrawl` (`deterministicAudits.ts:218`) is called at `index.ts:2800` on the runner's finish route, so the trigger exists. `grep -ric "brand strength" apps/dashboard/src` returns 0 hits in every file |
| 2 | `google/oauth.ts` and `oauth.test.ts` both exist; `google/index.ts:3` re-exports them. The `exchangeCode` that `routes/integrations.ts:30` actually imports resolves to `packages/integrations/src/oauth2.ts:200`, not to this file — so the connectors copy is the dead duplicate. `reapExpiredFlows` (`oauthFlows.ts:139`) has exactly one occurrence in the tree: its own definition |
| 3 | `NIGHTLY_AUDIT_KINDS` has one occurrence across `apps` and `packages` excluding `dist`: its declaration at `deterministicAudits.ts:30`. `listDueAudits` selects `'offsite'::text as kind` and its siblings directly in SQL |
| 4 | `.ci-lbl` has four call sites. One was in `views/competitors.ts` and pass 5c removed it; the three that remain are `views/offsite.ts:654`, `views/local.ts:141` and `views/localProfile.ts:112`, each a single labelled control beside a bare button |

### What changed in this audit

The previous ledger's row 1 — layout pass 5c — is done, which finishes redesign step 9 and with
it **the redesign**. Rows 2, 3 and 4 of the previous ledger were re-measured and are unchanged,
so they move up by one. One row is new: pass 5c unlabelled the Competitors control row on the
user's instruction, and the three other `.ci-controls` rows were deliberately left alone because
each has a single control whose label is the only thing naming it. That is a real inconsistency
and is recorded rather than quietly carried.

The previous audit's correction stands: the entity audit does run on every crawl.

### What the redesign leaves behind

Step 9 is complete. Pass 5c folded seven breakpoints into three — 560, 860 and 1080 — each
declared with a comment naming what it is for, and the set is asserted in `styles.test.ts` so an
eighth cannot arrive quietly. Eight `@media` lines changed and nothing else; rules stayed where
they sit in the file, so the cascade is untouched.

Two bands changed behaviour, both collapsing about 100px earlier than before: `.lanes` goes
4 columns to 2 from 860 rather than 720, and `.intg-grid` goes 2 columns to 1 from 860 rather
than 760. Collapsing earlier is the safe direction. The one rule whose move looked risky —
`.hm-name`, whose old comment warned of a 150px name field — was measured across the 561–620
band and holds 249–300px, because `.hm-name-edit` caps it at `34ch` anyway.

Also in 5c: one field per flex row absorbs the slack (`.grow`), so the two-letter country select
went 491px to 62px; `.ci-tables` gave up `auto-fit` for two named tracks with the fifth card
spanning both, making all five the same height; `.ci-blurb` reserves two lines rather than only
clamping to them; and `.flabel.check` finally declares the `display: flex` it had been
overriding, which it had never had. The sheet is four rule blocks larger, 809 to 813.

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
| Fold `.oprow` and `.serp-row` into the row grammar | A figure appearing in either. Today `.oprow` has no numeric cell and aligns on baseline because its body is two lines of prose, and `.serp-row`'s one number leads the row inside an `<a>` |
| Retire `.loading` | A fourth state stops being a distinct fact, or its five call sites in `copilot.ts` and `serp.ts` go. A request in flight is not an empty panel |
| Fold `.gm-note` into `.notebox` | The Google panels needing a note at body size. Today it is deliberately `--t-2xs`, which the note grammar is not |
| The crawl-coverage half of v1 readiness step 6 | Never — already shipped. `crawlCoverageLine` renders pages found, whether a sitemap was read, and how many links were followed |

## Done since the redesign began

Kept short on purpose; `working_log.md` has the detail. **The redesign is finished.** Steps 1–8
(#105, #107, #108, #113–#117, #119, #120, and the `kind` gate in #124), data screens 1, 4, 5 and
7, action-plan waves 0–3, PR merge verification both ways, v1 readiness step 6 (#125), and step
9's three passes: 5a (#126), 5b (#127) and 5c (this build).

5b put the dashboard's empty states, errors and standing notes onto three named classes across 70
call sites in 20 files. 5c folded seven breakpoints into three named ones, stopped a two-letter
select being as wide as a domain field, made the five Competitors cards the same height with the
fifth spanning the empty track, and fixed `.flabel.check`, which had been styling nothing because
`.flabel` never set a `display` for it to override. Dashboard tests are 186, up from 180.
