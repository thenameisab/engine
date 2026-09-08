# Ship-readiness review — first test customers

Date: 2026-09-08. Branch reviewed: `fix/integrations-affordance` (main at `1a50497` plus the uncommitted hover-card work).

## Verdict

Engine is not ready to hand to a test customer. The backend is more complete than the product. A customer who signs in today can create a client and a project and then reaches a dead end: nothing in the UI can add an entity, add keywords or prompts, or start a crawl, and nothing runs on a schedule except the nightly Google sync. Every screen after Clients renders an honest empty state that tells the customer to do something the product gives them no control for.

Four things must be true before the first customer signs in:

1. A customer can get from sign-in to a populated Pulse and Audit without a staff member running a CLI or `curl`.
2. Migrations 0017 and 0018 are applied to Neon before the current API is deployed, or every integration route returns 500.
3. Internal build language (pillar codes, phase numbers, env var names, raw API paths, "pre-alpha") is gone from customer screens.
4. The Audit screen renders correctly and the Fix Queue shows the change a customer is about to approve.

Below that line there is a second tier of work that decides whether the product feels excellent rather than merely working. Both tiers are listed with file references.

## How this was reviewed

- Four parallel code audits: API completeness and security, integrations architecture, dashboard code and CSS, and PRD-versus-code coverage.
- A live walkthrough of the real product. I started an isolated Postgres 16 in the session scratchpad, applied all 18 migrations, ran `wrangler dev` with a local test roster, built and served the dashboard, signed in as a test customer, created a client and project, ran the repository's own Playwright crawler against the local docs site, ran the entity audit, and walked findings through propose, approve, deploy and verify.
- Typecheck and the dashboard test suite pass on the current branch (28 tests).

## Tier 1 — blockers

### B1. No onboarding path from sign-in to data

Traced in code and reproduced in the browser.

| Step | What the customer sees | Evidence |
|---|---|---|
| Sign in | Works. No sign-up route exists; a user row must be inserted by hand. | `apps/api/src/index.ts:299`, `apps/api/src/repositories/userCredentials.ts` |
| First screen | Red banner "Could not load Pulse: No project selected. Choose one in Settings, or create one from the Clients grid." | `apps/dashboard/src/api.ts:126`, `views/pulse.ts:82` |
| Clients | "+ New client" and "+ Project" open native `window.prompt()` dialogs, three in a row. | `views/accounts.ts:94-113` |
| Pulse after picking a project | "No visibility data yet. Poll rank tracking (A1) and AI-visibility coverage (A2)…" There is no control anywhere that polls A1 or A2. | `views/pulse.ts:62`; no dashboard call to `/rank/poll` or `/ai/poll` |
| Audit | "Run a crawl to populate the audit" with no button. The crawler is a CLI that staff run locally. | `views/audit.ts:117`, `packages/crawler/src/cli.ts` |
| Fix Queue | "Run an audit to turn findings into proposed fixes." Same dead end. | `views/fixQueue.ts` |
| Entities | No UI creates one. Competitors, Backlinks, Local SEO and Copilot all pivot on an entity picker that is empty. | `api.ts` has `fetchEntities` and no create |
| Integrations | "Pick a client from the Clients grid first" even after the customer picked a project from that grid, because selecting a project sets the project id but not the account id. | `views/accounts.ts:13-24` calls `setProjectId` only; `setAccountId` only at lines 54, 61, 113 |

Minimum fix: an onboarding flow that creates account, project and first entity in one form, adds the domain, and queues a crawl. That requires a crawl trigger the product owns (see B4).

### B2. Migrations 0017 and 0018 are not applied, and CI never applies migrations

The ported integrations repository reads `external_subject`, `credential_kind`, `public_fields`, `integration_events` and `oauth_flows`, none of which exist on Neon until 0017 and 0018 run. Deploying the current `main` breaks connect, callback, disconnect and sync with 500s. `.github/workflows/ci.yml` has no migrate step. The working log also records 0011 as unapplied at one point. Evidence: `apps/api/src/routes/integrations.ts:514`, `apps/api/src/repositories/oauthFlows.ts`, `infra/migrations/postgres/0017_integrations_generalised.sql:106-140`.

Fix: add a migrate job to CI that runs before `deploy-api`, and run it once by hand now.

### B3. Internal language on customer screens

Confirmed on screen during the walkthrough, not only in code.

- `views/pulse.ts:63-65` — "Poll rank tracking (A1) and AI-visibility coverage (A2)"
- `src/format.ts:135` — "not measured yet (B5, Phase 2)" on the Local cell of the Pulse success state
- `views/competitors.ts:30-36` — gap blurbs with "(A1)", "(A2) — the GEO-native gap", "(B3)", "(A6)"
- `src/copilot.ts:50-54` — citation chips "A1 · organic", "A2 · AI", "B1 · finding"
- `views/integrations.ts:101` — header chrome reads "from /health/integrations"
- `views/integrations.ts:90-104` — the whole "Platform wiring" panel lists `GOOGLE_CLIENT_ID`, `STRIPE_WEBHOOK_SECRET`, `SERPER_API_KEY`, `OPENAI_API_KEY` and their wired state to every customer. The code's own comment calls it "an operator view, not a customer one."
- `auth/authScreen.ts:106` — "Invite-only · pre-alpha access" on the sign-in card
- `shell.ts:72-73` — "Internal" / "pre-alpha build" fallbacks in the rail footer
- `views/fixQueue.ts` page subtitle — "each transition is written to Postgres with an audit entry"
- `views/settings.ts:203` — "Leave blank to explore with sample data." This is false. `api.ts` removed every sample fallback; a blank base URL produces error boxes on every screen.
- API error strings that reach toasts name env vars: "GitHub PR export is not configured (set GITHUB_TOKEN)" (`index.ts:1395`), "Content rewrites are not configured (set OPENAI_API_KEY)" (`index.ts:1160`).

### B4. Nothing the product measures runs on its own

The only cron is the 03:15 UTC Google sync (`apps/api/wrangler.toml`, `index.ts:1764`). Rank polling, AI polling and crawling are all manual POSTs, and the crawler cannot run on Workers at all. A customer's site is re-audited only when a staff member runs `engine-crawl` and posts the result. Decide where crawls run (a container job, a queue consumer, or a scheduled GitHub Action to start with), expose "Run audit" in the product, and schedule rank and AI polls per project.

### B5. The Audit screen is visually broken

On both themes the issue-type label overlaps the "auto-fixable" chip, the page URL is not visible, and each row ends in a full-width "Propose fix" bar. Root cause: the button reuses `.card-act`, which is `width: 100%` for Fix Queue cards (`styles.css:156`), so it takes the row and squeezes `.fmain` to a sliver. Also:

- Findings are one row per page per issue, so a 7-page crawl produced 44 near-identical rows with no grouping by issue type or page.
- Every row reads "HIGH +5" because content-source findings arrive with `severity: 1` and no issue label (`issueLabel` falls through to the raw slug for `sparse-internal-linking`, `weak-eeat`, `not-answer-first`, `weak-entity-coverage`, `weak-corroboration`, `missing-entity-schema`, `missing-wikidata-mapping`).
- "auto-fixable" is shown for findings whose proposal then fails with "no action could be generated — the fix needs context this crawl did not capture" (observed on `weak-corroboration`). The pill promises what the generator cannot deliver.

### B6. Fix Queue approves changes the customer cannot see

Cards show type, a derived title and an impact chip, and nothing else (`views/fixQueue.ts:7`, `format.ts:264`). The proposed content for the test project was a page title of "Acme Dental", a meta description of "Acme Dental", and JSON-LD of `@type: Thing`. A customer would approve and deploy those to their live site without ever seeing them. Every card needs a before/after preview, and the generators need a quality floor (a title template that uses page context, a schema type derived from the entity, not `Thing`).

### B7. Deploy targets are not customer-owned

GitHub PR export uses one platform-wide `GITHUB_TOKEN` (`index.ts:129, 1394-1398`). Two customers' repositories cannot be reached with one token you hold, and no customer will hand a personal token to a form. This needs a GitHub App installation per account, modelled like the Google connections. Edge worker and CMS plugin targets are closer to right; the WordPress plugin is real (`plugins/wordpress/engine-seo.php`), Shopify is a CLI, not an installable app.

### B8. Ops items still open from the working log

- Cloudflare Pages automatic git builds must be off on the `engineai` project or they overwrite CI's build and drop `ENGINE_API_BASE`, which disables sign-in.
- `working_log.md` is public and lists the three pre-alpha users' emails, states they share one password, and names the Neon project and Worker host. Rotate the passwords, then decide about the file.
- `LOCAL_AUTH_SECRET`, `DATABASE_URL`, Google OAuth trio, `SERPER_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` must be set on the deployed Worker.
- `ALLOWED_EMAILS` unset means any Google account can self-provision once Google sign-in is restored (`middleware/auth.ts:56-64`).

## Tier 2 — half-done builds

| Area | State | Gap for a first customer |
|---|---|---|
| Branded report | Route works; the dashboard view fails with a raw `401 {"error":"missing bearer token"}` for password sessions because `fetchReportUrl` uses only the Google token path, not the stored token (`api.ts:465-475` versus `request()` at `api.ts:151`). | Report unreachable from the UI. |
| Google integrations | Connect, PKCE, sealed refresh tokens, nightly sync all real. Sync writes `gsc_query_daily`, `gsc_page_daily`, `ga4_channel_daily` and nothing reads them (`repositories/googleSync.ts:145-231`; Pulse reads rank and citations only). | "Synced · 234 rows" changes nothing on any screen. Either wire GSC/GA4 into Pulse or hide sync until it does. |
| AI visibility | Adapters exist for OpenAI and Gemini only (`packages/connectors/src/factory.ts:31-39`). Perplexity, Anthropic, Copilot, AI Overviews are declared types with no adapter. | Marketing and PRD promise six engines. |
| Rank tracking | SERP Inspector is a one-off lookup. Keyword configs exist in the schema but nothing schedules polls and there is no keyword management UI. | No tracked keywords, no history, no gainers and losers. |
| Billing | Stripe webhook and checkout are real and tested (`index.ts:1539-1598`). No plan or upgrade screen exists; `isOverLimit` is only used for display (`index.ts:1608`), never enforced on project or keyword creation. Growth, Agency and Enterprise limits are marked provisional. | Nobody can buy, and nobody is limited. Fine for a free pilot; say so in the product. |
| Copilot | Deterministic intent classifier, no model call (`packages/copilot/src/intent.ts:1`). Works for a closed set of questions. | Changelog says natural-language questions are generally available. Either keep the closed set and phrase the placeholder honestly, or wire the model path. |
| Backlinks | Nav item says "Backlinks"; the package aggregates your own AI citation archive and has no link data source (`packages/backlink/src/intel.ts:38`). | Rename to "Citations and mentions" or remove until link data exists. |
| Competitors | Real set-difference math; content gaps come from citation domains and backlink gaps from mention domains, because the true feeds do not exist. | Numbers are defensible only once AI polling runs. |
| Local SEO | Audit and GBP write-back are real; NAP consistency scores a manually entered profile. The GBP resource picker asks the customer to paste an entity UUID (`views/googleIntegrations.ts:398-402`). | Needs an entity dropdown, not a UUID field. |
| Planned providers | Eight providers registered, six with no lister or sync; the dashboard never fetches planned rows (`api.ts:484` default `includePlanned=false`), so 50 lines of "Coming soon" badge code are unreachable and `types.ts:348` documents the opposite. | Decide: show a roadmap section or delete the badge code. |
| Onboarding KPIs | Only `domain-connected` can be marked and the dashboard never calls it (`index.ts:1523`). | E2/E3 KPIs are always null. |

## Tier 2 — integrations library, honest assessment

The concern that the library is "weird and underthought" is half right. The code is not conceptually confused. There are two registries, not three: platform-owned vendor keys in `packages/config` and customer-owned connections in `packages/integrations`, and the split is documented and matches the code. Adding Bing is one registry row plus one lister, and Bing and Cloudflare listers already exist. PKCE on every flow, single-use `state` through a conditional update, AAD-bound AES-GCM sealing, and key rotation are correct and unit tested.

What is wrong is sequencing. Key rotation, an append-only event trail and PKCE on confidential clients were built before a single screen consumed the synced data. The result is a connect flow that reports success and a product that does not change.

Specific items:

- `packages/connectors/src/google/oauth.ts` is a full duplicate OAuth implementation (no PKCE, no timeout, no redirect protection) imported only by its own test. Delete it and its test.
- No test runs `upsertConnection`, `disconnect` or `assignResource` against Postgres. `routes.integrations.test.ts` deliberately never connects. Add one DB-backed test now that a local Postgres path exists (see appendix).
- `reapExpiredFlows` (`oauthFlows.ts:130`) is never scheduled, so `oauth_flows` grows forever. Call it from `scheduled()`.
- `getAccessToken` has no per-connection lock (`repositories/integrations.ts:492-563`). Harmless for Google, which does not rotate refresh tokens; a bug the day HubSpot ships.
- `connectButton` is not disabled for `availability === 'planned'` (`views/googleIntegrations.ts:303-326`).

Recommended order: wire GSC and GA4 into Pulse, delete the dead OAuth file, fix the planned-rows comment, add one DB-backed test. Spend nothing more on rotation, events or planned-provider scaffolding until a customer has connected.

## UI review

### What is good

Loading, empty and error states are distinct on every data view and never invent data. Action buttons disable and relabel in flight, then toast on success or failure. `googleIntegrations.ts` strips raw API JSON before it reaches a toast, secrets are never stored client-side, and the new hover cards are keyboard-reachable, touch-aware, and dismiss on scroll. Light and dark palettes are complete at the token level.

### Screen by screen

**Marketing page.** Light ground, serif display, blue accent. Strong copy. Two problems: the hero starts hidden and fades in, so the first paint shows only the eyebrow (observed); and the only calls to action are "Docs" and "Log in", with no way to request access.

**Sign-in.** A different brand from both the marketing page and the dashboard: near-black ground, cyan-to-blue gradient button, hardcoded hex values (`styles.css:345-440`) outside the token system. Wrong-password error appears in place and is clear. The footer says "pre-alpha".

**Shell.** Rail, breadcrumb, ⌘K hint, theme toggle. The theme toggle is not persisted (`shell.ts:124-127`), so an explicit dark choice reverts on reload. At widths under 860px the rail is `display: none` and nothing replaces it, so a phone user is trapped on whichever screen they landed on. Icon-only buttons have `title` and no `aria-label`; the active route has no `aria-current`. Route render errors print the raw JavaScript message (`shell.ts:193`).

**Pulse.** Score, band, three cells. The design system and the `pulse.html` mockup specify top wins, top risks and a trend with confidence band; those styles exist unused in `styles.css:105-132`. The empty state is honest and useless because there is no control that populates it.

**Clients.** Fine as a grid. Creation through `window.prompt()`. Selecting a project does not select its account (B1).

**Audit.** Broken layout (B5).

**Fix Queue.** Clean kanban, works on mobile as a two-by-two. No diff preview (B6). "Deploy" on a GitHub target fails with an env var name in the toast.

**Entity Graph.** Works after the audit runs. Four bars and a percentage. Score colour is a hardcoded hex, not a token.

**Competitors, Backlinks, Local SEO.** Honest empty states, each telling the customer to do something with no control for it.

**Integrations.** With an account selected the three Google cards are well designed: three states, badges with hover cards, disabled connect with a reason. Below them the operator panel (B3).

**Settings.** Asks a customer for an "API base URL" and a "Project ID (project uuid)". Neither belongs on a customer screen. The deploy target form is the right idea and needs the GitHub App model (B7).

**Copilot.** Opens on ⌘K, no motion, no `role="dialog"`, focus does not move into the input.

### Design engineering

The application layer is disciplined; the interaction layer is missing the basics that make the best products feel responsive.

| Before | After | Why |
|---|---|---|
| No `:active` rule anywhere in `styles.css` | `.btn:active, .card-act:active, .iconbtn:active, .navitem:active { transform: scale(.97); transition: transform 100ms var(--ease); }` | Press feedback on pointer-down is the first thing a hand notices. Nothing in the app responds to a press today. |
| `.field { outline: none; transition: border-color .12s }` (`styles.css:275`), same at `.copilot-input:focus`, `.ci-select:focus` | Add `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }` | A 1px border tint on a 1px-bordered field is not a focus ring. The design system requires a visible ring on every control. |
| Every `:hover` rule applies on touch devices | Wrap hover rules in `@media (hover: hover) and (pointer: fine)` | Taps leave stuck hover fills on phones. |
| `.copilot-overlay { display: none } .open { display: flex }` (`styles.css:454-455`) | Overlay fades, panel rises 6px and fades over 140ms with `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)`; skip on `prefers-reduced-motion` | The design system specifies this motion. Opening is keyboard-initiated, so keep it under 150ms. |
| `.app.rail-collapsed { grid-template-columns: 60px 1fr }` snaps; labels `display: none` | Transition the column width over 180ms; fade labels via opacity before removing from flow | The one structural layout change in the app has no motion while everything else has 120ms. |
| Toast driven by `setTimeout(10)` to add `.in`, `setTimeout(2600)` to remove, `setTimeout(200)` to unmount (`shell.ts:98-106`) | Add `.in` in `requestAnimationFrame`; unmount on `transitionend` with a fallback; use `translateY(100%)` for the resting-off position | Chained timers duplicate what the CSS transition already knows and break the moment a duration changes. |
| `--ease: cubic-bezier(0.2, 0, 0, 1)` as the only curve | Add `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)` for enters and `--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1)` for on-screen moves | One curve for everything flattens the motion vocabulary. |
| `.eg-score.good { color: #16a34a }`, `.eg-comp-fill.*`, `.ci-impact.*`, `.off-auth.*` hardcode green, amber and red (`styles.css:495-542`) | Use `var(--good)`, `var(--watch)`, `var(--risk)` | The same page shows two different greens, and the hardcoded ones ignore the dark palette. |
| `@media (prefers-reduced-motion: reduce) { * { transition-duration: .01ms !important } }` (`styles.css:563`) | Keep as a safety net; keep opacity and colour transitions; remove transform-based motion explicitly | The blanket rule will also kill comprehension-aiding fades once real motion exists. |
| `.card-act { width: 100% }` reused inside `.frow` | Give the audit row its own `.frow-act` with intrinsic width | Root cause of the Audit layout break (B5). |
| `class: 'btn ghost'`, `class: 'num muted'` (`competitors.ts:104`, `offsite.ts:61`) | Define the classes or remove them | Dead style hooks that silently fall back. |
| Sign-in screen hex palette (`styles.css:345-440`) | Rebuild on the dashboard tokens, keep one accent | Three visual identities across marketing, sign-in and product read as three products. |

### Typography and copy

Body is `ui-sans-serif, system-ui` at 14px with mono for numbers, which is the right call for a dense tool. Headings use `-0.01em` tracking at 20px; the hero score at 46px uses `-0.02em`, which is correct. Two issues: the page subtitles explain implementation ("each transition is written to Postgres") instead of what the customer can do, and several labels are engineering nouns ("Platform wiring", "External integrations", "Deploy target", "Project ID"). Rename toward the customer's vocabulary: "Where fixes go", "Your site", "Connected accounts".

## Docs and changelog claims the code contradicts

- Six AI engines monitored — two adapters exist.
- "Copilot is generally available, ask in plain language" — no model call in the hot path.
- "Backlink and mention index" — no link data.
- "M1.3 done, real Playwright crawler live" — live as a local CLI only.
- "M1.1 data spine live" with ClickHouse — everything is Postgres.
- M1.6 onboarding and M1.7 billing "blocked on external accounts" — the blocker is that neither has a UI.
- Confidence bands on all AI charts — only Pulse renders a band.

Correct these in `docs/10-Roadmap.md` and the public changelog before a customer reads them.

## Security and platform notes

- `/auth/login` has no rate limit or lockout; PBKDF2 cost is the only brute-force control (`index.ts:299-337`).
- Crawled page text goes verbatim into the rewrite prompt and the model output becomes a deployable diff (`packages/actions/src/content.ts:38-88`). Delimit the input and require human review of content rewrites; do not allow one-click deploy for that type.
- No error reporting or request ids anywhere; `console.error` only. Add a Sentry-style sink and a request id header before customers report bugs you cannot find.
- Account scoping is consistent through `projectAccessError`; `AUTH_MODE=disabled` is correctly limited to loopback hosts.

## Recommended order of work

1. **Week 1 — make the loop reachable.** Onboarding form (account, project, entity, domain). "Run audit" button backed by a crawl runner outside Workers. Fix account selection on project click. Fix the report token. Apply 0017/0018 and add the CI migrate step. Purge internal language and the operator panel. Fix the Audit row layout and group findings by issue.
2. **Week 2 — make the loop trustworthy.** Diff preview on every Fix Queue card, with a quality floor on generated titles, descriptions and schema. GitHub App per account. Schedule rank and AI polls per project and expose keyword and prompt management. Wire GSC and GA4 into Pulse.
3. **Week 3 — make it feel excellent.** Press states, focus rings, hover gating, Copilot and rail motion, persisted theme, mobile navigation, one design language across marketing, sign-in and product, Pulse wins and risks per the mockup, replace `prompt()` with a modal.
4. **Before invoicing anyone.** Plan limit enforcement, an upgrade screen, login rate limiting, error reporting.

## Appendix — reproducing the walkthrough locally

Postgres 16 is installed via Homebrew but not running. The review used an isolated cluster in the session scratchpad:

```bash
LANG=C LC_ALL=C /opt/homebrew/opt/postgresql@16/bin/initdb -D <dir> -U engine --auth=trust -E UTF8 --locale=C
```

```bash
/opt/homebrew/opt/postgresql@16/bin/pg_ctl -D <dir> -o "-p 5433 -k /tmp -c listen_addresses=127.0.0.1" start
```

Then `createdb -h 127.0.0.1 -p 5433 -U engine engine`, `DATABASE_URL=postgres://engine@127.0.0.1:5433/engine pnpm db:migrate`, and an `apps/api/.dev.vars` with `DATABASE_URL`, `LOCAL_AUTH_SECRET`, `LOCAL_AUTH_USERS`, `ENCRYPTION_KEY`, `OAUTH_STATE_SECRET`. The launch configs in `.claude/launch.json` start the API on 8787 and the site on 4321. The crawler runs with:

```bash
ENGINE_API_TOKEN=<session token> node packages/crawler/dist/cli.js --url http://localhost:4321 --project <id> --entity <id> --api http://localhost:8787 --max-pages 12
```

A dev `.dev.vars` with placeholder secrets was left in `apps/api/` (gitignored). The scratchpad database is session-local and can be deleted.
