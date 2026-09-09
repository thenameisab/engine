# User-journey review — before the redesign

Date: 2026-09-09. Product reviewed: `origin/main` at `b12f8bb` (week 1 of the ship-readiness review merged, PR #79 as the last merge). Screenshots in both themes are under `docs/reviews/assets/2026-09-09/` (72 files, numbered in walk order; `40–42` are the admin path).

**Follow-up:** decisions on the eight open questions are recorded inline in section 7 (`>>` notes), and the resulting plan is `docs/reviews/2026-09-09-redesign-build-plan.md`.

## How this was reviewed

- The main checkout was being edited live by another session (uncommitted changes in `apps/api`, `apps/dashboard` and `packages/actions`, and an unapplied migration 0022), and its API failed to start. So the walk used a clean `git worktree` of `origin/main`, built with `ENGINE_API_BASE=http://localhost:8790`, served on port 4322, with the API on 8790 and the scratch Postgres on 5433 (21 migrations). Every file and line cited below is from `origin/main`, not from the working tree.
- Signed in as `tester@example.com`. Walked the four journeys in the browser pane. For journey (a) I created a new client and site ("Bright Smile Dental", `brightsmile.example`), repointed the queued crawl at the local docs site, and ran `packages/crawler/dist/queueRunner.js` by hand because the GitHub dispatch does not exist locally. The crawl took about 6 seconds for 7 pages.
- For the operator path I set `platform_role='admin'` on the tester, captured Settings and Integrations, then reverted the row. Nothing in product code was changed. `.claude/launch.json` was edited to add two temporary launch configs and reverted at the end.
- Not verified this session: production timing of a crawl (docs say 2–15 minutes), the Zapier, Linear, Ahrefs and Semrush comparisons (from product knowledge, not a live walk), and anything behind a Google connection, because no OAuth client is registered.

---

## 1. Verdict

Engine now has a working loop, but a customer sees it only after visiting six screens and touching four setup panels, and the home screen stays empty even after the loop has run. The first thing of value, a list of findings on a real site, appears on the third screen and only after a crawl the customer cannot watch; Pulse, where the customer lands on every later visit, ignores the audit and the Fix Queue and says "No visibility data yet" for a site with 46 findings and a deployed fix. Setup is spread over seven customer-facing places and seven operator places, four of them outside the product, and two of the customer ones ("API base URL", "Project ID") should not exist. The interface is clean, consistent with its own tokens, and honest in every empty state, but it reads as a generic admin template: one panel per page, a rail of eleven nouns, no persistent sign of which client or site is selected, no skeletons, no press states, and the one signature element (the confidence band) is on a screen that is always empty. The redesign should collapse the shell to five destinations with a visible context switcher, make the home screen read from what the product already knows, put every customer setup in one place and every operator setup in another, and delete the settings that belong to a deployment rather than a customer.

---

## 2. Journey maps

Columns: **Screen** is the route and title as shown. **Decision** is what the user must choose. **Words** are quoted from the screen. **Cost** is clicks or typing plus wait. **Predictable** is whether the user could have known what the action would do. **Value visible** is whether anything about their site is on screen yet.

### (a) First-time customer: sign-in to first deployed fix

Assumes the operator has already created the user with `pnpm db:user` and sent the password, and the customer has no client or site.

| # | Screen | Decision | Words on screen | Cost | Predictable | Value visible |
|---|---|---|---|---|---|---|
| 1 | `#/` Sign in (`01-signin`) | Enter email and password | "Sign in" · "Your AI & search visibility — and the fixes that move it." · "Invite-only access" | 2 fields, 1 click | Yes | No |
| 2 | `#/get-started` "Set up a site" (`04-get-started`) | Who the client is, the site address; two optional names | "Engine works on one website at a time. Say whose site it is and where it lives; you can add more later from Clients." · fields "Client", "Web address", "Site name", "Brand or business name" · "Set up this site" | 1 select, 2 fields, 1 click | Partly. The user cannot know a crawl will start; only the toast says "First audit queued." (`onboarding.ts:163`) | No |
| 3 | `#/audit` "Technical audit" (`09-audit-empty`) | None. Wait. | "No audit has run for this project yet." · "Audit queued. It usually starts within a few minutes." · "Set a deploy target in Settings to turn auto-fixable findings into proposed fixes." · "Run an audit to see what to fix. Findings appear here when it finishes." | Wait 2–15 min in production (`docs/46-Audit-Runner.md`); the view polls every 20 s (`audit.ts:106`) | No. Three messages compete; one asks for Settings before any finding exists | No |
| 4 | `#/audit` after crawl (`18-audit-acme`) | Which finding to fix | "Health score 20 across 7 pages · 42 of 46 findings map to a one-click fix." · 10 groups, e.g. "Page says too little about your brand", "poor-self-containment" (raw slug) · 42 "Propose fix" buttons, all disabled | Scroll; 0 clicks possible | No. Buttons look enabled (accent text at 45% opacity) but do nothing; the reason is a hover title, `audit.ts:20` | **Yes, first insight.** Screen 3 of the journey. |
| 5 | `#/settings` (`26-settings-acme`) | Which deploy kind; fill its fields | "Point the dashboard at your Engine API, and set where approved fixes deploy." · "API base URL" · "Project ID" · "Where approved fixes deploy" · options "GitHub PR", "Cloudflare edge worker", "CMS plugin (WordPress/Shopify)" · "Save deploy target" | 1 nav, 1 select, 1–3 fields, 1 click | Partly. "Worker name" has no explanation; nothing says what Engine will do with it | No |
| 6 | `#/audit` again | Which row to propose | Same as 4, buttons now live | 1 nav, scroll, 1 click per page per issue | No. The first button clicked (HIGH, "auto-fixable") returned the toast "no action could be generated — the fix needs context this crawl did not capture" | Yes |
| 7 | `#/audit` second try | Try another issue | "Missing <title>" → toast "Proposed 1 fix → Fix Queue" | 1 click | Yes | Yes |
| 8 | `#/fix-queue` (`17-fix-queue-acme`) | Approve or not | Card: "META" · "Regenerate title · brightsmile-edge" · "+3 impact" · "edge" · "Approve" | 1 nav, 1 click → toast "Meta → Approved" | No. The card never shows the proposed title. Postgres holds `after: "Bright Smile Dental"` for the `/roadmap` page. The title names the worker, not the page | Partly |
| 9 | `#/fix-queue` | Deploy | "Deploy" → toast "Meta → Deployed" | 1 click | Partly. For an edge target "deploy" only flips status (`apps/api/src/index.ts:1404`) | **First deployed fix.** Screen 6, about 19 interactions, one dead end. |
| 10 | `#/fix-queue` | Verify | "Verify" → toast `Meta → Verified failed: 409 {"error":"verification failed: deployed content does not match the proposed diff"}` | 1 click | No. The route needs `renderedHtml` (`index.ts:1523`) that the dashboard never sends; the button cannot succeed | Ends on an error |

Setup touched: Get started, Settings → Deploy target. Setup shown but not needed: Settings → API connection, Settings → Branding, Integrations. Screens before first insight: 3. Screens before first deployed fix: 6.

### (b) Returning customer: what changed this week

Assumes Acme Dental is selected from the last visit and an audit ran.

| # | Screen | Decision | Words on screen | Cost | Predictable | Value visible |
|---|---|---|---|---|---|---|
| 1 | Sign in | — | As above. With an expired token the app does not return to sign-in; Pulse rendered `Could not load Pulse: 401 {"error":"session expired","code":"expired"}` (observed on first load; `api.ts:166`, `pulse.ts:84`) | 3 | No | No |
| 2 | `#/pulse` (`15-pulse-acme`) | Where to look | "Pulse" · "This project has no polled data yet." · "Unified Visibility Score" · "No visibility data yet. The score appears once search rankings and AI answers have been sampled for this project's keywords and prompts." | 0 | No. Nothing on this screen links to Audit or Fix Queue. The route reads only rank and citation tables (`index.ts:978-996`) | No |
| 3 | `#/audit` | — | "Health score 20 across 7 pages" · current findings only | 1 nav | Partly | Current state, no change. There is no crawl diff (B1.7 in the PRD) and no date of the last audit on screen |
| 4 | `#/fix-queue` | — | Lanes "Proposed 2", "Approved 1", "Deployed 0", "Verified 0" | 1 nav | Partly | Current state, no dates, no "since your last visit" |
| 5 | `#/report` via Clients (`28-report-acme`) | — | "Acme Dental — AI Visibility Report" · "UNIFIED SCORE not measured yet · TECHNICAL HEALTH 20 · KEYWORDS TRACKED 0 · CITATION SAMPLES 0" | 2 nav | Yes | Same numbers, three zeros |

Answer to "what changed this week": the product cannot say. Nothing stores or shows a delta, no digest exists (PRD H3), and the home screen stays empty.

### (c) Agency user with three clients

| # | Screen | Decision | Words on screen | Cost | Predictable | Value visible |
|---|---|---|---|---|---|---|
| 1 | Any screen | Which client am I looking at? | Topbar shows only the route name, e.g. "Pulse" (`shell.ts:171,204`). Rail shows the user, not the client. | 0 | No. There is no indicator of the selected client or site anywhere in the shell | — |
| 2 | `#/clients` (`27-clients-acme`) | Which project row | Cards "Runner Test Co", "Northwind Clinic", "Acme Dental", each "1 project", a domain row, "View branded report →", "Edit branding →", "+ Project" | 1 nav | Yes | Client list only |
| 3 | Row click → `#/pulse` | — | Toast "Switched to northwind.example" for 2.6 s, then nothing | 1 click | Partly. After the toast fades the screen cannot tell the user which site it shows | Pulse is empty for every client |
| 4 | `#/integrations` (`23-integrations-acme`) | — | Same eleven tiles for every client; the account changed silently with the project | 1 nav | No. The user did not choose an account; it followed the project (`accounts.ts:28-29`) | — |
| 5 | `#/settings` | — | "Deploy target · none set" for the new client; "Branding · account c1220728…" | 1 nav | No. Deploy target is per site, branding per client, both under one "Settings" | — |

Switching costs 2 clicks and 1 screen. Confirming what is selected costs a trip to Clients. Get started's "Continue with a site you already added" is a second switcher (`onboarding.ts:61`) reachable only when nothing is selected.

### (d) Operator setting up a fresh deployment for the first customer

Inside the product only screens 7–9 exist. Steps 1–6 are from `docs/45-Roles-And-Access.md`, `docs/46-Audit-Runner.md`, `apps/api/wrangler.toml` and the memory notes; not re-executed here.

| # | Place | Decision | Words | Cost | Predictable | Value visible |
|---|---|---|---|---|---|---|
| 1 | Terminal | Create the first admin | `DATABASE_URL='…' pnpm db:user --email you@example.com --role admin` | 1 command, password prompt | Only with the doc open | — |
| 2 | Cloudflare dashboard or `wrangler secret put` | Set Worker secrets | `DATABASE_URL`, `LOCAL_AUTH_SECRET`, `LOCAL_AUTH_USERS`, `ENCRYPTION_KEY`, `OAUTH_STATE_SECRET`, `INTERNAL_API_TOKEN`, `GITHUB_DISPATCH_TOKEN`, `SERPER_API_KEY`, `OPENAI_API_KEY` | 9 secrets | No | — |
| 3 | GitHub repository settings | Set repo secrets and variable | `DATABASE_URL`, `ENGINE_API_TOKEN`, `ENGINE_API_BASE` | 3 | No | — |
| 4 | Cloudflare Pages | Turn off automatic git builds | (memory: `engine-pages-publish-race`) | 1 setting | No | — |
| 5 | Google Cloud Console | Create an OAuth client, add the redirect URI | Copy from Settings → Platform → "Redirect URI" | About 10 minutes | Only with the doc | — |
| 6 | Terminal | Create the customer's user | `pnpm db:user --email customer@… --role user`, then send the password out of band | 1 command | No. There is no invite in the product | — |
| 7 | `#/settings` → "Platform" (`40-admin-settings`) | Paste client id and secret | "Google OAuth client" · "Not configured — customers cannot connect Google" · "Client ID", "Client secret", "Redirect URI" · "Save client" · "Users · 1 admin" · "New sign-in accounts are created with `pnpm db:user --email <address> --role admin\|user`." | 2 fields, 1 click | Yes, once found. It sits below four customer panels on the same page | — |
| 8 | `#/settings` → "Vendor keys" | Read only | "Keys this deployment holds" · "3 Wired · 1 Partial · 5 Not wired" · "Missing: SERPER_API_KEY" and so on | 0 | Yes | — |
| 9 | `#/integrations` (`42-admin-integrations-google-dialog`) | — | Tile "NEEDS SETUP" · "Sign-in with Google is not set up for this workspace yet. Register Engine's Google app once under Settings, and every client can connect from here." · "Finish Google setup" | 1 click, lands on Settings | Yes | — |

Operator setup places: 7, of which 4 are outside the product. The product tells the operator what is missing (screen 8) but not in what order, and cannot create a user.

### Counts

| Measure | Observed |
|---|---|
| Customer-facing setup places | 7: Get started; Clients (+ New client, + Project, both open Get started); Settings → API connection; Settings → Deploy target; Settings → Branding; Settings → Connected accounts (a link); Integrations |
| Operator setup places | 7: Settings → Platform (Google OAuth client, Users); Settings → Vendor keys (read only); CLI `pnpm db:user`; Worker secrets; repository secrets; Cloudflare Pages setting; Google Cloud Console |
| Screens before first insight (journey a) | 3 (Sign in, Set up a site, Audit) plus a wait the customer cannot watch |
| Screens before first deployed fix | 6, about 19 interactions, one failed proposal, and Verify cannot succeed |
| Screens that show value on a return visit without navigating | 0 (Pulse is empty) |
| Rail items | 11, of which 4 (Competitors, Backlinks, Local SEO, SERP Inspector) had no data on any test site |

---

## 3. Friction inventory, ranked by delay to first value

Each item: what was observed, evidence, one-sentence fix.

1. **Home ignores what the product knows.** Pulse for a site with 46 findings, 3 actions and 1 deployed fix reads "No visibility data yet." The route reads only `keywordsTracked` and `citationSamples` (`apps/api/src/index.ts:983-989`); the view has a single empty panel (`pulse.ts:59-67`). Nothing polls rank or AI yet, so this screen is empty for every customer. Fix: make the home screen read health score, top issues, fixes waiting and last audit time from the audit and actions tables until polling exists, and show the visibility score as a second block when it has data.
2. **The crawl is invisible while it runs.** After Get started the customer lands on Audit with "Audit queued. It usually starts within a few minutes." (`format.ts:129`) and nothing else to do; in production the wait is 2–15 minutes (`docs/46-Audit-Runner.md`). Fix: show pages crawled so far and an estimated finish from `audit_requests` plus a `crawled_pages` count, and make the first findings appear as pages arrive.
3. **Setup is asked for before it is needed, in another place.** Audit shows "Set a deploy target in Settings to turn auto-fixable findings into proposed fixes." (`audit.ts:197`) and 42 disabled buttons (`audit.ts:20`); the target is a panel on Settings (`settings.ts:107-113`). Fix: open the deploy-target form as a dialog from the first "Propose fix" click, and remove the standing banner.
4. **Deployment settings are shown to customers.** Settings starts with "Point the dashboard at your Engine API" (`settings.ts:198`), "API base URL" (`:203`) and "Project ID … project uuid" (`:206-209`). The API base is baked at build time (`api.ts:103-110`), so the field is only a way to break the app. Fix: delete the API connection panel and the Project ID field; selection already happens on Clients.
5. **Fixes are approved unseen.** The card shows kind, "Regenerate title · brightsmile-edge", impact and effort (`fixQueue.ts:9-18`); the stored diff was `after: "Bright Smile Dental"` for `/roadmap` and a JSON-LD `@type: Thing`. Fix: put the before and after text on the card and name the page, not the worker. (The other session's uncommitted `feat/fix-queue-trust` branch is building this; not on main yet.)
6. **The first "Propose fix" a customer clicks fails.** Top group "Page says too little about your brand", pill "auto-fixable", toast "no action could be generated — the fix needs context this crawl did not capture." Same as B5 in the last review. Fix: have the API report fixability per finding and show "manual" for types the generator cannot handle.
7. **Verify cannot succeed from the UI.** `nextAction('deployed')` yields a "Verify" button (`format.ts:504`) that posts an empty body; the route compares `renderedHtml` (`index.ts:1523-1539`) and returns 409, shown raw in a toast (`fixQueue.ts:33`). Fix: make verification a runner step after deploy and show its result on the card; remove the button.
8. **One row per page per issue, one click each.** 46 findings produce 42 buttons; fixing one issue on 7 pages is 7 clicks (`audit.ts:44-55`). Fix: one "Fix on all N pages" action per group, with per-page rows collapsed by default.
9. **No sign of which client or site is selected.** Topbar text is the route label (`shell.ts:204`); switching shows a toast for 2.6 s (`accounts.ts:30`, `shell.ts:118`). Fix: a client · site switcher at the top of the rail that also replaces "Continue with a site you already added".
10. **Eleven rail items, seven of them empty for a new site.** Competitors ("Track at least two entities to compare"), Backlinks ("No analysis yet, or no gaps found"), Local SEO ("Set a location profile (via the GBP connector/API)"), Entity Graph, SERP Inspector each require an action the customer has no reason to take yet (`competitors.ts:98`, `offsite.ts:63`, `local.ts:65`). Fix: five destinations (Home, Findings, Fixes, Visibility, Connections) with the rest as tabs inside Visibility, shown when they have data.
11. **Integrations gallery is mostly "coming soon".** Of 11 tiles, 2 are connectable, 3 read "NOT AVAILABLE YET", 6 read "COMING SOON" (`format.ts:163-175`; `23-integrations-acme`). Fix: show the two connectable providers and Google with the reason, and move planned providers under a collapsed "Planned" row.
12. **Raw errors reach the screen.** `Could not load Pulse: 401 {"error":"session expired","code":"expired"}` (`api.ts:166`, `pulse.ts:78`), the 409 toast above, `Failed to render: …` (`shell.ts:210`). `readableError` exists (`errors.ts:12`) and is used in 4 of 13 views. Fix: route every error through `readableError`, and send an expired session back to sign-in.
13. **Labels leak build vocabulary.** "poor-self-containment" is shown as a group title because it is missing from `ISSUE_LABELS` (`format.ts:290-313`); "Propose → approve → deploy → verify. Every fix is reversible." (`fixQueue.ts:64`); "uuid" (`settings.ts:209`); "GBP connector/API" (`local.ts:65`); nav "Backlinks" versus title "Backlink & mentions" (`offsite.ts:42`); nav "Audit" versus title "Technical audit" (`audit.ts:188`); crumb "Get started" versus title "Set up a site" (`onboarding.ts:190`). Fix: one name per screen used in nav, crumb and title, and a label for every issue type.
14. **Get started asks for four things where one is enough.** "Client", "Web address", "Site name", "Brand or business name" (`onboarding.ts:173-183`); the last two are derived if blank (`onboardingDefaults`). Fix: ask for the web address only and show the derived names as editable text after the crawl starts.
15. **Users are created in a terminal.** Settings → Platform → Users says "New sign-in accounts are created with `pnpm db:user …`" (`platform.ts:261`). Fix: an invite form that creates the user, the membership and a first password reset link.
16. **Operator and customer share one Settings page.** Platform and Vendor keys render below Branding (`integrations.ts:105`, `platform.ts:300`); the admin screenshot is 2,975 px tall (`40-admin-settings-light.png`). Fix: a separate admin-only "Platform" route.
17. **Report header overlaps.** "Open standalone ↗" is drawn over the subtitle (`28-report-acme-light.png`; `report.ts:40-43`, `styles.css:626`). Fix: put the button in the header row, right aligned.
18. **Mobile has no navigation.** Below 860 px the rail is `display: none` with nothing in its place (`styles.css:88`; `31-pulse-mobile`, `32-fix-queue-mobile`). Fix: a bottom bar or a sheet from the collapse button.
19. **The theme toggle is not persisted** (`shell.ts:137-140`), and the sign-in screen ignores the theme entirely (`01-signin-light.png` is dark). Fix: store the choice with the rail state and build sign-in on the tokens.

---

## 4. The target journey

### Customer: sign-in to first insight, then to first deployed fix

| Step | Screen | The one decision |
|---|---|---|
| 1 | Sign in | Credentials. (Later: an invite link lands here with the email filled.) |
| 2 | Home, empty state: one field "Your website" and a button "Start the audit" | The address. Client name and brand name are derived and shown as editable text after the crawl starts. |
| 3 | Home, crawling: "Crawling brightsmile.example · 4 of about 20 pages · first findings in a minute" | None. Findings and the health score fill in as pages arrive. **First insight on screen 2, no navigation.** |
| 4 | Home, populated: health score, top 3 issues with page counts, "N fixes ready", last audit time | Which issue to open. |
| 5 | Findings, one group open: what the issue is, why it matters, the pages, one button "Fix on all 4 pages" | Fix or not. |
| 6 | Dialog, first time only: "Where should Engine put fixes?" with three cards (WordPress plugin, Cloudflare Worker, GitHub pull request) and the fields for the chosen one | Deploy kind. This is the only setup step in the customer journey, and it happens at the moment of need. |
| 7 | Fixes: the card shows the page, "Now" and "After", impact | Approve. |
| 8 | Fixes: the card moves to "Deployed", then to "Verified" on its own when the runner re-crawls | None. **First deployed fix on screen 4, about 9 interactions.** |

### Where setup lives

- **Customer: one place, Settings → Connections.** Contains: where fixes go (per site), connected accounts (per client; the current Integrations gallery, reduced to connectable providers), branding (per client), sites and clients (the current Clients grid). Each is also offered just in time from the screen that needs it (step 6 above; "Connect Search Console" from the Visibility block when it has no source). The API connection panel and the Project ID field are removed.
- **Operator: one place, an admin-only Platform route.** A checklist in order: database and secrets (read from `/health/integrations`), first admin, Google OAuth client with the redirect URI to copy, invite users, crawl runner status (last run, queue depth). Each row says done or what to do next. Google Cloud Console and the Worker secrets stay outside the product, but the checklist names them once, in order, with the value to paste.

---

## 5. Redesign proposal

Constraints: keep every token in `styles.css:3-32`, the rail and topbar structure, the panel language (surface, 1 px border, 10 px radius), the mono readouts for numbers, and the confidence band. Change the information architecture, the home screen, and three screens the journey depends on.

### 5.1 Shell

Rail of five destinations plus Settings. A context switcher at the top under the brand, always showing "Client · Site" and opening a list of every site the user can see (this replaces the Clients grid as a switcher and "Continue with a site you already added"). Topbar keeps the collapse button, the breadcrumb (now "Site name / Screen"), ⌘K and the theme toggle, and adds a small status chip when a crawl is running ("Crawling · 12 pages"). Below 860 px the rail becomes a bottom bar with the five icons.

```
┌──────────────┬───────────────────────────────────────────────────────┐
│ ✚ Engine     │ ☰  Bright Smile Dental / Findings     Crawling·12  ⌘K ☾│
│              ├───────────────────────────────────────────────────────┤
│ ▾ Bright     │                                                        │
│   Smile ·    │                                                        │
│   brightsmile│                                                        │
│   .example   │                                                        │
│──────────────│                                                        │
│ ◉ Home       │                                                        │
│ ○ Findings   │                                                        │
│ ○ Fixes      │                                                        │
│ ○ Visibility │                                                        │
│ ○ Connections│                                                        │
│              │                                                        │
│              │                                                        │
│ ○ Settings   │                                                        │
│ TC tester@…  │                                                        │
└──────────────┴───────────────────────────────────────────────────────┘
```

Mapping from today's eleven items: Pulse → Home. Audit → Findings. Fix Queue → Fixes. SERP Inspector, Entity Graph, Competitors, Backlinks, Local SEO → tabs inside Visibility, each shown only when it has a data source. Integrations → Connections. Clients → the switcher plus a "Sites and clients" panel under Settings. Settings keeps deploy target and branding and gains Connections; Platform becomes its own admin-only route.

### 5.2 First screen after sign-in (Home)

Three states, one screen. The greeting line in the mockup (`docs/mockups/pulse.html:331-332`, "Your unified visibility is up 4.2 points this month — and 6 fixes are waiting") is the right idea; until polling exists it should say what is true: "Site health 20 · 46 findings on 7 pages · 2 fixes ready · audited 3 minutes ago."

Empty (no site):

```
┌───────────────────────────────────────────────────────────────┐
│ Set up your first site                                        │
│                                                               │
│  Your website  [ https://                                   ] │
│                                                               │
│  [ Start the audit ]   Engine crawls up to 50 pages and       │
│                        shows what to fix. Nothing is changed  │
│                        on your site until you approve it.     │
└───────────────────────────────────────────────────────────────┘
```

Crawling and populated (same layout, numbers fill in):

```
┌ Home ──────────────────────────────────────────────────────────┐
│ Site health 20 · 46 findings on 7 pages · 2 fixes ready ·      │
│ audited 3 minutes ago                                          │
├────────────────────────────┬───────────────────────────────────┤
│ Site health          20    │ Top issues                        │
│ ▓▓░░░░░░░░░░░░░░░░░░      │ ● HIGH Page says too little       │
│ 7 pages · 10 issue types   │   about your brand · 7 pages  →   │
│                            │ ● HIGH Too few internal links     │
│ Unified visibility         │   · 6 pages                    →  │
│ not measured yet           │ ● MED  No structured data         │
│ Connect Search Console →   │   · 7 pages                    →  │
├────────────────────────────┴───────────────────────────────────┤
│ Fixes           Proposed 2 · Approved 0 · Deployed 1 · Verified 0│
│ ▸ Regenerate title on /roadmap        +3   [Approve]            │
│ ▸ Add structured data on /roadmap     +4   [Approve]            │
└─────────────────────────────────────────────────────────────────┘
```

The hero score and band from `pulse.ts:24-50` move into the left column and render when `score` is non-null; until then the block says "not measured yet" with the one action that would change it.

### 5.3 Findings (today: Audit)

Keep `groupFindings`. Add an overview strip, an explanation per issue, one action per group, and collapse pages by default. Remove the deploy-target banner; the first group action opens the deploy dialog if no target exists.

```
┌ Findings ───────────────────────────────────────────────────────┐
│ Health 20   HIGH 6 · MEDIUM 2 · LOW 2   7 pages   [Run audit]   │
├─────────────────────────────────────────────────────────────────┤
│ HIGH  Page says too little about your brand            7 pages  │
│       AI answers cite pages that name the business and what it  │
│       does. These pages do not.        [Fix on all 7 pages]  ▸  │
├─────────────────────────────────────────────────────────────────┤
│ HIGH  Too few internal links                           6 pages  │
│       …                                [Fix on all 6 pages]  ▸  │
├─────────────────────────────────────────────────────────────────┤
│ MED   Missing <title>                                  4 pages  │
│       …                                [Fix on all 4 pages]  ▾  │
│       /roadmap   http://…/roadmap                       +3      │
│       /changelog http://…/changelog                     +3      │
└─────────────────────────────────────────────────────────────────┘
```

Groups whose generator cannot produce an action (today's "auto-fixable" that fails) show "Manual · how to fix →" instead of a button.

### 5.4 Fix card (today: Fix Queue card)

Same lanes. The card names the page, shows the change, and has one button. Verification is a status, not a button.

```
┌─────────────────────────────────┐
│ TITLE · /roadmap                │
│ Now    (no title)               │
│ After  Roadmap — Bright Smile   │
│        Dental                   │
│ See the whole change            │
│ +3 impact · edge                │
│ [ Approve ]                     │
└─────────────────────────────────┘
   Deployed lane:
┌─────────────────────────────────┐
│ TITLE · /roadmap                │
│ Deployed 2 min ago              │
│ ◌ Checking the live page…       │
└─────────────────────────────────┘
```

### 5.5 Connections (today: Integrations, Settings → Deploy target, Settings → Branding)

One screen, three sections, only real choices.

```
┌ Connections ─────────────────────────────────────────────────────┐
│ Where fixes go                                        per site    │
│  ◉ Cloudflare Worker  brightsmile-edge          [Change]          │
│  ○ WordPress plugin   ○ GitHub pull request                       │
├──────────────────────────────────────────────────────────────────┤
│ Connected accounts                                  per client    │
│  G  Google Search Console   Not available yet · ask your admin    │
│  b  Bing Webmaster Tools    Not connected        [Connect]        │
│  ☁  Cloudflare              Not connected        [Connect]        │
│  ▸ Planned: Analytics 4, Business Profile, WordPress, Shopify, …  │
├──────────────────────────────────────────────────────────────────┤
│ Branding                                            per client    │
│  Company name [Bright Smile Dental]  Logo [—]  Colour [#2f6feb]   │
└──────────────────────────────────────────────────────────────────┘
```

The existing dialog (`dialog.ts`) stays as the connect panel per provider.

### 5.6 Interface judgment against `docs/30-Design-System.md` and the last review's "Design engineering" table

Observed, then concluded. Line numbers are in `apps/dashboard/styles.css` unless stated.

- **Tokens.** Every colour in the doc's §1 table matches the stylesheet (`:3-32`); the doc names `--muted`/`--faint`, the code has `--text-muted`/`--text-faint`. Conclusion: the palette is disciplined; the problem is not the tokens.
- **A second, hard-coded semantic palette.** `#16a34a` / `#d97706` / `#dc2626` at `:575-577`, `:583-585`, `:607`, `:622` (entity score, meters, impact, authority) next to `--good` `#1a7f52`, `--watch`, `--risk`. Visible on `19-entity-graph-acme`: the "20%" red and the green bar are not the token colours, and they do not change in dark mode. Same finding as the last review; still open.
- **Sign-in is a different product.** `:425-514` is 90 lines of literal hex and rgba: `#04050a` ground, cyan-to-blue gradient button (`:494`), cyan labels `#66e6f5` (`:467`), pink error `#ff6aa8` (`:510`), text-shadow on the title (`:460`). The block ignores `data-theme`. The marketing page (`00-marketing`) uses a serif display and a dot grid. The app uses `#2f6feb` flat. Conclusion: three identities, as before.
- **Hierarchy.** Every screen is `.pagehead` (20 px h1, 13.5 px subtitle, `:82-83`) then one or two `.panel`s at `max-width: 1180px` (`:77`). On a 1440 px viewport most screens are one panel and empty canvas (`08`, `12`, `13`, `14`, `16`, `20`). Conclusion: the layout has one level; the doc's "one number, then depth" needs a second level (overview strip, then groups) on Findings and Home.
- **Density.** Findings rows are 31 px tall with a 62 px severity chip (`:168`), which is right for a list. The Fix Queue lanes are four equal columns even with 0 cards in two of them (`17`). Clients cards are 370 px wide for one row of content (`27`). Conclusion: density is inconsistent; lists are dense, cards are sparse.
- **Typography.** 17 distinct font sizes from 10 to 46 px (inventory of `font-size` in `styles.css`), 5 weights (500–700), 8 letter-spacing values. The doc asks for a tight fixed scale. Mono is used for data (`.num`, `.score`, `.pill`) and also for form fields (`.field`, `:350`), hints (`.fhint`), tile status (`.intg-status`) and the toast body in places, so the "instrument readout" signal is diluted. Uppercase tracked labels exist at `:149`, `:168`, `:207`, `:210`, `:255`, `:466` although §2 says sentence case. Conclusion: reduce to about 8 sizes and reserve mono for numbers and codes.
- **Colour use.** The accent is rationed correctly (active nav wash, primary buttons, links). Semantic colour is used on the severity chip and impact pill only. Conclusion: correct, keep.
- **Motion.** Transitions are 120 ms colour and border only (`:48`, `:73`, `:125`, `:147`, …). No `:active` rule anywhere. `:focus-visible` exists only on `.intg-tile` (`:248`); `.field:focus` sets `outline: none` and tints the border (`:350-351`). No `@media (hover: hover)` gating. The dialog rises 6 px over 140 ms (`:276-280`), the Copilot overlay does not (`:534-535`). The theme choice is not stored. All of this was in the last review's "Design engineering" table; none of it has changed on main.
- **Empty and loading states.** Every empty state is honest and specific (good). Loading is a mono "loading…" line (`shell.ts:205`, `:78`); the doc's §7 asks for skeletons; none exist. Four empty states name an action the screen does not offer ("Set a location profile (via the GBP connector/API)", `local.ts:65`; "Track at least two entities", `competitors.ts:98`). Conclusion: honest, but they teach the customer that most of the product is not for them yet.
- **Copy voice.** Best lines: "Health score 20 across 7 pages · 42 of 46 findings map to a one-click fix." and "The site Engine will audit. A full URL is fine; only the domain is kept." Worst: "Point the dashboard at your Engine API", "The uuid of the project this dashboard reads", "Propose → approve → deploy → verify", "mine the AI citation archive" (`offsite.ts:63`), "cross-SEO/GEO summary" (`copilot.ts:167`), "the traffic half of AI-referral attribution" (registry copy on the GA4 tile). Conclusion: the subtitles explain the mechanism; they should say what the customer can do here.
- **Identity.** What is Engine's: the confidence band (unused because Pulse is empty), the mono readouts, and the honest empty copy. What is generic: rail of eleven nouns, one panel per page, blue primary button, uppercase pill chips, kanban lanes. Conclusion: the app reads as an admin template because the two things that would make it Engine, a number about the customer's site and a fix they can read, are not on the first screen.

---

## 6. Sequenced plan, three PR-sized steps

Each builds on the previous. The other session's `feat/fix-queue-trust` branch (diff preview and review step on cards, migration 0022) should merge first; step 2 assumes it.

### PR 1 — One home, one context, no deployment settings

- `apps/dashboard/src/shell.ts`: five routes plus Settings; context switcher in the rail reading `fetchAccounts`; breadcrumb "Site / Screen"; persist theme with the rail key; on a 401 with `code: "expired"` call `signOut()`.
- `apps/dashboard/src/views/pulse.ts` → Home: read `fetchAudit`, `fetchActions`, `fetchLatestAuditRequest` alongside `fetchPulse`; render the summary line, health block, top issues, fixes strip; keep the hero score for when `score` is non-null.
- `apps/dashboard/src/views/settings.ts`: remove the "API connection" panel (`:199-212`) and the "Save. Reopen a view to reload data." toast; keep deploy target and branding; add "Sites and clients" (the `accounts.ts` grid) here.
- `apps/dashboard/src/api.ts`: delete `setApiBaseUrl`/`BASE_KEY` (`:52`, `:113`) and the Settings-only project id path.
- `apps/dashboard/src/format.ts`: add the missing `poor-self-containment` label; one name per screen shared by nav, crumb and title.
- `apps/dashboard/styles.css`: switcher styles, bottom bar under 860 px replacing `.rail { display: none }` (`:88`).
- Tests: `format.test.ts` for the home summary line and issue labels; shell test for the redirect and expired-session sign-out.
- Removes: API base URL field, Project ID field, "Propose → approve → deploy → verify" subtitle, the toast-only switch feedback, six rail items (moved under Visibility in PR 3).

### PR 2 — First value on the first screen

- `apps/dashboard/src/views/onboarding.ts`: reduce to the web address; derive client, site and brand names via `onboardingDefaults`; land on Home, not Audit.
- `apps/api/src/index.ts` and `apps/api/src/repositories/auditRequests.ts`: extend `GET /projects/:id/audit-requests/latest` with `pagesCrawled` (count of `crawled_pages` for the run) so the dashboard can show progress; add `POST /projects/:id/findings/propose-batch` taking a finding-group key so one click proposes for all pages.
- `packages/crawler/src/runQueue.ts`: post pages incrementally or report progress, and after a deploy re-crawl the affected URLs and call `/verify` with `renderedHtml`; the dashboard stops offering a Verify button (`format.ts:504`).
- `apps/dashboard/src/views/audit.ts` → Findings: overview strip, explanation per issue type (new map in `format.ts`), group-level action, collapsed page rows, deploy-target dialog on first use via `dialog.ts` instead of the banner (`:197`).
- `apps/api` propose route: return `fixable: false` for finding types whose generator needs missing context, and the dashboard shows "Manual" for them.
- `apps/dashboard/src/errors.ts`: use `readableError` in `pulse.ts`, `fixQueue.ts`, `audit.ts`, `accounts.ts`, `shell.ts`.
- `apps/dashboard/src/views/report.ts`: move the button into the header row.
- Removes: the 42 per-page buttons as the primary action, the "auto-fixable" pill on unfixable types, the Verify button, the standing "Set a deploy target" banner, raw status codes in toasts.

### PR 3 — Operator in one place, one identity

- New `apps/dashboard/src/views/platformRoute.ts` (admin-only route `#/platform`, 404 semantics preserved by the API): ordered checklist built from `/health/integrations`, `platform_credentials` and `users`; invite form calling a new `POST /platform/users` that creates the user row, membership and a one-time password link (replaces the CLI hint at `platform.ts:261`). Move `platformSection` and `vendorKeysPanel` out of `settings.ts` and `integrations.ts`.
- `apps/dashboard/src/views/integrations.ts` and `googleIntegrations.ts` → Connections: sections per §5.5; planned providers behind a disclosure; Visibility tabs (SERP, Entity, Competitors, Backlinks, Local) mounted only when their source exists.
- `apps/dashboard/src/auth/authScreen.ts` and `styles.css:425-514`: rebuild sign-in on the tokens, theme-aware.
- `styles.css`: `:active` scale on buttons, `:focus-visible` ring on every control, `@media (hover: hover)` around hover rules, skeleton class for panels, Copilot rise and fade, replace the `#16a34a`/`#d97706`/`#dc2626` triad with the tokens, reduce the type scale.
- Removes: Platform and Vendor keys from Settings, the sign-in hex block, the second semantic palette, six top-level rail items.

---

## 7. Open questions that need your decision

1. **What is the first number on Home?** Until rank and AI polling run, the only real number is site health (20 for the test site). Options: lead with health and show "Unified visibility: not measured yet" underneath, or keep Unified Visibility as the hero and accept an empty home until polling ships. The plan above assumes health first. >> home is the complete centralized analytics view for the user, this would include first understanding what data can be brought in from google integrations and other future integrations and then showing it in a neat analytics view, we will also have a "Ask Engine" chat bar hovering at the bottom, I'll plug in AI once you're done with this revamp
2. **Is Verify a customer action or a machine step?** Today it is a button that cannot succeed. The plan makes the runner re-crawl deployed pages and verify. That needs the runner to know the live URL and adds a second crawl per deploy. >> machine step, but user can do it as well
3. **Should the client layer be hidden for single-site customers?** A customer with one site never needs "Client", the switcher, branding or the Clients grid. The plan derives the client from the site and shows the switcher only when a second site exists. This changes the Get started form and the Clients route. >> yes, client layer should be hidden. The entity types can be Company or Agency or Individual
4. **Does Integrations stay a top-level destination or become Settings → Connections?** The plan merges deploy target, connected accounts and branding into one Connections screen. If Integrations must stay a marketing-visible top-level item, the deploy target still moves next to it. >> top-level for now
5. **Invite users from the product?** The plan adds `POST /platform/users` and an invite form. This creates a password-reset flow that does not exist today and touches `LOCAL_AUTH_*`. >> let's build this functionality, we'll make the onboarding, this journey, and other related journeys functional later
6. **Which deploy kinds to lead with?** GitHub PR uses one platform token (review B7). The plan lists WordPress and Cloudflare Worker first and marks GitHub "needs setup" until a GitHub App exists. >> why is github app needed, would this still be in the production version of the product?
7. **One identity: app or marketing?** The marketing page is serif with a dot grid; the app is flat system sans. The plan keeps the app's tokens and rebuilds sign-in on them, and leaves the marketing page alone. Say if the marketing look should come into the app instead. >> we can keep them sepratae, the marketing page will go once we have a full website
8. **Which of the six data screens (SERP, Entity, Competitors, Backlinks, Local, Copilot) ship in the first redesign?** The plan hides them until they have a source. If any must stay visible for demos, it needs a stated empty state with a real action. >> pick each of these one by one
