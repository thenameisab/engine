/**
 * What an integration *is*, independent of any one vendor.
 *
 * The Google-only design this replaces worked because all three providers
 * shared a vendor: one token endpoint, one revocation endpoint, one notion of
 * "the account that consented". A registry with HubSpot and Semrush in it has
 * none of that. HubSpot is OAuth with a different token URL and no
 * `prompt=consent` quirk; Semrush is an API key a user pastes in and no consent
 * screen exists at all.
 *
 * So authentication is a discriminated union rather than an assumption, and
 * everything vendor-specific — endpoints, quirks, scope names — is data on a
 * provider row instead of a branch in the flow. Adding a provider is adding a
 * row. That is the whole point of this file.
 */

/** How a customer proves they own the account being connected. */
export type AuthMethod = OAuth2Auth | ApiKeyAuth | GitHubAppAuth;

export interface OAuth2Auth {
  kind: 'oauth2';
  /** Where the browser is sent for consent. */
  authorizationUrl: string;
  /** Back-channel endpoint for code exchange and refresh. */
  tokenUrl: string;
  /**
   * Endpoint that severs the grant at the vendor. Optional because not every
   * vendor offers one — and the difference is user-visible, so it must not be
   * silently assumed. A disconnect against a provider with no revocation URL
   * deletes our copy and says so, rather than claiming access was revoked.
   */
  revocationUrl?: string;
  /**
   * Extra authorization-request parameters this vendor needs.
   *
   * Google's `access_type=offline` + `prompt=consent` lives here rather than in
   * the flow, because it is a Google quirk: without it Google omits the refresh
   * token on every authorization after the first, and the connection dies
   * silently a day later. Other vendors need other things, and none of them
   * belong in shared code.
   */
  authorizationParams?: Record<string, string>;
  /**
   * Whether the vendor issues a new refresh token on every refresh and expires
   * the old one. When true the store must be updated on each refresh; when
   * false (Google) a refresh response carrying no refresh token is normal and
   * overwriting storage with `undefined` would destroy a working connection.
   */
  rotatesRefreshToken: boolean;
  /**
   * How the client authenticates to the token endpoint. `client_secret_post`
   * puts the credentials in the form body (Google, HubSpot); `client_secret_basic`
   * uses an Authorization header (the OAuth 2.0 default, and what several
   * vendors require).
   */
  clientAuth: 'client_secret_post' | 'client_secret_basic';
  /**
   * Scopes required for this integration to function. Verified against what the
   * vendor actually granted, because a user can untick one on the consent
   * screen and still receive a perfectly valid token.
   */
  scopes: string[];
  /**
   * Scopes that are nice to have. Absence is reported, never treated as
   * failure — this is what keeps "connected, reduced functionality" a real
   * state rather than a broken one.
   */
  optionalScopes?: string[];
}

export interface ApiKeyAuth {
  kind: 'api_key';
  /**
   * The fields the customer pastes in. More than one because a vendor's
   * "API key" is often a pair — an id and a secret, or a key and an account
   * identifier — and asking for them as one blob makes both unvalidatable.
   */
  fields: ApiKeyField[];
  /**
   * How the credential is presented on each call. Data rather than code so
   * that a new vendor does not require a new branch in the request builder.
   */
  placement: ApiKeyPlacement;
  /**
   * A cheap authenticated endpoint used to prove the pasted key works, before
   * anything is stored. Without this, an invalid key is stored happily and
   * surfaces as a failed sync hours later, with nothing pointing at the paste.
   */
  verifyUrl?: string;
}

export interface ApiKeyField {
  /** Stable identifier, used as the key in the submitted credential object. */
  name: string;
  /** What the vendor calls it, shown as the form label. */
  label: string;
  /**
   * True for the value that must never be readable again. A secret field is
   * sealed and never returned by any read; a non-secret one (an account id, a
   * region) is stored in the clear so the UI can show what is configured.
   */
  secret: boolean;
  /** Where the customer finds this value, shown as form help text. */
  help?: string;
  /**
   * Anchored regex the value must match. Rejecting an obviously wrong paste at
   * the form beats a 401 from the vendor an hour later — a leading `sk-` or a
   * fixed length catches the common paste-the-wrong-thing mistake.
   */
  pattern?: string;
}

export type ApiKeyPlacement =
  | { in: 'header'; name: string; prefix?: string }
  | { in: 'query'; name: string };

/**
 * A GitHub App installation — the third arm, and the one that justifies this
 * being a union rather than a flag.
 *
 * It is not `oauth2`: there is no authorization/token URL pair, no code
 * exchange and no refresh token. It is not `api_key`: the customer pastes
 * nothing. The customer picks an account and a set of repositories on
 * GitHub's own screen, and what comes back is an **installation id** — an
 * identifier, not a credential. Nothing per-customer is secret, so nothing
 * per-customer is sealed; the only secret is Engine's App private key, held
 * once in `platform_credentials`.
 *
 * Access is minted per call: a short-lived JWT signed with that private key
 * is exchanged for an installation token good for an hour. So there is also
 * nothing to refresh, nothing to rotate, and nothing that expires quietly in
 * the night.
 */
export interface GitHubAppAuth {
  kind: 'github_app';
  /**
   * Where the browser is sent to choose an account and repositories.
   * `{slug}` is substituted with the App's own slug, read from GitHub at
   * connect time rather than stored — an administrator who renames the App
   * would otherwise leave a link that 404s, and the App itself is the
   * authority on its current slug.
   */
  installUrlTemplate: string;
  /** Base for the vendor's REST API — token minting, repository listing. */
  apiBaseUrl: string;
  /**
   * The permissions the App is expected to hold, for the connect panel to
   * state plainly before someone installs it. Display only: GitHub enforces
   * whatever was actually granted, and this list cannot widen it.
   */
  permissions: string[];
}

/** Broad grouping, used to organise the connect UI. */
export type ProviderCategory =
  | 'search-console'
  | 'analytics'
  | 'local'
  | 'ads'
  | 'crm'
  | 'cms'
  | 'seo-data'
  | 'social'
  // Where a headless site's source lives. Not 'cms': for a repo-backed site
  // the repository *is* the CMS, and a customer looking for GitHub will not
  // look under a heading that names something else.
  | 'code';

/**
 * Whether a provider is offered to customers today.
 *
 * `planned` rows are deliberate: they are the roadmap in the same file the
 * runtime reads, so the connect UI can show what is coming without a second
 * list that drifts. Nothing may be connected against a `planned` provider —
 * `assertConnectable` is the single gate.
 */
export type ProviderAvailability = 'available' | 'beta' | 'planned';

/**
 * What one assignable thing on the provider side is, and how it attaches.
 *
 * `project` — describes a whole site, so a project has exactly one (a Search
 * Console property). `entity` — is itself a place or thing in our graph, so a
 * project can own many (a Business Profile location).
 */
export type ResourceScope = 'project' | 'entity';

export interface IntegrationProvider {
  /** Stable id. Persisted, so it may never change once shipped. */
  id: string;
  /** Product name as the vendor writes it. */
  name: string;
  /** The company behind it, when several providers share one (the three Google ones). */
  vendor: string;
  /** Brand domain, used to fetch a logo. */
  logoDomain: string;
  category: ProviderCategory;
  availability: ProviderAvailability;
  /** What the product does with it, shown in the connect UI. */
  purpose: string;
  auth: AuthMethod;
  /** 'property', 'location', 'portal' — the noun the resource picker uses. */
  resourceNoun: string;
  resourceScope: ResourceScope;
  /**
   * True when the granted access permits writes on the customer's behalf.
   * Surfaced prominently at connect time: a customer agreeing to read their
   * analytics has not agreed to let us edit their Business Profile.
   */
  writes: boolean;
  /**
   * Vendor-side setup a human must complete first — APIs to enable, an app to
   * create. Stated up front, because each one otherwise arrives as a 403 that
   * does not explain itself.
   */
  setupSteps?: string[];
  /**
   * True when the vendor gates the API behind an access request with a quota
   * approval rather than a toggle. Google Business Profile ships with zero
   * quota, so a correct client and a valid token still return 403 until a
   * human request is approved — weeks later.
   */
  requiresAccessRequest?: boolean;
  /**
   * True when connecting this provider changes nothing yet: the credential is
   * verified and a resource can be assigned, and there the path stops — no
   * sync reads from it and no deploy target writes to it.
   *
   * Set per provider rather than inferred, because "no sync" is not the same
   * as "no consumer". Serper has no sync either, and its key is consumed by
   * `resolveSerpKey` on every rank poll; the GitHub App has no sync and is
   * consumed by the 'github-pr' deploy target. These two have neither.
   *
   * Cleared when the consumer ships (Bing sync is deferred to customer
   * demand; see docs/reviews/2026-09-10-action-plan.md).
   */
  syncsNothingYet?: boolean;
  /** Vendor documentation, linked from the connect UI. */
  docsUrl?: string;
}
