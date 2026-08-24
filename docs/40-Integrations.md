# Engine — External Integrations & Configuration

**Status:** v1.2 · Last updated 2026-08-24
**Companion to:** [Architecture](20-Architecture.md) · [Roadmap](10-Roadmap.md)
**Source of truth in code:** [`packages/config`](../packages/config) — the `INTEGRATIONS`
registry drives the runtime readiness check, the `.dev.vars.example` template,
and this document. **Edit the registry, not the copies.**

---

## Why this exists

Several Engine capabilities depend on **external accounts** that cannot be
provisioned in code — an OAuth client, a Stripe account, a SERP API key, LLM
API keys. Everything that touches them is built **behind env-var seams** so the
product is fully typecheckable/testable without live credentials, and each
integration **activates the moment its key is present** and degrades cleanly
(HTTP `503`, never a crash) when it is not.

Check what's wired at any time:

```
GET /health/integrations
```

Returns per-integration status (`configured` / `partial` / `missing`), the list
of missing required vars (never their values), and `mvpReady` — true only when
every required-for-MVP integration is fully configured. **Secret values are
never echoed.**

Local dev uses Wrangler's `.dev.vars` (gitignored); production uses
`wrangler secret put`. Copy the committed template to start:

```
cp apps/api/.dev.vars.example apps/api/.dev.vars   # then fill in real values
```

---

## The integrations

| Integration | Category | Needed for | External account | Pre-alpha |
|---|---|---|---|---|
| Postgres (Neon) | data | Everything (operational store) | Neon | ✅ provisioned |
| **Neon Auth (Better Auth)** | identity | Sign-in + the API auth gate | Neon Auth (on the Neon project) | ✅ provisioned |
| **Google integrations (GSC + GA4 + GBP)** | identity | Customers connect their own Google accounts | Google Cloud OAuth client | ⛔ blocked on account |
| Stripe | billing | G3 billing | Stripe account | ⛔ blocked on account |
| **Serper.dev** | serp | A1 rank tracking | Serper.dev | ⛔ needs key |
| **OpenAI** | llm | A2 AI visibility (primary) | OpenAI API | ⛔ needs key |
| **Google Gemini** | llm | A2 AI visibility (2nd engine) | Gemini API | 🟡 optional |

All the code paths exist and are tested against fixtures; each row is "blocked"
only on someone creating the account and pasting the key.

---

## 1. Postgres (Neon) — `DATABASE_URL`

Primary operational store (accounts, projects, entities, findings, actions,
onboarding, subscriptions). Already provisioned: **Neon**, AWS
`ap-southeast-1` (Singapore); identity via **Neon Auth** (see below, synced
into `neon_auth.users_sync`). Bound as a Worker secret — never committed.

---

## 2. Neon Auth — Better Auth (`AUTH_JWKS_URL`, `AUTH_ISSUER`, `AUTH_AUDIENCE`, `INTERNAL_API_TOKEN`, `AUTH_MODE`)

User identity **and** the API's auth gate. Neon Auth is **Better Auth**, not
Stack Auth — a correction worth stating plainly, because the two have entirely
different REST surfaces and the wrong assumption sends you down a dead end.
Already enabled on the Neon project, with Google sign-in configured.

### How the gate works

```
dashboard ──sign-in──▶ Neon Auth (cookie session on its own origin)
dashboard ──GET /token──▶ Neon Auth ──▶ short-lived signed JWT (EdDSA/Ed25519)
dashboard ──Authorization: Bearer <jwt>──▶ apps/api
apps/api  ──verify against JWKS (cached)──▶ allow / 401 / 403
```

The API verifies **signatures against the published JWKS** rather than calling
`/get-session` per request: no shared secret to distribute, and no network hop
on the hot path once the key set is cached in the isolate. `AUTH_JWKS_URL` is
public — it publishes verification keys, not signing keys — so it ships as a
default `var` in `wrangler.toml` and a freshly deployed Worker is gated rather
than open. The logic lives in [`packages/auth`](../packages/auth) and is fully
unit-tested against real generated Ed25519 keys (crypto only, no live account).

**What's gated:** every `/projects/*` and `/accounts/*` route, plus
`/health/integrations` — i.e. everything that touches the database or spends
live SERP/LLM credit. **Deliberately open:** `GET /health` (liveness),
`POST /billing/webhook` (Stripe can't hold a JWT; it has a stronger HMAC
signature gate), `GET /oauth/google/callback` (a Google redirect target), and
`GET /integrations/providers` (a static description of what can be connected).

The gate **fails closed**: an unset `AUTH_JWKS_URL` or an unreachable JWKS
returns `503`, never "allow".

### `INTERNAL_API_TOKEN` — the machine callers

Some callers act on their own behalf, with no user session behind them, so they
present this shared service token instead of a JWT:

| Caller | Call | Without the token |
| --- | --- | --- |
| `apps/workers` (edge worker) | rollback, when a deployed fix fails a health check (C1.7) | API answers 401; a bad fix never rolls itself back (the worker logs it) |
| `packages/crawler` (`engine-crawl`) | `POST /projects/:id/audit`, reporting a finished B1.1 crawl | API answers 401; **every crawl is discarded** and the project gets no findings |

**Bind the same value everywhere.** The edge worker takes it as a Worker secret;
the crawl runner reads it from `ENGINE_API_TOKEN` in its environment (see
`packages/crawler/README.md`).

Because the token is shared, it authenticates *a* trusted machine, not a
specific one — the API records such callers as `service:internal` rather than
guessing which. A caller that wants to be named in the audit log supplies its
own `actor` (e.g. `service:crawl-runner`); that is a self-report from inside the
trust boundary, not a verified identity, and the code says so.

### `AUTH_MODE=disabled` — local development only

Runs the API unauthenticated so the dashboard works without completing a real
Google sign-in. It is set in local `.dev.vars` and **must never be set on a
deployed Worker**, which holds live SERP/LLM keys and the database URL.

### Trusted origins

Any deployed dashboard origin must be added to Neon Auth's trusted-origins list
or the OAuth callback is rejected (`403 INVALID_CALLBACKURL`).

---

## 3. Google integrations — GSC, GA4, GBP (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `ENCRYPTION_KEY`, `OAUTH_STATE_SECRET`, `DASHBOARD_URL`)

**Used for:** customers connecting **their own** Google accounts, in the
product: Search Console performance, GA4 traffic, and Business Profile reads
plus C5 write-back.

### How this differs from every other integration here

Every other row on this page is one credential for the whole deployment — one
`SERPER_API_KEY`, set by us, the same for every customer. That is right for a
vendor key we pay for. It cannot work for a customer's Search Console property,
where the credential belongs to them, arrives at runtime, and must be revocable
by them alone.

So these vars configure the **OAuth client and the crypto**, not the access
itself. The access lives in `integration_connections` (migration 0014), one row
per account per provider, with the refresh token sealed under `ENCRYPTION_KEY`.

```
dashboard ──POST /accounts/:id/integrations/:provider/connect-url──▶ apps/api
apps/api  ──mints a signed `state` (HMAC, 10-min TTL)──▶ returns Google's consent URL
browser   ──consent──▶ Google ──redirect──▶ GET /oauth/google/callback
apps/api  ──verifies `state`, exchanges the code, seals the refresh token──▶ Postgres
```

The callback is **not** behind `requireAuth` — a browser arriving from Google
carries no Authorization header and cannot. The **signed `state`** authenticates
it instead: it names the account and the user, and we minted it minutes ago.
This replaces the old `/oauth/gsc/callback`, whose `state` was a bare project id;
once a callback persists a credential, an unsigned state lets anyone who can
guess a project id bind their own Google account to someone else's project.

### One connection, many projects

Connections are per **account**; `integration_assignments` maps a provider
resource onto a project. An agency consents once with a Google account that can
see forty client properties, then assigns them. Reconnecting does not discard
the mapping. GSC and GA4 are one property per project (a partial unique index
enforces it); GBP is many locations per project, and each assignment names the
**entity** it writes to, because a location is an entity (migration 0013).

Connecting and disconnecting require the account **owner** role — the credential
is shared, so a `member` revoking it would break every project's sync.

### Provisioning

1. Create (or reuse) a project in the [Google Cloud Console](https://console.cloud.google.com/).
2. Enable **all** of these APIs:
   - Search Console API
   - Google Analytics **Data** API **and** Google Analytics **Admin** API — the
     Admin API is how a user's properties are listed for the picker, and is easy
     to miss because it returns no analytics itself.
   - My Business Account Management API, My Business Business Information API,
     and Google My Business API (v4) — reviews and local posts exist only on v4.
3. Configure the OAuth consent screen (External).
4. Create an **OAuth 2.0 Client ID** (type: Web application).
5. Add the authorized redirect URI. It must equal the deployed Worker origin plus
   `/oauth/google/callback`, **byte for byte** — Google compares it exactly, and
   `redirect_uri_mismatch` is the most common first-setup failure.
6. `openssl rand -base64 32` → `ENCRYPTION_KEY`. Generate a second random string
   → `OAUTH_STATE_SECRET`.
7. **Business Profile only:** submit Google's Business Profile API access request.
   New Cloud projects get **zero** quota, so a correct client and a valid token
   still return 403 until a human approves it. Approval commonly takes weeks —
   start it before you need it.

### The verification gate

`webmasters.readonly`, `analytics.readonly` and `business.manage` are all
**sensitive** scopes. Until Google verifies the app, the consent screen shows an
"unverified app" warning and is capped at roughly 100 test users, each added by
email in the console. That is fine for pre-alpha and does **not** work for
self-serve signup.

Verification needs a homepage on a domain you own and have verified, a published
privacy policy, written scope justification, and a demo video; it commonly takes
several weeks. The CASA security assessment applies to restricted scopes
(Gmail/Drive class), not these.

### Rotating `ENCRYPTION_KEY`

Rotating it invalidates **every stored connection** — the sealed tokens can no
longer be opened, and every customer must reconnect. There is no re-wrap path
today. Treat it as a key you do not rotate casually.

### Code paths

`packages/connectors/src/google/` — one provider registry driving the flow for
all three, the OAuth calls, and the GSC/GA4/GBP reads. Every request shape is
unit-tested against an injected `fetch`, so none of it waits on a live client.
`packages/auth/src/secretBox.ts` seals credentials; `oauthState.ts` signs the
state. `apps/api/src/routes/integrations.ts` holds the routes;
`repositories/integrations.ts` is the only place a token is sealed or opened.

### Sync

`POST /projects/:id/integrations/:provider/sync` pulls on demand, and a cron
trigger (`15 3 * * *`) runs the same functions nightly. Metrics land in
`gsc_query_daily`, `gsc_page_daily` and `ga4_channel_daily` (migration 0015);
GBP writes `local_profiles`, which is what B5's audit has been reading from a
hand-written `PUT`.

Every write is an upsert on its natural grain, so a re-sync overwrites rather
than accumulating — without that, a cron firing twice would double every click
count and nothing about the number would look wrong. GSC's window ends three
days back, because Search Console lags about two days and keeps revising for
several more; each run re-fetches the whole window so revisions land.

**Cost:** free. All three APIs have quotas generous for our usage.

## 4. Stripe — billing (`STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_TO_TIER`, `STRIPE_SECRET_KEY`)

**Used for:** G3 billing — subscription lifecycle synced from Stripe webhooks
into our read-model; plan/usage/over-limit enforcement.

**Provisioning:**
1. Create a **Stripe account** (test mode is enough for pre-alpha).
2. Create Products + Prices for the plan tiers; note each **price id**.
3. Set `STRIPE_PRICE_TO_TIER` to a JSON map of price id → `PlanTier`, e.g.
   `{"price_starter_monthly":"starter","price_growth_monthly":"growth"}`.
4. Add a **webhook endpoint** → `POST /billing/webhook`, subscribe to
   `customer.subscription.*`; copy its signing secret into `STRIPE_WEBHOOK_SECRET`.
5. At checkout, stash `metadata.accountId` on the subscription so the webhook
   knows which account to update.
6. `STRIPE_SECRET_KEY` is only needed if/when we make outbound calls (checkout
   sessions, billing portal) — webhook verification does **not** use it.

**Code paths (built + unit-tested, no live account needed):** webhook signature
verification (Web Crypto, no SDK) and the `customer.subscription.*` → `Subscription`
mapper are fully tested. `GET /accounts/:id/plan` returns plan + usage + over-limit.

**Cost:** Stripe charges per-transaction; no fixed fee. Test mode is free.

---

## 5. SERP data — **Serper.dev** (`SERP_PROVIDER`, `SERPER_API_KEY`)

**Used for:** A1 rank tracking — Google SERP positions + features (AI Overview
presence, local pack, PAA, …) per tracked keyword/geo/device.

### Why Serper.dev (the decision)
Chosen for **the most generous free start + no bill-shock**:
- **2,500 free credits** on signup.
- **Prepaid credit model** — you top up credits; it simply stops when they run
  out and never auto-charges you into a surprise bill.
- Google-native SERP with the features we need; dead-simple JSON API;
  ~$0.30–1 per 1k queries to refill.

The `SerpConnector` interface abstracts the vendor (`serper | dataforseo |
serpapi`), so **switching later is a small change** — set `SERP_PROVIDER` and
add the adapter. DataForSEO is the natural "switch-to" at high volume (cheapest
per-query, pure prepaid); SerpApi is the subscription-capped alternative.

**Provisioning:** create a [Serper.dev](https://serper.dev) account → copy the
API key → set `SERPER_API_KEY`. Leave `SERP_PROVIDER` unset (defaults to `serper`).

**Code paths:** `SerperConnector` (response→`SerpResult` mapping is a pure,
fixture-tested function); `POST /projects/:id/rank/poll` fetches live results
or returns `503` when no key is set.

---

## 6. LLM engines — **OpenAI (primary) + Google Gemini (readiness)**

**Used for:** A2 AI visibility — poll LLM engines for answers to tracked
prompts, extract citations/sources, n-sample (3–5) into a confidence band.

### OpenAI — `OPENAI_API_KEY`, `OPENAI_MODEL`
Primary engine. Calls Chat Completions once per sample; citations extracted from
URLs in the answer text (the citation builder already merges structured
grounding sources when a web-search tool is later enabled). Default model is a
current small model; override with `OPENAI_MODEL`.

**Provisioning:** create an [OpenAI API account](https://platform.openai.com/),
fund it, create a key → `OPENAI_API_KEY`.

**Cost:** pay-per-token. Keep the default small model for polling to control cost.

### Google Gemini — `GEMINI_API_KEY`, `GEMINI_MODEL`
Second engine, **built for readiness alongside OpenAI**. Calls `generateContent`;
when the Google Search **grounding** tool is on (default), Gemini returns real
source URIs (`groundingMetadata`) — the GEO-honest citation signal we extract
directly. Default model is a current flash model; override with `GEMINI_MODEL`.

**Provisioning:** get a key from [Google AI Studio](https://aistudio.google.com/)
→ `GEMINI_API_KEY`.

**Cost:** generous free tier; paid beyond it.

**Code paths:** `OpenAIConnector` / `GeminiConnector` (both fixture-tested, no
SDK, portable to Workers); citation extraction is shared and pure. `POST
/projects/:id/ai/poll` polls **every** configured engine and returns per-engine
samples, or `503` when none is configured. Each engine activates independently
on key presence.

---

## Adding or switching a provider

1. Add/adjust the entry in `packages/config/src/integrations.ts` (this updates
   readiness + `.dev.vars.example` + these docs' contract in one place).
2. Regenerate the template: `pnpm --filter @engine/config build && pnpm --filter @engine/config gen:dev-vars`.
3. For a new SERP/LLM vendor, add an adapter implementing the existing
   `SerpConnector` / `LlmEngineConnector` interface and wire it into
   `packages/connectors/src/factory.ts`.
   For a new **customer-connected** provider (Bing Webmaster, say), add a row to
   `GOOGLE_PROVIDERS` in `packages/connectors/src/google/providers.ts` and a
   resource lister — the consent handshake, storage and UI are generic over that
   registry, so there is no second copy of the flow to write.
4. Never commit real secrets; set them via `wrangler secret put` (prod) or
   `.dev.vars` (local).
