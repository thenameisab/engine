# Build plan for what is left

Date: 2026-09-11. Baseline: `origin/main` at `91bf455` (#120 merged). Source: the audit in §0 of
`2026-09-09-redesign-build-plan.md`, the deferrals in `2026-09-10-action-plan.md`, and the
decisions in §9a of `2026-09-10-driver-scoping.md`.

This plan covers everything outstanding across those three documents. It does not restate them;
each item names where it came from.

---

## 1. Answer first: what to do now

**You, in the next ten minutes:** the two deployment steps in §2. They are console actions on
accounts I cannot reach, and until they are done a merged pull request is verified overnight
instead of in seconds. Nothing else waits on them, so they are worth clearing before anything
starts.

**Me, first:** §3 — the two gating checks. Half a day, one PR, no new CSS. They are the last
functional gaps in the redesign, and one of them is the thing a single-site customer notices
first.

**Then, in order:** §4 the vendor probe (a day, and it can change the Driver design, so it wants
lead time), §5 the layout pass in three PRs, §6 data screen 3, then §7 Driver.

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

## 2. Yours, not code (minutes)

From #120. The webhook is built, tested and merged; it is inert until both are done.

1. `wrangler secret put GITHUB_WEBHOOK_SECRET` on the API Worker — any long random string.
2. In Engine's GitHub App settings, set the webhook URL to `<api-origin>/webhooks/github`, paste
   the same secret, and subscribe to **Pull requests**.

**Done when:** merging a pull request Engine opened moves its card to Verified within a minute,
rather than after the 03:15 pass. Until then the nightly pass covers it — slower, never wrong.
The endpoint refuses every delivery while the secret is unset, so a half-finished setup fails
closed.

---

## 3. Close the redesign's two gating gaps (S — half a day)

One PR. Neither item adds a row, a stat cell or an empty state, so neither collides with §5.

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

### 3.2 The Local tab gate

From data screen 6. The tab sits in `VISIBILITY_TABS` unconditionally and renders a Business
Profile screen to accounts with no Business Profile.

- `visibility.ts`: filter the tab on a `gbp` connection for the account, the same read the
  Integrations gallery already makes.

**Done when:** the Local tab is absent without a Business Profile connection and present with
one. **Tests:** a view test for both states.

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

## 6. Data screen 3 — brand strength without a button (S/M — a day)

From §5 of the redesign plan. The entity audit exists and works; nothing runs it. So a customer
never sees brand strength unless they find a button on a tab and press it.

After §5, so the Findings group is built on the new grammar rather than adding an eleventh row.

- `packages/crawler/src/runQueue.ts`: call `entity-audit` after a crawl finishes, in the same pass
  that already has the pages.
- `views/audit.ts`: brand strength renders as a Findings group with the four components and one
  explanation, alongside the other groups.
- Keep Visibility › Brand as the detail screen. The redesign plan said delete `entityGraph.ts`;
  that was written before Visibility had tabs, and a four-component breakdown earns a screen.

**Done when:** after a crawl, Findings shows brand strength with no button pressed. **Tests:** the
runner path with a fake API; a format test for the group.

---

## 7. Driver (L — weeks, many PRs)

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

## 8. Order, and what can overlap

```
you ─► §2 deployment (minutes, independent of everything)

me  ─► §3 gates ─► §4 probe ─► §5a ─► §5b ─► §5c ─► §6 screen 3 ─► §7 Driver 2…11
                       │                                              ▲
                       └──────── findings may amend §4.1 ──────────────┘
```

Serial, with one exception. §3 to §6 each touch `styles.css`, `shell.ts`, `format.ts` or
`api.ts`, so they follow the repo's one-branch-at-a-time rule. §4 is the exception: a scratch
probe and a written result, touching none of those, so it can run alongside §5 if you would rather
not pause the layout work for it. `working_log.md` is the only file two branches would both edit,
which is the known conflict point and cheap to resolve.

Sizes, honestly: §2 is minutes and yours. §3 is half a day. §4 is a day. §5 is three to four
days across three PRs. §6 is a day. §7 is the rest.

**If you want one thing shipped today**, it is §3 — half a day, visible on the first screen a
single-site customer opens. **If you want the biggest risk retired today**, it is §4, because it
is the only item whose result can change a design rather than an implementation.
