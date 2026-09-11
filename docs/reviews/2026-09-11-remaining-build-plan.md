# Build plan for what is left

Date: 2026-09-11. Baseline: `origin/main` at `91bf455` (#120 merged).

**This document is an index and a sequence, not a replacement.** Every item below is already
specified in detail somewhere else; this says what is left, in what order, and where the detail
lives. Read the linked section before starting an item — it is longer and more precise than the
summary here.

The five documents it draws on, and what each is still good for:

| Document | Still the authority on |
|---|---|
| `2026-09-08-ship-readiness-review.md` | The Tier 2 half-done builds. Three items are still open — §7 below |
| `2026-09-09-user-journey-review.md` | Why the redesign happened. A dated record; its §5.6 interface judgment is the argument behind the layout pass |
| `2026-09-09-redesign-build-plan.md` | The nine redesign steps. Its **§0** is the audited status; its **step 9** is the full layout spec |
| `2026-09-09-v1-data-readiness-plan.md` | The eight data steps. Its **step 4** and **step 6** specify two items below in more detail than this document does |
| `2026-09-10-action-plan.md` | The five waves, the deferrals and their triggers |
| `2026-09-10-driver-scoping.md` | Driver. **§7** is the build sequence, **§9a** the decisions taken |

Where this document and one of those disagree on scope, the detailed one wins and this one is
wrong — with one exception, noted per item: where something has shipped since the detailed plan
was written, so its scope has genuinely shrunk.

### Item to detail, at a glance

| Item here | Detail lives in |
|---|---|
| §2 the GitHub webhook (**not yet — see why**) | PR #120's description |
| §3.1 the `kind` gate | redesign plan, step 1, decision 3 |
| §3.2 the Local tab | **v1 data readiness, step 6** — broader than the summary here |
| §4 vendor probe | driver scoping, §7 step 1, with §2 for what Sarvam documents |
| §5 layout pass | **redesign plan, step 9** — the full spec, including the row table |
| §6 entity audit on crawl | **v1 data readiness, step 4**, first bullet only |
| §7 three Tier 2 leftovers | **ship-readiness review**, Tier 2 integrations |
| §8 Driver | driver scoping, §7 steps 2–11, scoped by §9a |

---

## 1. Answer first: what to do now

**You: nothing, yet.** The first draft of this plan opened by asking you to set
`GITHUB_WEBHOOK_SECRET` in the next ten minutes. That was a misread on my part and §2 now explains
it: the secret hangs off a GitHub App that has never been registered, and even registered it
carries nothing until a customer picks a PR deploy target. Leaving it unset is safe — the endpoint
fails closed and the nightly pass finds merges correctly.

**Me, first:** §3.1 — the `kind` gate. Half a day, no new CSS, and the thing a single-site
customer notices first. §3.2 rides with it if its form turns out small; the detailed plan it comes
from asks for more than I first scoped, so I would rather split than pad.

**Then, in order:** §4 the vendor probe (a day, and it can change the Driver design, so it wants
lead time), §5 the layout pass in three PRs, §6 the entity audit, then §8 Driver. §7 is half a day
of leftovers with no dependencies — fold it into whichever branch is convenient.

### Why not start with Driver, or with the layout pass

Driver is the benchmark feature and the thing you have been waiting to plug a model into, so
starting there is the tempting answer. Two reasons not to.

Driver is the largest new surface left — a thread list, a message list, tool-call blocks, metric
and table response parts, and at least three empty states. Every one of those is a list row, a
stat cell or an empty state, and those are exactly the three primitives the layout pass rewrites.
This already happened once: the plan warned that building steps 6 and 7 before step 9 meant
building the rows twice, we did it anyway, and #119 added a ninth row implementation and a second
stat row. Building a chat surface on the duplicated primitives repeats that at four times the
size.

And the layout pass is not the first thing either, because the vendor probe is cheap and can
invalidate design work. It answers whether parallel tool calls work, whether a full turn fits the
worker's CPU limit, and what `reasoning_effort: high` costs in seconds on a twenty-tool
catalogue. If a turn does not fit, Driver's loop changes shape. A day spent finding that out now
is worth more than a day of layout work, and it costs the layout pass nothing to wait one day.

---

## 2. The GitHub webhook — **do not do this yet**

This section said "yours, in the next ten minutes" in the first draft of this plan. That was
wrong, and the correction matters more than the task.

`GITHUB_WEBHOOK_SECRET` is production configuration, not a test fixture: it is the shared secret
GitHub signs each delivery with, and `POST /webhooks/github` verifies. Nothing about it is
development-only. But it cannot be done on its own and it is not useful yet, because of a chain
nobody has started:

1. The webhook URL is configured **in Engine's GitHub App settings**. That App has never been
   registered — the working log for #82 records the install round trip, token minting and the
   repository picker as "not verified: all need a registered GitHub App, which is the user's
   one-time task", and it is still not done.
2. With no App, there is nowhere to put the webhook URL. The secret alone does nothing.
3. Even with the App registered, the webhook only carries merges of pull requests **Engine
   opened**, which requires a customer to have installed the App and chosen "GitHub pull request"
   as their deploy target. No customer has: `integration_connections` holds no `github` row and
   `actions` holds none at all.

So the trigger is not a date, it is **registering the GitHub App** — and the secret is one step of
that setup, not a separate task before it. Registering the App is itself only worth doing when a
customer needs PR-based deploys; a WordPress or Cloudflare target needs none of it.

**Leaving it unset is safe, and the safety is deliberate.** With no secret the endpoint answers
500 and refuses every delivery rather than trusting an unsigned body, so a half-finished setup
fails closed. Merges are found by `scheduledPrMergeCheck` in the 03:15 pass — slower, never
wrong, and it needs no webhook.

**When you do register the App**, the webhook is three fields in the same form:

1. `wrangler secret put GITHUB_WEBHOOK_SECRET` on the API Worker — any long random string.
2. Webhook URL `<api-origin>/webhooks/github`, the same secret in the secret field.
3. Subscribe to **Pull requests**.

**Done when:** merging a pull request Engine opened moves its card to Verified within a minute
rather than by the next morning.

---

## 3. Close the two gating gaps (S — half a day, plus §3.2's form)

One PR. Neither item adds a row, a stat cell or an empty state, so neither collides with §5.

§3.2 grew when I read the detailed plan it comes from: it is not one line in `visibility.ts`. If
the profile-facts form pushes it past a day, split it — the `kind` gate stands alone.

### 3.1 The `kind` gate

From step 1 of the redesign plan, decision 3: "Company and Individual never see 'Client', the
switcher or the Clients grid; an Agency does." `accounts.kind` is stored as of 0035 and read in
exactly one place — the agency branding panel. Everything else is unconditional.

- `workspace.ts`: the clients column renders only when the user belongs to an agency account, or
  to more than one account. A company with one site gets the site switcher without the client
  layer above it.
- `shell.ts`: the `clients` route redirects to Home when no account is an agency, the same shape
  as `platform`'s non-admin redirect.
- The sixteen "client" strings across the views take their noun from the kind. A company picks a
  *site*, not a client; an individual picks nothing because there is one.
- `accounts.ts` (the Clients grid): "+ New client" hidden for company and individual.

**Done when:** a company account with one site sees the word "client" nowhere in the product, and
an agency account sees it everywhere it does today. **Tests:** `format.test.ts` for the noun
chosen per kind; a `styles.test.ts`-style scan asserting no view hardcodes "client" outside the
agency path.

### 3.2 Local — **read v1 data readiness step 6 first**

That step is broader than "gate the tab", and two of its three parts are still open. Its own
wording: "the location picker becomes an entity dropdown rather than a UUID field, and the profile
facts get a form so a customer without a Google Business Profile connection can still fill them.
The screen is hidden until either exists."

So the gate is not `gbp` alone — it is **`gbp` or manually entered profile facts**, which is why
the form comes with it. Gating on the connection only would hide the screen from the customer the
form is for.

- `visibility.ts`: the Local tab renders when the account has a `gbp` connection **or** the entity
  has profile facts.
- `local.ts`: a form for the profile facts — the NAP fields the local audit already scores.
- The entity dropdown instead of a UUID field: the ship-readiness review raised this too ("Needs
  an entity dropdown, not a UUID field"). Check first — the line it cites,
  `googleIntegrations.ts:454`, no longer has a `locationId` field, so this may already be fixed by
  the resource-picker work; confirm before scoping it.

**Shrunk since that plan was written:** its crawl-coverage half is done — `crawlCoverageLine`
renders pages found, whether a sitemap was read and how many links were followed, under the
Findings strip.

**Done when:** Local is absent for an account with neither a connection nor profile facts, and
working with either. **Tests:** a view test for all three states.

---

## 4. The Driver vendor probe (S — a day)

Step 1 of the Driver document's §7, and it says: "Step 1 is not optional. Three architectural
choices depend on answers nobody has yet." Its only dependency — `feat/measurement-methodology` —
landed as #111 on 2026-09-10, so it has been unblocked for a day.

Not a feature branch. A scratch script against the real Sarvam endpoint, and a written result.
What it has to establish, from §7 and §2:

- Does `sarvam-105b` accept `tools` and return tool calls, and are **parallel** tool calls
  returned? Sarvam documents `tools`, `tool_choice` and the `tool` role, and documents neither
  parallel calls nor streaming of tool-call deltas.
- Are tool-call deltas streamable, or must a turn that calls a tool be non-streaming? This decides
  whether the first token a customer sees can arrive before the tools run.
- What does a worst-case turn cost — a system prompt plus a twenty-tool catalogue plus three tool
  results — in seconds, in tokens, and against the Worker's CPU and subrequest limits?
- What does `reasoning_effort: high` add in seconds at that catalogue size?

**Done when:** the four answers are in `docs/reviews/` and §4.1 of the Driver document is either
confirmed or amended against them. If a full turn does not fit a Worker invocation, that is the
finding, and the loop moves to the crawl runner or a queue — which is a design change worth
knowing about before §5, not after.

**Note the ordering trap:** this must not become "start Driver". Steps 2 onward wait for §5.

---

## 5. The layout pass — redesign step 9 (L — three to four days)

The one step of the redesign that never started, and the whole answer to what is left in the UI.
It runs alone because it rewrites `styles.css`, which every other branch also touches.

Split into three PRs rather than one. Each is separately reviewable, each keeps the product
working, and each is verified by the scripted walk diffed against the run before it — the same
evidence #117 used when it moved 0 of 2,588 elements.

### 5a — One row grammar (M)

Nine list-row implementations: five are grids and line their numbers up by construction, four are
flex and do not. Build one grammar on the `.kw-row` pattern — a grid with fixed numeric tracks is
the mechanism that already works, so this is consolidation onto the best existing row rather than
a new invention.

- Body `1fr` with `min-width: 0`; numeric tracks sized to their widest real value with
  `font-variant-numeric: tabular-nums`; one action track of a single width.
- `.gm-row`, `.row`, `.frow`, `.serp-row`, `.ci-row`, `.off-row`, `.ci-lead-row` and `.oprow`
  become modifiers of it or are deleted. `.kw-row` becomes the base.
- The action column is a track, not `margin-left: auto`, so a 68ch Findings explanation no longer
  leaves 900px between itself and its severity pill.
- Also: the two stat rows. `.fstrip` and `.hm-health-row` are the same row of numbers written
  twice; one of them wins. `.gm-stats .cell .top { min-height: 0 }` goes, so "Engaged sessions"
  stops sitting a line below "Sessions" beside it.

**Done when:** on Home, Findings, Rankings, Competitors, AI answers and Platform, every numeric
column lines up down its list at 1440 and 390 in both themes, and the walk records no element
whose height changed only because a neighbour's label wrapped.

### 5b — One empty state (S)

Six classes say the same thing in six registers, and the one that won is named after the fix
queue: `.fq-note` is used 63 times across 17 files. Because it is `padding: 24px 16px;
text-align: center`, a one-line message is priced as a full panel — Home's visibility block and
Rankings' tracked-keywords panel each spend a bordered box the height of a chart to say nothing
has been measured.

- One empty state: a line of body text in the panel, left-aligned, no centring, no reserved
  height, the panel's own padding.
- `.fq-note`, `.gm-empty`, `.lane-empty` and `.serp-empty` collapse into it. `.loading` goes once
  `copilot.ts` and `serp.ts` stop using it.
- A screen shows at most one. Competitors states it once above the dimension cards rather than
  once inside each of six.

**Done when:** no screen shows more than one empty state, and none reserves a panel's height to
say one sentence.

### 5c — Breakpoints, field widths, and Competitors (S)

- Seven breakpoints become three — 560, 860, 1080 — each declared with a comment naming what it
  is for, and every existing rule moved onto the nearest.
- `.serp-form-row .field { flex: 1 }` goes. Selects and short fields take an intrinsic width;
  exactly one field per row absorbs the slack. A two-letter country select is currently as wide
  as a domain field.
- `.ci-blurb` clamped to two lines so the five dimension cards are the same height, and the fifth
  spans the empty track instead of sitting alone at quarter width.
- The Competitors control row labels all four controls or none; today two carry labels and two do
  not, so the row has an uneven top edge.

**Done when:** the breakpoint set is exactly the three declared values, and no control is more
than twice the width its longest value needs.

**Tests across all three:** `styles.test.ts` gains a case that the breakpoint set is exactly the
three values, and one that no rule outside the shared grammar sets `margin-left: auto` on a row's
action. The walk diff is the evidence; every moved pixel should be deliberate and named in
`working_log.md`.

---

## 6. The entity audit on a crawl — **v1 data readiness step 4, first bullet only** (S — a day)

Step 4 of that plan is "run the deterministic audits without a button", covering four audits:
entity, off-site, competitor, local. **Three of the four are done.**
`NIGHTLY_AUDIT_KINDS` is `['offsite', 'competitor', 'local']` and the 03:15 pass drains them, with
a last-ran line on each screen (`auditLastRunLine`, 13 call sites). Entity is deliberately
excluded from that list, because the plan says the crawl is the right trigger for it — and
`runQueue.ts` never makes the call. So the entity audit is the one audit with no automatic trigger
at all, and a customer sees brand strength only by finding a button on a tab and pressing it.

What is left is that one bullet, verbatim from step 4: "`packages/crawler/src/runQueue.ts`: after
a crawl finishes, call the entity audit for the project. The crawl is the moment the facts
changed, so it is the right trigger."

Scheduled after §5 because the redesign plan's data screen 3 also asks for brand strength as a
Findings group, and a group is rows — build it on the new grammar rather than adding a tenth.

- `runQueue.ts`: call the entity audit after a crawl, in the pass that already holds the pages.
- `views/audit.ts`: brand strength as a Findings group with the four components and one
  explanation.
- **One deliberate departure from the redesign plan**, which said "remove `entityGraph.ts`": keep
  Visibility › Brand as the detail screen. That instruction was written before Visibility had
  tabs; a four-component breakdown earns a screen, and the tab now exists.

**Done when:** after one crawl, brand strength appears with no button pressed. **Tests:** the
runner path with a fake API; a format test for the group.

---

## 7. Three Tier 2 leftovers from the 2026-09-08 review (S — half a day)

That review's Tier 2 list is mostly closed — the branded report, GSC and GA4 on Home, rank
tracking, AI polling, Backlinks renamed, competitors by domain and the planned-provider badge all
shipped. Its "Recommended order" paragraph named four small items; three are still true, and I
confirmed each against the tree rather than trusting the review's line numbers.

1. **Delete the dead OAuth duplicate.** `packages/connectors/src/google/oauth.ts` is a second,
   weaker OAuth implementation — no PKCE, no timeout, no redirect protection — and `grep` finds
   `buildConsentUrl` and `exchangeCode` imported by nothing but `oauth.test.ts`. It is not
   exported from the package index. Delete both files. The risk is not that it runs; it is that
   someone finds it and uses it.
2. **Schedule `reapExpiredFlows`.** Defined at `oauthFlows.ts:139` and called from nowhere, so
   `oauth_flows` grows forever. One line in `scheduled()`, beside the other nightly passes.
3. **`getAccessToken` has no per-connection lock.** The review's own judgment stands: harmless for
   Google, which does not rotate refresh tokens, and a bug the day a provider that does ships.
   **Leave it, with the trigger written down** — add the lock when the first rotating provider is
   added, not before.

Items 1 and 2 are a half-day together and independent of everything else; fold them into whichever
branch is convenient. Item 3 is a decision to defer, not work.

**Done when:** the dead file is gone with its test, `oauth_flows` is reaped nightly, and the
deferral of item 3 is recorded next to `getAccessToken`.

---

## 8. Driver (L — weeks, many PRs)

Steps 2 to 11 of the Driver document's §7, unchanged in order, plus the three scope additions
§9a introduced. Starts after §5.

Read §9a before estimating. The three additions are not refinements:

| Addition | Where it lands | Why it is not small |
|---|---|---|
| Org-wide tool governance | §4.2, §4.3, Settings | Every tool needs an enabled state and a read-or-write class an admin can set, plus a surface to set it and a check in the loop |
| Thread sharing | §4.4 | Private by default with named or org-wide sharing needs a visibility state and a share table, not the boolean §4.4 sketches, plus a read check on every thread route |
| Per-surface model filter | §4.9, `modelPicker.ts` | A model declares its context size once and every surface filters on it. This changes a shipped surface, not only Driver |

Two housekeeping items before step 2:

- **Promote the document** to `docs/feature-specs/D1-driver.md`, folding §9a into §4 rather than
  leaving it appended. The document says this is due; it has not been done.
- **Migration numbering:** 0036 or later, and past the highest across every open branch, not just
  `main`. The document's original "0034 or later" is twice stale.

---

## 9. Order, and what can overlap

```
you ─► nothing. §2 waits on registering the GitHub App, which waits on a customer
       who needs PR deploys. Unset is safe: the endpoint fails closed.

me  ─► §3 gates ─► §4 probe ─► §5a ─► §5b ─► §5c ─► §6 entity audit ─► §8 Driver 2…11
                       │                                                   ▲
                       └──────── findings may amend Driver §4.1 ───────────┘

           §7 Tier 2 leftovers — half a day, no dependencies, fold in anywhere
```

Serial, with two exceptions. §3, §5 and §6 each touch `styles.css`, `shell.ts`, `format.ts` or
`api.ts`, so they follow the repo's one-branch-at-a-time rule. §4 is a scratch probe and a written
result, touching none of those, so it can run alongside §5 if you would rather not pause the
layout work for a day. §7 is two small deletions and one scheduled call, independent of
everything. `working_log.md` is the only file two branches would both edit, which is the known
conflict point and cheap to resolve.

Sizes, honestly: §2 is not yet due. §3 is half a day, more if §3.2's form is real work. §4
is a day. §5 is three to four days across three PRs. §6 is a day. §7 is half a day. §8 is the
rest.

**If you want one thing shipped today**, it is **§3.1 alone** — the `kind` gate, half a day, and
visible on the first screen a single-site customer opens. §3.2 grew once I read the plan it comes
from, so do not assume the pair still fits in a day. **If you want the biggest risk retired
today**, it is §4: the only remaining item whose result can change a design rather than an
implementation.
