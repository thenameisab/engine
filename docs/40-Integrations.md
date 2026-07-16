# Engine — External Integrations & Configuration

**Status:** v1.1 · Last updated 2026-07-16
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
| Google Search Console (OAuth) | identity | E1 onboarding (connect GSC) | Google Cloud OAuth client | ⛔ blocked on account |
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
signature gate), and `GET /oauth/gsc/callback` (a Google redirect target).

The gate **fails closed**: an unset `AUTH_JWKS_URL` or an unreachable JWKS
returns `503`, never "allow".

### `INTERNAL_API_TOKEN` — the machine caller

The edge worker (`apps/workers`) calls the API's rollback endpoint on its own
behalf when a deployed fix fails a health check (C1.7 auto-rollback). There is
no user session behind that call, so it presents this shared service token
instead of a JWT. **Bind the same value on both Workers** — without it the API
answers 401 and a bad fix will not roll itself back (the worker logs it).

### `AUTH_MODE=disabled` — local development only

Runs the API unauthenticated so the dashboard works without completing a real
Google sign-in. It is set in local `.dev.vars` and **must never be set on a
deployed Worker**, which holds live SERP/LLM keys and the database URL.

### Trusted origins

Any deployed dashboard origin must be added to Neon Auth's trusted-origins list
or the OAuth callback is rejected (`403 INVALID_CALLBACKURL`).

---

## 3. Google Search Console — OAuth (`GSC_CLIENT_ID`, `GSC_CLIENT_SECRET`, `GSC_REDIRECT_URI`)

**Used for:** E1 onboarding — the user connects their verified GSC property so
we can read search performance (queries, field Core Web Vitals).

**Provisioning:**
1. Create (or reuse) a project in the [Google Cloud Console](https://console.cloud.google.com/).
2. Enable the **Search Console API**.
3. Configure the OAuth consent screen (external, `webmasters.readonly` scope).
4. Create an **OAuth 2.0 Client ID** (type: Web application).
5. Add the authorized redirect URI — it must match `GSC_REDIRECT_URI` and point
   at `/oauth/gsc/callback` exactly.

**Code paths (built, behind these vars):**
`GET /projects/:id/onboarding/gsc/connect-url` builds the consent URL;
`GET /oauth/gsc/callback` exchanges the auth code for tokens. Both `500` clearly
when unconfigured. Token storage lands when there's a real client to test against.

**Cost:** free (API quota is generous for our usage).

---

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
4. Never commit real secrets; set them via `wrangler secret put` (prod) or
   `.dev.vars` (local).
