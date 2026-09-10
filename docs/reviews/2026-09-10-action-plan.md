# Action plan after the v1 data build

Date: 2026-09-10. Baseline: `origin/main` after PR #93. Steps 1–8 of
`2026-09-09-v1-data-readiness-plan.md` are merged (#84–#88, #90–#92), plus citation
provenance (#93). This document takes the 17 open issues found after that build, applies the
user's decisions on each, and orders what is left.

Two things were researched rather than assumed, and both changed the plan: Cloudflare can now
send transactional email, and ClickHouse Cloud has no free tier. One issue was investigated and
turned out to be a bug with two causes, not a question.

## 1. The crawl question, answered

The v1 plan left one open question: is production's one-page crawl a thin site or a crawl
defect? **It is a defect, with two independent causes.** Neither is about the customer's site.

Measured on production (read-only) and against the live site:

| Fact | Value |
|---|---|
| Pages crawled for tartanhq.com | 1 (`https://tartanhq.com/`) |
| `internal_link_count` on that page | **0** |
| `body_text` captured | **515 characters** |
| Live site raw HTML | 809 KB |
| Relative links in raw HTML | **0** |
| Visible text in raw HTML | **0 characters** |
| Asset hosts | `framerusercontent.com`, `framer.com` |
| `https://tartanhq.com` | **301 → `https://www.tartanhq.com/`** |

**Cause 1 — the crawler does not wait for client-side rendering.**
`packages/crawler/src/crawlPage.ts:107` navigates with `waitUntil: 'load'`. The site is built
with Framer and is entirely client-rendered: its raw HTML carries no text and no internal links
at all. `load` fires before Framer hydrates and paints, so the crawler captured a pre-hydration
shell — which is exactly what 515 characters and zero links looks like. Every content finding
for this customer is computed over that shell.

**Cause 2 — the same-origin test uses the seed URL, not the final URL.**
`crawlSite.ts:137` derives `origin` from `rootUrl`, and `:118` discards any link whose
`u.origin !== origin`. The seed is `https://tartanhq.com` (origin `https://tartanhq.com`), but
the page served is `https://www.tartanhq.com`. Every internal link on the rendered page is
therefore rejected as off-origin, so discovery finds nothing even once rendering is fixed.

Both need fixing, and cause 2 is invisible until cause 1 is fixed.

## 2. Decisions taken

| # | Issue | Decision |
|---|---|---|
| 1 | Open production sign-up | Close today with `ALLOWED_EMAILS`. Email-code login becomes a feature, not a hotfix. |
| 2 | `GITHUB_DISPATCH_TOKEN` unset | Set it. Steps in §4. |
| 3 | Stripe secrets unset | Intentional while still building. No action. |
| 4 | No email sending | Use Cloudflare Email Service. It can send transactional mail. |
| 5 | No upgrade screen | Not needed until we charge. Folds into billing. |
| 6 | Plan limits not enforced | Deferred to billing, with a known list produced first. |
| 7 | No Bing sync | Stays a user-facing option. Say on screen that no sync exists yet. |
| 8 | MCP | After the product works well. |
| 9 | Ask Engine is weak | Becomes **Driver** — agentic chat, properly researched and scoped. |
| 10 | One cadence for all tiers | Admin-governable, with the defaults recommended in §5. |
| 11 | `entities.urls` empty | Fix. |
| 12 | Postgres as the A1/A2 spine | Stay on Postgres. ClickHouse is not free and not warranted yet (§6). |
| 13 | No login rate limiting | Build, alongside the access work. |
| 14 | No error reporting | Minimal now, user-facing alerts with notifications later. |
| 15 | Stale readiness catalogue | Fix. |
| 16 | Which model the poll uses | Scope as a feature with Driver, not as a bug fix. |
| 17 | Mine brand names, not URLs | Approach in §7. |
| 18 | Production's one-page crawl | Answered above. Now a bug fix. |

## 3. Cloudflare for email and login

**Email sending is available and fits.** Cloudflare Email Service (launched 2025) sends
transactional email from a Worker through a `send_email` binding, with no API keys — and
`apps/api` already runs on Workers. Login codes, invites and password resets are transactional,
which is what the service is for; it is explicitly not for marketing or bulk sends, which we do
not need.

Two prerequisites, both real:

- **The sending domain must be onboarded** (`wrangler email sending enable <domain>`), which
  sets up SPF/DKIM. Not yet done.
- **Wrangler must be upgraded.** `apps/api/package.json` pins `wrangler ^3.99.0`, and the
  `email` subcommand does not exist in 3.x. The repo needs wrangler 4.x.

**On email-code login specifically.** The right shape is an email one-time code through our own
auth, with Cloudflare Email Service as the transport. Today `apps/dashboard/src/auth/` offers
email+password and Google OAuth; adding a code flow is a change to that layer plus the new
transport.

Cloudflare Access one-time PIN is the other option and is rejected: it gates an application for
a known set of people, which suits an internal tool, not customer sign-up for a product that
needs its own accounts, roles and per-account billing.

**Sequencing note.** `ALLOWED_EMAILS` closes the open door in minutes. The login feature does
not need to be rushed to fix a security problem, which means it can be designed properly.

## 4. Setting `GITHUB_DISPATCH_TOKEN`

It is a platform-owned token, never a customer's, and it only lets "Run audit" start the crawl
workflow immediately instead of waiting up to 15 minutes for the schedule.

1. On GitHub: **Settings → Developer settings → Personal access tokens → Fine-grained tokens**,
   new token, **Repository access:** only `thenameisab/engine`, **Permissions →
   Repository → Actions: Read and write**. Nothing else.
2. Then, from the repo root:

```bash
cd apps/api && npx wrangler secret put GITHUB_DISPATCH_TOKEN
```

3. Confirm with `npx wrangler secret list` and `GET /health/integrations`.

This has to be done by someone who can create the token; it cannot be done from here.

## 5. Recommended default cadence (issue 10)

The rhythms differ because the costs and the underlying rates of change differ. Rank positions
genuinely move day to day and each lookup is billed by Serper. AI answers come from a model's
trained knowledge, which changes only when the vendor ships a model — so polling often buys
sampling precision, not fresher truth. The deterministic audits call no vendor at all and are
therefore free to run nightly.

| Work | Free / trial | Paid default | Why |
|---|---|---|---|
| Rank poll | Weekly | **Daily** | Positions move daily; billed per lookup, so tie frequency to the plan. |
| AI answer poll | Monthly | **Weekly** | Model knowledge changes rarely. More often only narrows the band. |
| Deterministic audits (entity, off-site, competitor, local) | Nightly | **Nightly** | No vendor call, idempotent. Already the case after #87. |
| Site crawl | Monthly | **Weekly**, plus on demand and after a deploy | The expensive one, and the trigger that matters is a content change. |

Make these a per-account setting with the table above as defaults, admin-overridable. Needs one
migration and a settings surface. `keyword_configs.cadence` already exists per keyword, so the
account-level policy should set the default a new keyword inherits rather than replace it.

## 6. ClickHouse: not now (issue 12)

**It is not free.** ClickHouse Cloud has no permanent free tier — a 30-day trial with $300 in
credits, then Basic at roughly $66/month at six active hours a day and about $186/month running
continuously, with storage at about $25.30 per TB per month. Self-hosting the open-source
server is free of licence cost but adds a database to operate, which is the opposite of the
current Workers-plus-Neon setup.

**It is not warranted yet.** Current volumes in the largest tables:

| Table | Rows |
|---|---|
| `gsc_query_daily` | 1,350 |
| `ga4_channel_daily` | 720 |
| `findings` | 95 |
| `crawled_pages` | 14 |
| `citation_events` | 11 |
| `serp_positions` | 4 |

Migration 0005's own comment says Postgres is the wrong long-term home *at scale*. At four
figures it is the right home. Paying for a warehouse now buys a data-copy migration and a
monthly bill against no measurable benefit.

**Revisit on a trigger, not a feeling.** Move when either holds: `gsc_query_daily` passes
roughly 50 million rows, or the Pulse rollup's p95 crosses 500 ms against production. Both are
measurable today and neither is close.

## 7. Mining brand names instead of URLs (issue 17)

The evidence for the change: across three category prompts both Sarvam models named competitors
reliably (2–4 per answer) and emitted usable URLs almost never — and one URL that was emitted
parsed to the host `solutions`, which is not a domain. Answers name companies; they do not cite
sources. The off-site audit mines the thing that is not there and ignores the thing that is.

Two sub-problems, and only the second is interesting.

**Names we already know.** #88 made competitors first-class, added by domain and carrying facts.
Matching those names against stored answer text is deterministic, free, and needs no model call
— the same string matching `buildCitationEvent` already does for the customer's own name.

**Names we do not know yet.** This is the real value: discovering that a competitor nobody
tracked is being recommended. An extraction pass over each stored answer, one structured call
per sample against the model we already pay for, returning the company names the answer
mentions. Deterministic matching cannot do this, and it is exactly what a customer wants to be
told.

Shape:

- A new table keyed to the sample — `answer_mentions (citation_event_id, brand, is_self,
  matched_competitor_id)` — so a mention is evidence attached to the answer it came from, and
  re-mining never invents history.
- Share of voice per prompt: how often each brand is named across the same n samples, banded
  with the Wilson interval already used for cited share, so a brand named once in three
  samples is not reported as 33% flat.
- The AI answers screen's opportunity panel becomes "who gets named instead of you", which is
  the question the panel was always trying to answer.

This shares the poll and the migration with issue 16, so the two move together.

## 8. Order

```
Wave 0  config, minutes each ─► Wave 1  crawler + entity urls ─► Wave 2  accounts & access
                                                                          │
                                          Wave 3  measurement ◄───────────┘
                                                    │
                                                    └─► Wave 4  Driver
```

### Wave 0 — today, no feature work (issues 1a, 2, 15, 14a)

- Set `ALLOWED_EMAILS` on the production Worker. Closes open sign-up.
- Create and set `GITHUB_DISPATCH_TOKEN` (§4).
- Drop `OAUTH_STATE_SECRET` from required-for-MVP in `packages/config/src/integrations.ts`; it
  has been auto-generated into `platform_credentials` since #82, so `/health/integrations`
  currently reports a gap that does not exist.
- Turn on Workers observability so production exceptions are visible. Minimal error reporting;
  user-facing alerting waits for the notifications feature.

### Wave 1 — the crawler, and the URLs it should fill (issues 18, 11)

First because every content finding, the Fix Queue, the entity audit and the competitor
comparison are computed over crawled pages, and for the only real customer that is currently
one pre-hydration shell. Fixing this changes what every one of those screens says.

- Wait for client-side rendering, not `load`. A client-rendered site is the common case, not the
  exception, so this is the default behaviour and not an option.
- Resolve the same-origin test against the **final** URL after redirects, so apex-to-www does
  not discard every internal link.
- Re-crawl tartanhq.com and record what coverage actually reports. #90 already ships the
  coverage line; this is the first run whose numbers will be real.
- Populate `entities.urls` from the crawl. It is empty on every row and nothing writes it, which
  is also why `cited_by_domain` from #93 can never fire.

### Wave 2 — accounts and access (issues 1b, 4, 13)

One feature, because they share a transport and a surface: email one-time-code login, invites,
password resets, and login rate limiting. Prerequisites are the wrangler 4.x upgrade and
onboarding the sending domain (§3).

### Wave 3 — what we measure, and how often (issues 16, 17, 10)

- Decide and record the poll's model. #93 makes the switch safe to interpret; the evidence
  favours the conversational model, because `sarvam-105b` named no company in two of three
  category prompts and a metric that cannot vary is not a metric.
- Brand-name mining and share of voice (§7).
- Per-account cadence policy with the defaults in §5.

Scoped as a feature rather than a fix: this is the product's measurement methodology.

### Wave 4 — Driver (issue 9)

The rename of Ask Engine, and a far larger thing than a rename. Today it answers four question
types from a closed taxonomy and replies "I couldn't tell which tracked entity you mean" to
everything else; #86 gave it model *phrasing* over deterministic answers, not model *answering*.

Research and scope before any code. The scoping document has to answer at least:

- **Actions.** Which in-app actions can Driver take, and which through integrations. What
  requires confirmation, what is reversible, and what it must never do unasked.
- **Grounding and citation.** Every marketing figure it quotes must carry the table it came
  from. The existing rule — figures and citations are retrieval-built and never model-authored
  (`packages/copilot/src/answer.ts`) — is the right constraint and should survive the rewrite.
- **Surface.** Top-level entry, and the rich responses: widgets, tables, charts, rich text.
  Which of those the model chooses versus which are templates it fills.
- **Model.** What answers, what plans actions, and what the fallback is when it is unavailable.
- **Trust.** What it does when it does not know, and how a wrong action is undone.

Sequenced last because it should cite trustworthy data, which waves 1 and 3 produce.

### Deferred, each with a trigger

| Work | Trigger |
|---|---|
| Billing, plan limits, upgrade screen (3, 5, 6) | Before the first paying customer. Produce the unenforced-limit list first. |
| Bing sync (7) | Customer demand. Meanwhile say on screen that connecting Bing syncs nothing yet. |
| MCP (8) | After the product works well. |
| ClickHouse (12) | `gsc_query_daily` ≈ 50M rows, or Pulse rollup p95 > 500 ms. |
| Alerts and notifications, full error reporting (14b) | Its own feature, with push and in-app. |

## 9. One honesty gap worth closing early

A customer can connect Bing today: the key verifies and a site is assigned. No sync exists, so
nothing ever appears, and nothing on screen says why. That is the same defect the AI answers
panel was fixed for in #86 — an empty screen that reads as "you have no data" when it means "we
never fetched any". Cheap to fix, and it belongs with Wave 0 rather than waiting for the sync.
