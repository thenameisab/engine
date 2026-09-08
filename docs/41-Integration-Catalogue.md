# Engine — Customer Integration Catalogue

**Status:** v1.0 · Last updated 2026-09-08
**Companion to:** [Integrations & Configuration](40-Integrations.md) · [Architecture](20-Architecture.md)
**Source of truth in code:** [`packages/integrations/src/registry.ts`](../packages/integrations/src/registry.ts)
— the `PROVIDERS` array drives the connect UI, the API's provider catalogue, and
this document. **Edit the registry, not the copies.**

---

## The distinction this document depends on

Two kinds of integration exist, and conflating them produces the wrong answer to
almost every question about them.

| | Platform integration | Customer integration |
|---|---|---|
| Whose account | Ours | The customer's |
| How it arrives | `wrangler secret put`, once | Connected in the product, at runtime |
| Who can revoke it | An operator | The customer, alone |
| Where it lives | [`packages/config`](../packages/config) | [`packages/integrations`](../packages/integrations) |
| Examples | Postgres, Neon Auth, Stripe, OpenAI, Gemini, **Serper** | GSC, GA4, GBP, and everything below |

Serper sits on the platform side deliberately. SERP data is a feature every
customer gets out of the box, not an account they bring, and the cost is ours.
[`docs/40-Integrations.md`](40-Integrations.md) covers that side. **This document
covers only the customer side.**

---

## Live today

| Provider | Auth | Reads | Writes | Resource |
|---|---|---|---|---|
| Google Search Console | OAuth 2.0 | Clicks, impressions, CTR, position per query and page | — | One property per project |
| Google Analytics 4 | OAuth 2.0 | Sessions, engagement, conversions by channel | — | One property per project |
| Google Business Profile | OAuth 2.0 | Location details, reviews | Approved fixes | Many locations per project |

All three share one Google Cloud OAuth client and differ only by scope.

---

## What to bring in, and why

Ordered by how much the product can already use, not by how easy each is. Every
row is in the registry as `planned`, complete enough to connect the day it is
switched to `available` — what is missing is the resource lister and the sync,
not the authentication.

### 1. Bing Webmaster Tools — API key

The strongest case on this list, and the cheapest to build.

Bing is the index under Microsoft Copilot, and it has been the retrieval
substrate for other assistants at various points. A product whose thesis is *AI
visibility* that measures only Google's index is measuring one of the two places
answers come from. Auth is a single API key pasted from the Bing Webmaster
settings page — no OAuth client, no app review, no quota request.

**Blocked on:** nothing external.

### 2. Google Search Console bulk export — OAuth (BigQuery scope)

The Search Console API caps a query at 50,000 rows and retains 16 months. The
bulk export to BigQuery has neither limit. Any customer doing real query-level
analysis hits the cap in the first week, and the ceiling is invisible until
someone notices the numbers are truncated rather than small.

Reuses the existing Google OAuth client with one added scope.

**Blocked on:** the customer configuring the export on their own Search Console
property, which is a one-time toggle on their side.

### 3. Google Ads — OAuth

Two things nothing else on the list can supply. Search Console redacts
low-volume queries and anonymises a long tail; paid search terms do not. And
keyword cost data puts a number on the recommendations the product already
makes — "this gap is worth £4,000/month of equivalent paid traffic" is a
different sentence from "this gap exists".

**Blocked on:** a Google Ads API developer token. Basic access requires review,
so start the application before the code is needed.

### 4. WordPress — application password

The Fix Queue's entire claim is deploying into the customer's own surface.
WordPress is roughly 40% of the web, and a plugin already exists at
[`plugins/wordpress`](../plugins/wordpress) — what it lacks is the credential
half, which this registry now provides.

Application passwords are the right primitive: per-application, revocable
individually from the user's profile page, and not the account password.

**Blocked on:** nothing external.

### 5. Cloudflare — scoped API token

The escape hatch for customers whose CMS we cannot reach. Redirects, headers and
`robots.txt` applied at the edge, reversible in seconds, with no access to the
origin at all. For an enterprise customer whose CMS sits behind a change
advisory board, this is the difference between the Fix Queue working and not.

Ask for a scoped token, never a Global API Key — the registry's help text says
so, because the Global key authorises everything on the account including
billing and DNS.

**Blocked on:** nothing external.

### 6. Shopify — OAuth (per-shop endpoints)

The commerce half of the CMS story. Worth noting as a design constraint rather
than a footnote: Shopify's OAuth endpoints are per-shop
(`https://{shop}.myshopify.com/admin/oauth/...`), so the registry has to admit a
provider whose URLs depend on customer input. That is handled with a placeholder
the connect flow substitutes, and it is the reason `authorizationUrl` is a
string on the provider rather than a constant in the flow.

**Blocked on:** a Shopify Partner app.

### 7. HubSpot — OAuth

Closes the loop the product currently cannot. Without a CRM, the strongest claim
available is "we improved your visibility, and sessions went up". With one, it
is "we improved your visibility, and it produced this pipeline". For a B2B
buyer, the second is the one that renews the contract.

HubSpot rotates refresh tokens — every refresh returns a new one and expires the
previous. The registry says so (`rotatesRefreshToken: true`) and the library
reads it; getting this wrong breaks the connection on the *second* refresh,
which is a bug that ships green and fails a day later.

**Blocked on:** a HubSpot developer app.

### 8. Ahrefs — API key

Backlink and referring-domain data, on the customer's own subscription rather
than ours. Bring-your-own is the point: this data is expensive per-seat, many
customers already pay for it, and putting it on our cost base would price the
product against a vendor we would be reselling.

**Blocked on:** nothing external.

### Deliberately not on this list

- **Semrush / Moz / Majestic** — the same shape as Ahrefs and the same value.
  Add one, prove the pattern, then add the others as registry rows. Adding three
  competing SEO data vendors before any of them has a consumer is inventory.
- **Yandex / Naver / Baidu webmaster tools** — real, and irrelevant until there
  is a customer in those markets.
- **Social platforms** — the API terms on the major ones do not permit the
  analysis this product would do, and the ones that do have no audience overlap
  with the buyer.

---

## What the library guarantees

Every provider above is connected through
[`packages/integrations`](../packages/integrations), which enforces the
following regardless of vendor.

**Credentials at rest.** AES-256-GCM, sealed under a key held in the Worker
secret store and never written to Postgres. Account id, provider id and
credential kind are bound in as authenticated additional data, so a blob lifted
from one row into another fails to open rather than decrypting into a usable
credential.

**Key rotation without a customer-visible event.** The keyring reads
`version:key` pairs; new credentials seal under the primary, old ones open under
whichever key sealed them, and a read reports `staleKey` so the caller can
re-seal. Before this, rotating the encryption key meant every customer had to
reconnect — which meant in practice it would never be rotated.

**PKCE on every OAuth flow**, including the confidential ones where the letter of
RFC 7636 does not require it. A signed `state` proves the callback belongs to a
flow we started; it does nothing about an authorization code that leaked from
browser history, a Referer header, or a proxy log. With PKCE that code is inert.

**Least privilege, and honesty about it.** Read-only scopes wherever the vendor
offers them. Where one does not — Google Business Profile has no read-only
variant, so reading reviews necessarily grants write access — the registry marks
`writes: true` and the connect UI says so before consent.

**Granted scopes are verified, not assumed.** A user can untick a scope on a
consent screen and still receive a valid token. Caught at connect time this is
"reconnect and accept the Analytics permission"; missed, it is a 403 hours later
with nothing pointing at the cause.

**Secrets never reach a log or a database column.** Vendor error bodies routinely
echo the request back, including the `client_secret` that was sent. Every
`IntegrationError` redacts at construction rather than at logging time, because
the message is copied into logs, columns and API responses by code that has no
reason to remember what it might contain.

**Vendor calls cannot become our outage.** Per-attempt timeouts, a cap on the
response body, retries only on 429 and 5xx, `Retry-After` honoured when sent,
exponential backoff with jitter otherwise, and redirects refused outright on any
request carrying a credential.

**An append-only audit trail.** `integration_events` records connect, refresh,
failure, disconnect and key rotation with the actor — distinguishing a person
from a nightly service, because a sync refreshing a token at 03:15 is not the
person who connected it in March.

---

## Adding a provider

The rule the library exists to enforce: **adding a provider is adding a row.**

1. Add an entry to `PROVIDERS` in
   [`packages/integrations/src/registry.ts`](../packages/integrations/src/registry.ts),
   with `availability: 'planned'`.
2. Add a resource lister — the one genuinely vendor-specific piece, since every
   vendor describes "a thing you can attach to a project" differently.
3. Add the sync that reads it.
4. Switch to `availability: 'available'`.

No migration, no new route, no new column, no branch in the OAuth flow, and no
second list in the dashboard. If a provider cannot be added this way, the seam
is wrong and the fix belongs in the library rather than in a special case at the
call site.
