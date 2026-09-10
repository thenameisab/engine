# Redesign build plan — final

Date: 2026-09-09. Source: `docs/reviews/2026-09-09-user-journey-review.md` and the decisions written into its section 7. Baseline: `origin/main` at `16f7a5f` (PRs #80 fix-queue trust, #81 sync token, #82 GitHub App merged after the review).

## 1. Decisions this plan is built on

| # | Question | Decision | Effect on the plan |
|---|---|---|---|
| 1 | First number on Home | Home is the complete, centralised analytics view. First work out what each integration can bring in, then show it. An "Ask Engine" bar floats at the bottom; the AI behind it is plugged in later by you. | Home is built in two steps: what Engine already knows (health, findings, fixes, crawl status), then blocks fed by Search Console, Analytics, rankings and AI citations, each with a connect action when its source is missing. The bar ships as UI wired to the existing deterministic Copilot. |
| 2 | Verify | A machine step. The user can also trigger it. | The crawl runner verifies deployed fixes after a re-crawl; the card shows the result. A "Check now" button enqueues the same check on demand. The current Verify button, which always fails, is removed. |
| 3 | Client layer | Hidden. Account kinds: Company, Agency, Individual. | New `accounts.kind`. Company and Individual never see "Client", the switcher or the Clients grid; an Agency does. Get started asks the kind once. |
| 4 | Integrations | Stays top-level for now. | Six destinations: Home, Findings, Fixes, Visibility, Integrations, Settings. "Where fixes go" moves next to connected accounts on Integrations. |
| 5 | Invite users | Build it now; the surrounding journeys become fully functional later. | New invite route, invite table, set-password screen, and an invite form in the admin Platform route. Email sending is out of scope; the admin copies the link. |
| 6 | GitHub App | Asked why it is needed and whether it stays in production. | Answered in §2. It is already merged (#82) and is the production mechanism for "GitHub pull request" deploys. No further work except operator setup and the Integrations tile copy. |
| 7 | Identity | Keep app and marketing separate; the marketing page is replaced by a full website later. | Sign-in is rebuilt on the app tokens. The marketing page is not touched. |
| 8 | Data screens | Handle each one by one. | §5 gives one step per screen, in order, each with its own decision and done-when. |

## 2. Answer to question 6: why the GitHub App, and does it stay

A "GitHub pull request" deploy has to write to the customer's repository. Three ways exist. A single token held by Engine (`GITHUB_TOKEN`, the state before #82) can only reach repositories that one GitHub account can see, so it works for one customer and fails for the second. A personal access token pasted by the customer works technically, but it is a credential belonging to a person, it usually grants more than the one repository, and customers should not be asked for it. A GitHub App installation is the mechanism GitHub built for this case: Engine registers one App, each customer installs it and picks the repositories it may touch, the customer can revoke it from their GitHub settings, and Engine never stores a customer credential. Access is minted per call from Engine's App key and the customer's installation id, valid for an hour, so there is nothing to rotate.

Yes, it stays in production. It is how the GitHub deploy kind works. What it costs the operator is one registration in GitHub (an App with Contents and Pull requests write permissions), then pasting the App ID and private key into Settings → Platform; #82 accepts the PKCS#1 key file GitHub downloads without conversion. What it costs the customer is one "Install" click on the Integrations tile and choosing repositories. The deploy path still falls back to `GITHUB_TOKEN` with a logged warning, which is useful for the current single-tenant deployment and should be removed once the App is registered.

## 3. What Home can show, by source

This is the "first understand what data can be brought in" step. Each row says what is stored today, what reads it, and what Home shows from it.

| Source | Stored today | Read by anything today | Home block | Connect action when missing |
|---|---|---|---|---|
| Crawl and audit (Engine's own) | `findings`, `crawled_pages`, `audit_requests` (health score is computed per audit) | Findings screen only | **Site health**: score, pages, issue counts by severity, last audit time, crawl progress while running | "Run audit" (exists) |
| Fix Queue (Engine's own) | `actions` with diff, status, audit log | Fixes screen only | **Fixes**: counts per lane, the next two cards to approve, last deployed and verified | — |
| Google Search Console | `gsc_query_daily`, `gsc_page_daily`: clicks, impressions, CTR, position per query and page, 28-day window (`googleSync.ts:67`) | Nothing (`googleSync.ts` writes only) | **Search**: clicks and impressions over 28 days with the previous 28 for comparison, top 5 queries and top 5 pages by clicks, average position | "Connect Search Console" (Integrations tile) |
| Google Analytics 4 | `ga4_channel_daily`: sessions, engaged sessions, conversions, revenue per channel group and source | Nothing | **Traffic**: sessions by channel, and an **AI referrals** line computed from `source` matching the known AI hosts (chatgpt.com, perplexity.ai, gemini.google.com, copilot.microsoft.com, claude.ai) | "Connect Analytics" |
| Rank polling | `serp_positions` per entity keyword, engine, geo, device | Pulse score (`assembleSurfaceScores`), SERP Inspector one-off | **Rankings**: tracked keywords, average position, movers; the Organic Share of Voice cell | "Track a keyword" (built in §5 step 1) |
| AI answer sampling | `citation_events` per entity prompt and engine | Pulse score, Backlinks view | **AI answers**: share of prompts where the brand is cited, as a range; by engine | "Add prompts" (built in §5 step 4) |
| Google Business Profile | Location profile and reviews via the local audit | Local SEO view | **Local**: only when a GBP connection exists | "Connect Business Profile" |
| Bing Webmaster Tools | Nothing (verified key and an assigned site only, `registry.ts:129-131`) | — | Not on Home until a sync exists; listed under Search as "Bing: connected, data coming soon" | — |
| Cloudflare | Nothing (key and zone) | — | Not on Home; it is a deploy target and a robots/redirect surface | — |
| Unified Visibility Score | Computed from rankings and citations | Pulse | **Visibility score** with the confidence band, shown only when either source has data; otherwise one line naming what would populate it | — |

Home therefore has seven possible blocks. A new site shows two (Site health, Fixes) and five connect actions. A site with Search Console and Analytics shows four. Nothing is invented: a block with no source shows its connect action, not a zero.

## 4. Build sequence

Rules: one branch at a time off the latest `origin/main`, merged before the next starts (the shared files here are `shell.ts`, `styles.css`, `format.ts`, `api.ts`, `index.ts`, and any migration number). Each step lists what it changes, what it removes, and what must be true before it merges. Sizes: S under a day, M one to two days, L three to four days.

### Step 1 — Shell, context, and no deployment settings (M)

Goal: six destinations, one place that always says which site is open, the client layer hidden for non-agencies, and the two settings that belong to a deployment gone.

- Migration `0023_account_kind.sql`: `accounts.kind text not null default 'company'` with a check on `company | agency | individual`. Existing rows stay `company`; the three test accounts can be set by hand.
- `apps/api/src/index.ts`: `POST /accounts` accepts `kind`; `GET /accounts` returns it.
- `apps/dashboard/src/shell.ts`: routes `home`, `findings`, `fixes`, `visibility`, `integrations`, `settings`; hidden routes `report`, `get-started`, `platform`. Rail header shows the current site name and domain; if the user has more than one site, or any account is an agency, it is a switcher listing "Client · Site" rows (the `existingSites` list from `onboarding.ts:56-70` moves here). Breadcrumb "Site / Screen". Theme choice stored next to `engine.railCollapsed`. Any API response with `code: "expired"` calls `signOut()` and returns to sign-in.
- `apps/dashboard/src/views/settings.ts`: delete the "API connection" panel and its `Save` (`:238-262`, `:268`). Keep branding (agency only) and the sites list (the current `accounts.ts` grid, reached from Settings for agencies; "+ New client" is hidden for company and individual).
- `apps/dashboard/src/api.ts`: delete `BASE_KEY`, `setApiBaseUrl`; `getApiBaseUrl` reads the baked value then the loopback default only.
- `apps/dashboard/src/format.ts`: `ISSUE_LABELS` gains `poor-self-containment`; a `SCREEN_NAMES` map used by nav, crumb and h1 so each screen has one name ("Findings" not "Technical audit", "Fixes" not "Fix Queue", "Set up" not "Get started").
- `apps/dashboard/styles.css`: switcher styles; under 860 px the rail becomes a bottom bar of six icons instead of `display: none` (`:88`).
- Removes: "API base URL", "Project ID", the toast-only switch feedback, five rail items (SERP Inspector, Entity Graph, Competitors, Backlinks, Local SEO move under Visibility in step 5), "Clients" as a top-level item.
- Done when: a company user with one site sees no client vocabulary anywhere; an agency user sees the switcher and can change site without a toast being the only feedback; reloading keeps the theme; an expired token lands on sign-in; the 390 px viewport can reach every destination. Tests: `format.test.ts` for screen names and labels; a shell test for the redirect and the expired-session path.

### Step 2 — Home from what Engine already knows (M)

Goal: the first screen after sign-in shows the customer's site on the first visit and every visit after.

- `apps/api/src/repositories/auditRequests.ts` and `index.ts`: `GET /projects/:id/audit-requests/latest` returns `pagesCrawled` (count of `crawled_pages` for the running or last run) and `startedAt`.
- New `apps/dashboard/src/views/home.ts` replacing `pulse.ts`: summary line ("Site health 20 · 46 findings on 7 pages · 2 fixes ready · audited 3 minutes ago"); Site health block with the score, severity counts, and, while a crawl runs, "Crawling brightsmile.example · 12 pages so far"; Top issues (first three groups from `groupFindings`, each linking to Findings); Fixes strip (lane counts and the next two proposed cards with their "Now / After" preview from #80); a Visibility block that shows the hero score and band when `score` is non-null, and otherwise one sentence and the actions that would populate it. Polls every 20 s while a crawl runs, as Findings does.
- The Ask Engine bar: `copilot.ts` mounts a fixed bar at the bottom of `.main` with an input and the entity suggestions; ⌘K focuses it; submitting opens the existing answer panel above the bar. The classifier and `askCopilot` are unchanged; the bar is the surface you will plug AI into.
- Removes: `pulse.ts`, the empty "Unified Visibility Score" panel, the ⌘K overlay as the only Copilot surface.
- Done when: a new site's first screen is Home with a live crawl count and then findings without any navigation; a returning user sees counts and the last audit time on Home; the bar is reachable by ⌘K and by click on every screen. Tests: `format.test.ts` for the summary line and crawl status; a home view test with a fixture.

### Step 3 — Home from integrations (L)

Goal: the analytics view from decision 1.

- New `apps/api/src/repositories/analytics.ts`: `gscSummary(projectId, days)` (totals, previous period, top queries, top pages, average position), `ga4Summary(projectId, days)` (sessions by channel, engaged rate, conversions, AI-referral sessions by matching `source` against a list in `packages/core`), `rankSummary`, `citationSummary`. One route `GET /projects/:id/home` that returns every block with `source: 'connected' | 'missing' | 'no-data-yet'` so the dashboard never guesses.
- `home.ts`: Search, Traffic, AI referrals, Rankings and AI answers blocks. Each block is a panel with a headline number, a 28-day inline SVG sparkline (no chart library; the doc's motion rule says meters render at final state), and a short list. A block with `source: 'missing'` renders its connect action, which opens the matching Integrations dialog (`dialog.ts`) in place. A block with `no-data-yet` says when the first sync runs (03:15 UTC nightly, or "Sync now" on the tile).
- `googleIntegrations.ts`: after a successful connect and property assignment, trigger one sync so Home fills on the same visit instead of the next morning.
- Bing: no sync yet; the Search block lists it as connected with "data coming soon" when a key exists. Adding the Bing sync is listed in §5 after Rankings.
- Removes: nothing on screen; the Integrations tile copy loses "the traffic half of AI-referral attribution" and similar phrasing in favour of what appears on Home.
- Done when: with Search Console and Analytics connected on a real property, Home shows clicks, impressions, top queries, sessions by channel and AI referrals within one visit; with neither connected it shows two connect actions and no zeros. Tests: repository tests against the local Postgres with fixture rows; the AI-host matcher in `packages/core` unit tested.

### Step 4 — Findings, fixes, and verification (L)

Goal: from a finding to a deployed and verified fix in one place, with setup asked for at the moment of need.

- `apps/api/src/index.ts`: `POST /projects/:id/findings/propose-batch` with `{ issueType }` that proposes for every page in the group and returns actions plus skipped reasons; the propose routes return `fixable: false` with a reason for finding types whose generator needs context the crawl did not capture, so the dashboard can label them "Manual" instead of "auto-fixable".
- `apps/dashboard/src/views/audit.ts` → `findings.ts`: overview strip (health, severity counts, pages, Run audit); one explanation per issue type from a new `ISSUE_EXPLANATIONS` map in `format.ts` (what it is, why it matters, in two sentences); "Fix on all N pages" per group; page rows collapsed by default; "Manual · how to fix" for unfixable groups. On the first fix action with no deploy target, open the deploy-target form in a dialog (the form from `settings.ts:107-190` moves into a shared module); the standing banner (`audit.ts:197`) goes.
- Verification as a machine step: `packages/crawler/src/runQueue.ts` gains a second queue kind, `verify`, that fetches the deployed URLs of an action, and posts `renderedHtml` (or `robotsTxt`) to the existing `/verify` route. The API enqueues a verify request when an action reaches `deployed` on an edge-worker or CMS target, and when a GitHub PR is merged (webhook, or on the next scheduled pass by checking the PR state through the App). `fixQueue.ts`: the Deployed lane card shows "Checking the live page…", then "Verified 3 min ago" or "Not found on the page yet · Check now"; the "Check now" button calls `POST /projects/:id/actions/:actionId/verify-request`. The Verify button (`format.ts:504`) is removed.
- Migration `0024_verify_requests.sql`, or a `kind` column on `audit_requests`; the plan prefers the column so one runner drains one queue.
- `errors.ts`: `readableError` used in every view and in `shell.ts:210`; `report.ts` header button moved into the header row.
- Removes: 42 per-page buttons as the primary action, the "auto-fixable" pill on unfixable types, the Verify button, the deploy-target banner, raw status codes and JSON in toasts.
- Done when: on the test site, "Fix on all 4 pages" for Missing <title> produces four cards; the first group's action does not offer a fix it cannot generate; after Deploy on an edge target the card reaches Verified without a click once the runner passes, and "Check now" does the same on demand. Tests: `runQueue` verify path with a fake API; propose-batch route test; format tests for explanations.

### Step 5 — Set up in one field, and the account kind (S)

Goal: the shortest first form.

- `onboarding.ts`: the form is "Your website" plus a three-way choice "This site belongs to: a company · an agency's client · me" (mapping to `company`, `agency`, `individual`). Client, site and brand names come from `onboardingDefaults` and are shown as editable text on Home after the crawl starts (a small "Names" panel that saves to the account, project and entity). Agency choice reveals a client name field. Lands on Home.
- Removes: "Site name" and "Brand or business name" from the first form; the "Continue with a site you already added" panel (the switcher from step 1 covers it).
- Done when: a new user types one address, picks one of three, clicks once, and sees Home crawling. Tests: `onboardingDefaults` unchanged; a view test for the three kinds.

### Step 6 — Invite users, and the operator's one place (L)

Goal: decision 5, and the operator side of the review's target journey.

- Migration `0025_user_invites.sql`: `user_invites (token_hash, user_id, invited_by, expires_at, accepted_at)`.
- API: `POST /platform/users` (admin only, 404 to others) creates the `users` row with `platform_role`, an `account_members` row when an account is given, and an invite; returns the one-time link. `GET /auth/invite/:token` validates; `POST /auth/invite/:token/password` sets the credential through `upsertCredential` (`userCredentials.ts:52`) and consumes the invite. Also `POST /auth/reset-request` and `POST /auth/reset/:token` reusing the same table, so a forgotten password no longer needs the CLI. The password rules from `packages/db/src/cli.ts:99` (12 characters minimum for admins) move to a shared validator.
- Dashboard: `auth/authScreen.ts` gains an invite and reset screen (route from the URL hash); a "Forgot password" link on sign-in that explains the admin must send a reset link until email exists. New `views/platformRoute.ts` at `#/platform`, admin only: an ordered checklist (database and encryption key, credential sign-in, Google OAuth client, GitHub App, vendor keys, crawl runner last run and queue depth, users) each row "done" or the exact next action; the users panel gains "Invite a user" (email, role, optional account) and shows the link to copy. `platformSection` and `vendorKeysPanel` leave `settings.ts` and `integrations.ts`.
- Removes: the CLI hint on the Users panel (`platform.ts:354`), Platform and Vendor keys from Settings.
- Done when: an admin invites a user from the product, the user opens the link, sets a password, signs in, and lands on Home with the right account; a demoted or reset user can be handled without a terminal; the checklist reads the real state of the local deployment. Tests: route tests for invite and reset (expiry, single use, minimum length); the checklist's derivation from `/health/integrations` and `platform/access`.

### Step 7 — Integrations as the one customer setup place (M)

Goal: decision 4 with the deploy target beside the accounts it depends on.

- `integrations.ts`: three sections. "Where fixes go" (per site; the deploy-target form from step 4's shared module, with WordPress plugin and Cloudflare Worker first, and "GitHub pull request" showing "Install Engine on GitHub" via the #82 tile flow, or "Needs setup by your administrator" when the App is not registered). "Connected accounts" (the gallery, connectable providers first, planned providers behind one "Planned" disclosure). "Branding" for agency accounts only.
- Settings keeps: sites and clients (agency), theme, sign out, and later billing.
- Removes: the deploy target and branding panels from Settings; six "COMING SOON" tiles from the first view.
- Done when: a company user sees at most three connectable tiles and the deploy choice on one screen; an agency user additionally sees branding; nothing about setup remains on Settings except the sites list. Tests: `integrationTileState` ordering; a view test for the three account kinds.

### Step 8 — Craft pass on the shell and components (M)

Goal: the "Design engineering" table from the 2026-09-08 review, unchanged on main since then.

- `styles.css`: `:active { transform: scale(.97) }` on `.btn`, `.card-act`, `.frow-act`, `.iconbtn`, `.navitem`; `:focus-visible` ring on every control; hover rules inside `@media (hover: hover) and (pointer: fine)`; a `.skeleton` class used by Home, Findings and Fixes while loading; Ask Engine panel rise and fade at 140 ms; rail width transition at 180 ms; the `#16a34a`/`#d97706`/`#dc2626` triad (`:575-585`, `:607`, `:622`) replaced by `--good`, `--watch`, `--risk`; type sizes reduced to eight steps; uppercase tracked labels reduced to the severity chip.
- `auth/authScreen.ts` and `styles.css:425-514`: sign-in rebuilt on the tokens, theme aware, same card layout.
- `shell.ts`: toast enters on `requestAnimationFrame`, leaves on `transitionend`; `aria-current` on the active nav item; `aria-label` on icon buttons.
- Removes: the sign-in hex block, the second semantic palette, chained toast timers.
- Done when: both themes pass a visual check on every screen at 1440 and 390 px; keyboard focus is visible on every control; reduced motion shows final states. Tests: none beyond the existing suite; verification is the screenshot walk repeated.

### Step 9 — One row grammar, one stat cell, one empty state (M)

Goal: the defects step 8 did not cover. Step 8 was a component pass — press states, focus rings, hover behind a media query, the colour triad, the type scale, skeletons. Every problem below is layout, and all of them survived it.

This step was added on 2026-09-10 after walking the deployed app. Three primitives — a list row, a stat cell, an empty state — are each implemented between four and eight times, and Home uses the weakest version of all three.

**What the sheet actually holds.** Eight independent list-row implementations, four of which align their numbers and four of which do not:

| Class | `styles.css` | Mechanism | Numbers line up |
|---|---|---|---|
| `.ci-lead-row` | `:918` | grid `100px 1fr auto 52px` | yes |
| `.ci-row` | `:919` | grid `1fr auto 52px` | yes |
| `.off-row` | `:933` | grid `1fr auto 52px` | yes |
| `.kw-row` | `:1050` | grid `1fr 92px 84px auto` | yes |
| `.serp-row` | `:606` | flex, one fixed 34px cell | partly |
| `.row` | `:264` | flex, value pushed by `margin-left: auto` | no |
| `.frow` | `:331` | flex, body takes the slack | no |
| `.gm-row` | `:1022` | flex, every numeric cell `flex: none` | no |

`.ci-row` and `.off-row` are the same four declarations written twice. `.gm-row` is the one Home's Search and Traffic panels use, so "215 clicks 724 impr. 3.8 pos." shrink-wraps to its own content on every row and the three figures land at a different x position on each row. Reading down the list to compare impressions therefore requires reading each row separately.

**Six classes for one empty state**, and the one that won is named after the fix queue: `.fq-note` (`:327`) is used 53 times across 16 files, including `workspace.ts` and `deployTargetForm.ts`. `.gm-empty` (`:1036`), `.lane-empty` (`:325`), `.serp-empty` (`:586`), `.loading` and `.errbox` (`:162`) each say the same thing in a different size, register and alignment. Competitors renders six of them at once. Because `.fq-note` is `padding: 24px 16px; text-align: center`, a one-line message is priced as a full panel: Home's visibility block and Rankings' tracked-keywords panel each spend a bordered box the height of a chart to say nothing has been measured.

**Seven breakpoints, no scale:** 560, 620, 640, 720, 760, 860 and 1080 px. Each screen picked its own number. Two rows drop a column below 560 px (`.ci-lead-row`, `.off-row`); the other six squeeze instead.

- `styles.css`: one `.row` grammar built on the `.kw-row` pattern, because a grid with fixed numeric tracks is the one mechanism in the sheet that already works. Columns: body `1fr` with `min-width: 0`, then numeric tracks sized by their widest real value with `font-variant-numeric: tabular-nums`, then one action track of a single width used by Findings, Rankings and the gap tables. `.gm-row`, `.row`, `.frow`, `.serp-row`, `.ci-row` and `.off-row` become modifiers of it or are deleted. The action column is a track, not `margin-left: auto`, so a 68ch body no longer leaves 900 px of nothing between a Findings explanation and its severity pill.
- `styles.css`: `.gm-stats .cell .top { min-height: 0 }` (`:1013`) goes. The base `.cell .top` reserves `min-height: 32px` (`:253`) precisely so a label that wraps to two lines does not push its number down; the Google panels opt out of it, which is why "Engaged sessions" sits a line lower than "Sessions" and "Key events" beside it.
- `styles.css`: one empty state. A line of body text in the panel, left-aligned, no centring and no reserved height, with the panel's own padding. `.fq-note`, `.gm-empty`, `.lane-empty` and `.serp-empty` collapse into it; `.loading` goes with them once `copilot.ts` and `serp.ts` stop using it. A screen shows at most one — Competitors states it once above the dimension cards rather than once inside each.
- `styles.css`: fields size to their content. `.serp-form-row .field { flex: 1 }` (`:582`) gives a two-letter country select the same width as a domain field, about 840 px on a 1440 px screen. Selects and short fields become `flex: none` with an intrinsic width; exactly one field per row absorbs the slack.
- `styles.css`: three breakpoints, not seven — 560, 860 and 1080 — declared as a comment naming what each one is for, and every existing rule moved onto the nearest of them.
- `views/competitors.ts`: `.ci-blurb` clamped to two lines so the five dimension cards are the same height, and the fifth card spans the empty track rather than sitting alone at quarter width. The control row (`:225-227`) labels all four controls or none; today "You" and "A competitor's website" carry labels and the two buttons do not, so the row has an uneven top edge.
- `views/audit.ts`: the Findings page head becomes the overview strip the plan asked for in step 4 and did not get — health, severity counts, pages, Run audit — using `severityCounts` (`format.ts:1285`), which exists and is read only by Home. Three prose lines in three colours become one strip and one warning.
- `views/googleIntegrations.ts`: planned providers move behind one disclosure instead of sorting last in the same flat list.
- Removes: `.gm-row`'s shrink-wrapped numeric cells, the `min-height: 0` override, five of the six empty-state classes, four of the seven breakpoints, and the duplicate `.ci-row`/`.off-row` template.
- Done when: on Home, Findings, Rankings, Competitors and AI answers, every numeric column lines up down its list at 1440 and 390 px in both themes; no screen shows more than one empty state; no control is more than twice the width its longest value needs; the walk records no element whose height changes only because a neighbour's label wrapped. Tests: `styles.test.ts` gains a case that the breakpoint set is exactly the three declared values, and one that no rule outside the shared grammar sets `margin-left: auto` on a row's action; the Playwright walk from step 8's verification is the evidence, diffed against the pre-branch run so every moved pixel is deliberate.

**Order.** This step edits `styles.css` and so runs alone. It should go before steps 6 and 7, which add an operator checklist and three new Integrations sections built from exactly these primitives — doing them first means building the rows twice.

## 5. The data screens, one by one

Each is its own step after step 8, in this order, one branch at a time. Each has one decision and a done-when.

| Order | Today | Becomes | Decision taken | Work | Done when |
|---|---|---|---|---|---|
| 1 | SERP Inspector (one-off Serper lookup) | Visibility › Rankings | Keep the live lookup and add tracking: "Track this keyword" writes to `entities.keywords`; a scheduled rank poll (new cron entry calling the existing `rank/poll` per project, weekly by default) fills `serp_positions`; Home's Rankings block reads it. | `index.ts` scheduled handler; `serp.ts` gains the track button and a tracked-keywords table with position and change; `packages/core` keyword limits. | A tracked keyword shows a position on Home after the first poll, and the Organic cell of the visibility score is non-null. |
| 2 | Bing Webmaster (key only) | Feeds Visibility › Rankings and Home › Search | Add the Bing search-performance sync (query and page stats) into the same `gsc_*`-shaped tables with an `engine` column, or parallel `bing_*` tables; the plan prefers an `engine` column added by migration so Home's Search block is one query. | `packages/integrations` Bing syncer; `googleSync.ts` becomes `searchSync.ts`. | Home › Search shows Google and Bing rows for a connected site. |
| 3 | Entity Graph (manual "Run entity audit") | Findings › Brand section, and Visibility › Brand | Run the entity audit automatically at the end of every crawl in the runner; the four components render inside Findings as a group with an explanation; the standalone screen goes. | `runQueue.ts` calls `entity-audit` after `audit`; `findings.ts` renders the brand strength card; remove `entityGraph.ts`. | After a crawl, Findings shows brand strength with no button pressed. |
| 4 | Backlinks ("Backlink & mentions", no link data) | Visibility › AI answers, section "Who AI cites" | Rename to what it is. Depends on AI sampling: prompts on the entity (`entities.prompts`) and a scheduled `ai/poll`, which needs `OPENAI_API_KEY` or `GEMINI_API_KEY` on the operator checklist. Hidden until `citation_events` exist for the project; Home's AI answers block shows "Add prompts" until then. | Cron entry for `ai/poll`; a prompts editor on Visibility › AI answers; `offsite.ts` renamed and gated. | With two prompts and a key set, Home shows a cited-share range and Visibility lists the cited domains. |
| 5 | Competitors (needs two entities) | Visibility › Competitors | Add a competitor by domain (creates the entity with `kind: competitor`), analysis runs nightly when at least one exists; the empty state is one field "A competitor's website". | `competitors.ts` add-by-domain; `index.ts` scheduled analysis; migration for `entities.kind` if not already present from #80's `packages/core/src/entity.ts`. | One added domain produces gap rows the next day and a Home line "3 gaps vs competitor.example". |
| 6 | Local SEO (needs GBP) | Visibility › Local | Visible only when the account has a Google Business Profile connection; the location picker is an entity dropdown, not a UUID field (`googleIntegrations.ts:454`). | Gate in `shell.ts` route list by connection; `local.ts` dropdown. | The tab is absent without GBP and works with it. |
| 7 | Copilot (⌘K overlay) | Ask Engine bar (from step 2) | The bar is the surface; the deterministic classifier stays until you plug in a model behind `askCopilot`. The answer panel cites Findings, Rankings and AI answers rows and can propose a fix. | Motion and focus handling in step 8; no data work. | Already delivered by steps 2 and 8. |

## 6. What is not in this plan

- The model behind Ask Engine (yours, after the revamp).
- Billing, plan limits, the upgrade screen (review 2026-09-08, "Before invoicing anyone").
- The marketing page and the full website.
- MCP (roadmap M3.6).
- Email sending for invites and resets. The admin copies a link until a mail provider is chosen.
- Rank and AI polling cadence per plan tier (A1.8); the plan uses one weekly default.

## 7. Order and dependencies

```
1 Shell ──► 2 Home v1 ──► 3 Home v2 ──► 4 Findings & verify ──► 5 Set up ──► 8 Craft ──► 9 Layout ──► 6 Invite & Platform ──► 7 Integrations
                                                                                                          │
                                                                                                          └──► data screens 1 → 2 → 3 → 4 → 5 → 6
```

Steps 1 to 9 are sequential because each edits `shell.ts`, `styles.css` or `format.ts`. The data screens follow 9 and are sequential for the same reason.

Steps 8 and 9 moved ahead of 6 and 7 on 2026-09-10. The order above is what was built: 1, 2, 3, 5 and 8 merged first (PRs #105, #107, #108, #113, #114, #115, #116, #117), with step 4 already substantially in place from the pre-review work. Steps 6 and 7 add an operator checklist and three new Integrations sections, both built from the row, stat and empty-state primitives step 9 rewrites, so running 9 first means building those rows once.

Migrations are numbered in order of merge: 0023 (step 1), 0024 (step 4 if a table is chosen; otherwise none), 0025 (step 6), then one per data screen that needs it. Roadmap effect: steps 1 to 6 complete M1.6 (self-serve onboarding to first insight) and make M1.4's "verified" state real.

## 8. What to verify before each merge

The screenshot walk in `docs/reviews/assets/2026-09-09/` is the baseline. From step 8 onward the walk is scripted: Playwright driven from `packages/crawler`'s copy, a seed that stubs `window.fetch` per API path and sets the four `engine.*` keys, and a run that records for every text-bearing element its font size, weight, width and height plus document overflow, across every route in both themes at 1440 and 390 px. Diffing that run against the same run on `origin/main` is what proves a branch changed only what it meant to — #117 moved 0 of 2,588 elements. For each step: repeat the walk for the screens touched, both themes, 1440 and 390 px, from a clean worktree of the branch with the scratch Postgres migrated; run `npx turbo run test --force`; and record in `working_log.md` what changed on screen, not only in code.
