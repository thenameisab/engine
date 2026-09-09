/**
 * Every integration a customer can connect, as data.
 *
 * The rule this file exists to enforce: **adding a provider is adding a row.**
 * No new route handler, no new column, no new branch in the OAuth flow, no
 * second list in the dashboard. When that stops being true, the seam is wrong
 * and the fix belongs here rather than in a special case at the call site.
 *
 * `planned` rows are in the same table as live ones on purpose. A roadmap kept
 * somewhere else drifts; a roadmap the runtime reads cannot, and the connect UI
 * can show what is coming without anyone maintaining a second copy.
 * `assertConnectable` is the only gate that matters — nothing may be connected
 * against a `planned` row.
 */
import { IntegrationError } from './errors.js';
import type { IntegrationProvider } from './types.js';

/**
 * Google's three, unchanged in behaviour from the flow they replace.
 *
 * `access_type=offline` with `prompt=consent` is a Google quirk carried over
 * verbatim: without `prompt=consent`, Google omits the refresh token on every
 * authorization after the first for a given user, so a customer who reconnects
 * gets an access token that works for an hour and a sync that dies overnight.
 * `include_granted_scopes=true` makes a second Google provider's consent
 * additive rather than replacing the first.
 */
const GOOGLE_AUTHORIZATION_PARAMS = {
  access_type: 'offline',
  prompt: 'consent',
  include_granted_scopes: 'true',
} as const;

const GOOGLE_OAUTH = {
  authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  revocationUrl: 'https://oauth2.googleapis.com/revoke',
  authorizationParams: GOOGLE_AUTHORIZATION_PARAMS,
  // Google does not rotate: a refresh response carries no new refresh token,
  // and the stored one stays valid until the user revokes it.
  rotatesRefreshToken: false,
  clientAuth: 'client_secret_post',
} as const;

/** `openid email` everywhere Google is involved, so the UI can name the account. */
const GOOGLE_IDENTITY_SCOPES = ['openid', 'email'];

export const PROVIDERS: IntegrationProvider[] = [
  {
    id: 'gsc',
    name: 'Google Search Console',
    vendor: 'Google',
    logoDomain: 'google.com',
    category: 'search-console',
    availability: 'available',
    purpose:
      'Read verified search performance — clicks, impressions, CTR and position per query and page.',
    auth: {
      kind: 'oauth2',
      ...GOOGLE_OAUTH,
      scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
      optionalScopes: GOOGLE_IDENTITY_SCOPES,
    },
    resourceNoun: 'property',
    resourceScope: 'project',
    writes: false,
    setupSteps: ['Enable the Google Search Console API on the OAuth client’s Cloud project.'],
    docsUrl: 'https://developers.google.com/webmaster-tools',
  },
  {
    id: 'ga4',
    name: 'Google Analytics 4',
    vendor: 'Google',
    logoDomain: 'google.com',
    category: 'analytics',
    availability: 'available',
    purpose:
      'Read sessions, engagement and conversions by channel — the traffic half of AI-referral attribution.',
    auth: {
      kind: 'oauth2',
      ...GOOGLE_OAUTH,
      scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
      optionalScopes: GOOGLE_IDENTITY_SCOPES,
    },
    resourceNoun: 'property',
    resourceScope: 'project',
    writes: false,
    // The second is the one people forget: the Data API runs the reports, but
    // listing a user's properties to populate the picker is the Admin API.
    // Without it the connect flow has nothing to offer.
    setupSteps: [
      'Enable the Google Analytics Data API.',
      'Enable the Google Analytics Admin API — property listing needs it, reporting alone does not.',
    ],
    docsUrl: 'https://developers.google.com/analytics/devguides/reporting/data/v1',
  },
  {
    id: 'gbp',
    name: 'Google Business Profile',
    vendor: 'Google',
    logoDomain: 'google.com',
    category: 'local',
    availability: 'available',
    purpose: 'Read location details and reviews for the local audit, and write approved fixes back.',
    auth: {
      kind: 'oauth2',
      ...GOOGLE_OAUTH,
      // `business.manage` is the only scope Google offers; there is no
      // read-only variant, so reading reviews necessarily grants write access
      // too. The Fix Queue's approve-before-deploy gate is what keeps that
      // power from being used without a human decision.
      scopes: ['https://www.googleapis.com/auth/business.manage'],
      optionalScopes: GOOGLE_IDENTITY_SCOPES,
    },
    resourceNoun: 'location',
    resourceScope: 'entity',
    writes: true,
    requiresAccessRequest: true,
    setupSteps: [
      'Enable the My Business Account Management, Business Information and Google My Business (v4) APIs.',
      'Submit the Business Profile APIs access request — approval takes weeks and the API returns 403 until it lands.',
    ],
    docsUrl: 'https://developers.google.com/my-business',
  },

  /* ── API-key providers, available ─────────────────────────────────────
     Bing Webmaster and Cloudflare need no vendor registration on Engine's
     side: the customer pastes a key, the API verifies it against the vendor,
     and a resource lister already exists for both. They have no sync yet,
     so connecting them gives the product a verified credential and an
     assigned site or zone, not data on Pulse. */

  {
    id: 'bing-webmaster',
    name: 'Bing Webmaster Tools',
    vendor: 'Microsoft',
    logoDomain: 'bing.com',
    category: 'search-console',
    availability: 'available',
    // Bing is the substrate under Copilot and, until recently, ChatGPT's
    // browsing. For a product whose thesis is AI visibility, second search
    // engine coverage is not a nice-to-have.
    purpose: 'Read Bing search performance and crawl diagnostics — the index behind Copilot.',
    auth: {
      kind: 'api_key',
      fields: [
        {
          name: 'apiKey',
          label: 'API key',
          secret: true,
          help: 'Bing Webmaster Tools → Settings → API access → API key.',
          pattern: '[A-Za-z0-9]{16,64}',
        },
      ],
      placement: { in: 'query', name: 'apikey' },
      verifyUrl: 'https://ssl.bing.com/webmaster/api.svc/json/GetUserSites',
    },
    resourceNoun: 'site',
    resourceScope: 'project',
    writes: false,
    docsUrl: 'https://learn.microsoft.com/en-us/bingwebmaster/getting-access',
  },
  {
    id: 'serper',
    name: 'Serper',
    vendor: 'Serper',
    logoDomain: 'serper.dev',
    category: 'seo-data',
    availability: 'available',
    // Held platform-wide until 2026-09-09. Rank tracking is priced per lookup,
    // so one key on our cost base sets a ceiling on how many keywords every
    // customer together may track. Bring-your-own moves both the cost and the
    // rate limit to the customer who is spending it; `resolveSerpKey` in the
    // API still falls back to the platform key, so a customer who pastes
    // nothing keeps working.
    purpose: 'Track search rankings and read SERP features, including AI Overviews.',
    auth: {
      kind: 'api_key',
      fields: [
        {
          name: 'apiKey',
          label: 'API key',
          secret: true,
          help: 'serper.dev \u2192 Dashboard \u2192 API key.',
          pattern: '[0-9a-f]{32,64}',
        },
      ],
      placement: { in: 'header', name: 'X-API-KEY' },
      // Serper's own balance endpoint: authenticated, free, and the only GET
      // it offers. Verifying against /search would spend a search credit to
      // check a key.
      verifyUrl: 'https://google.serper.dev/account',
    },
    resourceNoun: 'account',
    resourceScope: 'project',
    writes: false,
    docsUrl: 'https://serper.dev/dashboard',
  },
  {
    id: 'github',
    name: 'GitHub',
    vendor: 'GitHub',
    logoDomain: 'github.com',
    category: 'code',
    availability: 'available',
    // The Fix Queue's 'github-pr' target ran on one platform-wide
    // GITHUB_TOKEN: a single token, held by us, that cannot reach two
    // customers' repositories and that no customer would hand over in a form.
    // An App installation is the shape that works — the customer grants
    // access to the repositories they choose, revocable by them, and Engine
    // never holds a token belonging to a person.
    purpose: 'Open approved fixes as pull requests in the repositories you choose.',
    auth: {
      kind: 'github_app',
      installUrlTemplate: 'https://github.com/apps/{slug}/installations/new',
      apiBaseUrl: 'https://api.github.com',
      // What the App asks for, and nothing more: write a branch and a file,
      // open a pull request. No access to Actions, secrets, or other people's
      // repositories.
      permissions: ['Contents: read and write', 'Pull requests: read and write'],
    },
    resourceNoun: 'repository',
    resourceScope: 'project',
    writes: true,
    setupSteps: [
      'Register a GitHub App with Contents and Pull requests write permissions, and paste its App ID and private key into Settings.',
    ],
    docsUrl: 'https://docs.github.com/en/apps/creating-github-apps',
  },
  /* ── Planned ───────────────────────────────────────────────────────────
     Ordered by what the product can already use. Each row is complete enough
     to connect the day it is switched to 'available'; what is missing is the
     resource lister and the sync, not the auth. */

  {
    id: 'gsc-bulk-export',
    name: 'Google Search Console bulk export',
    vendor: 'Google',
    logoDomain: 'google.com',
    category: 'search-console',
    availability: 'planned',
    // The Search Console API caps at 50k rows per query and 16 months of
    // history; the BigQuery bulk export has neither limit. Anyone doing
    // serious query-level analysis hits the cap in week one.
    purpose: 'Read unsampled, unlimited Search Console history from the customer’s BigQuery export.',
    auth: {
      kind: 'oauth2',
      ...GOOGLE_OAUTH,
      scopes: ['https://www.googleapis.com/auth/bigquery.readonly'],
      optionalScopes: GOOGLE_IDENTITY_SCOPES,
    },
    resourceNoun: 'dataset',
    resourceScope: 'project',
    writes: false,
    setupSteps: ['Configure the Search Console bulk data export to BigQuery, then enable the BigQuery API.'],
    docsUrl: 'https://support.google.com/webmasters/answer/12918484',
  },
  {
    id: 'google-ads',
    name: 'Google Ads',
    vendor: 'Google',
    logoDomain: 'google.com',
    category: 'ads',
    availability: 'planned',
    // Paid search query data is the only reliable source of the search terms
    // Search Console redacts, and it prices the keywords the product
    // recommends. It is also how organic recommendations get a cost baseline.
    purpose: 'Read search terms, impression share and keyword cost — the paid mirror of organic demand.',
    auth: {
      kind: 'oauth2',
      ...GOOGLE_OAUTH,
      scopes: ['https://www.googleapis.com/auth/adwords'],
      optionalScopes: GOOGLE_IDENTITY_SCOPES,
    },
    resourceNoun: 'account',
    resourceScope: 'project',
    writes: false,
    setupSteps: ['Apply for a Google Ads API developer token — basic access requires review.'],
    docsUrl: 'https://developers.google.com/google-ads/api/docs/start',
  },
  {
    id: 'wordpress',
    name: 'WordPress',
    vendor: 'WordPress',
    logoDomain: 'wordpress.org',
    category: 'cms',
    availability: 'planned',
    // The Fix Queue's whole claim is deploying into the customer's own surface.
    // WordPress is roughly 40% of the web; a plugin already exists in
    // `plugins/wordpress`, and this is the credential half it lacks.
    purpose: 'Deploy approved on-page fixes into the customer’s WordPress site and roll them back.',
    auth: {
      kind: 'api_key',
      fields: [
        { name: 'siteUrl', label: 'Site URL', secret: false, help: 'https://example.com', pattern: 'https?://[^\\s]+' },
        { name: 'username', label: 'WordPress username', secret: false },
        {
          name: 'applicationPassword',
          label: 'Application password',
          secret: true,
          help: 'Users → Profile → Application Passwords. Not the account password.',
        },
      ],
      // WordPress application passwords are HTTP Basic. The prefix is applied
      // to an already-encoded `user:pass`, assembled by the caller.
      placement: { in: 'header', name: 'authorization', prefix: 'Basic ' },
    },
    resourceNoun: 'site',
    resourceScope: 'project',
    writes: true,
    docsUrl: 'https://developer.wordpress.org/rest-api/',
  },
  {
    id: 'shopify',
    name: 'Shopify',
    vendor: 'Shopify',
    logoDomain: 'shopify.com',
    category: 'cms',
    availability: 'planned',
    purpose: 'Deploy approved product and collection fixes into the customer’s Shopify store.',
    auth: {
      kind: 'oauth2',
      // Shopify's endpoints are per-shop, so these carry a placeholder the
      // connect flow substitutes once the shop domain is known. A provider
      // whose URLs depend on customer input is exactly the case the registry
      // has to admit without every other provider paying for it.
      authorizationUrl: 'https://{shop}.myshopify.com/admin/oauth/authorize',
      tokenUrl: 'https://{shop}.myshopify.com/admin/oauth/access_token',
      rotatesRefreshToken: false,
      clientAuth: 'client_secret_post',
      scopes: ['read_products', 'write_products', 'read_content', 'write_content'],
    },
    resourceNoun: 'store',
    resourceScope: 'project',
    writes: true,
    docsUrl: 'https://shopify.dev/docs/apps/auth/oauth',
  },
  {
    id: 'hubspot',
    name: 'HubSpot',
    vendor: 'HubSpot',
    logoDomain: 'hubspot.com',
    category: 'crm',
    availability: 'planned',
    // Closes the loop the product currently cannot: visibility to pipeline.
    // Without a CRM, "we improved your AI visibility" ends at sessions.
    purpose: 'Read contacts and deals to attribute pipeline to AI and organic visibility.',
    auth: {
      kind: 'oauth2',
      authorizationUrl: 'https://app.hubspot.com/oauth/authorize',
      tokenUrl: 'https://api.hubapi.com/oauth/v1/token',
      // HubSpot rotates: every refresh returns a new refresh token and expires
      // the previous one. Storing the old one back would break the connection
      // on the following refresh.
      rotatesRefreshToken: true,
      clientAuth: 'client_secret_post',
      scopes: ['crm.objects.contacts.read', 'crm.objects.deals.read'],
    },
    resourceNoun: 'portal',
    resourceScope: 'project',
    writes: false,
    docsUrl: 'https://developers.hubspot.com/docs/api/oauth-quickstart-guide',
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    vendor: 'Cloudflare',
    logoDomain: 'cloudflare.com',
    category: 'cms',
    availability: 'available',
    // An edge-level deploy target for customers whose CMS we cannot touch:
    // redirects, headers and robots.txt applied at the edge, reversible in
    // seconds. It is the Fix Queue's escape hatch for locked-down stacks.
    purpose: 'Apply redirects, headers and robots.txt at the edge for sites with no reachable CMS.',
    auth: {
      kind: 'api_key',
      fields: [
        {
          name: 'apiToken',
          label: 'API token',
          secret: true,
          help: 'A scoped token, not a Global API Key. Zone → Edit is enough.',
          pattern: '[A-Za-z0-9_-]{30,}',
        },
      ],
      placement: { in: 'header', name: 'authorization', prefix: 'Bearer ' },
      verifyUrl: 'https://api.cloudflare.com/client/v4/user/tokens/verify',
    },
    resourceNoun: 'zone',
    resourceScope: 'project',
    writes: true,
    docsUrl: 'https://developers.cloudflare.com/fundamentals/api/get-started/create-token/',
  },
  {
    id: 'ahrefs',
    name: 'Ahrefs',
    vendor: 'Ahrefs',
    logoDomain: 'ahrefs.com',
    category: 'seo-data',
    availability: 'planned',
    // Customer-supplied rather than platform-supplied on purpose: backlink
    // data is priced per customer and many already pay for it. Making it
    // bring-your-own keeps it off our cost base.
    purpose: 'Read backlink and referring-domain data from the customer’s own Ahrefs subscription.',
    auth: {
      kind: 'api_key',
      fields: [{ name: 'apiToken', label: 'API token', secret: true, help: 'Ahrefs → Account settings → API keys.' }],
      placement: { in: 'header', name: 'authorization', prefix: 'Bearer ' },
      verifyUrl: 'https://api.ahrefs.com/v3/subscription-info/limits-and-usage',
    },
    resourceNoun: 'workspace',
    resourceScope: 'project',
    writes: false,
    docsUrl: 'https://docs.ahrefs.com/docs/api/reference/introduction',
  },
];

const BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

/** Duplicate ids would make lookups silently resolve to whichever came last. */
if (BY_ID.size !== PROVIDERS.length) {
  const seen = new Set<string>();
  const dupes = PROVIDERS.map((p) => p.id).filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
  throw new Error(`duplicate provider id(s) in the integration registry: ${[...new Set(dupes)].join(', ')}`);
}

export function getProvider(id: string): IntegrationProvider | undefined {
  return BY_ID.get(id);
}

export function listProviders(opts: { includePlanned?: boolean } = {}): IntegrationProvider[] {
  return opts.includePlanned ? [...PROVIDERS] : PROVIDERS.filter((p) => p.availability !== 'planned');
}

/**
 * Resolve an id to a provider that may actually be connected, or fail.
 *
 * The single gate. Every route that touches a credential goes through here, so
 * "is this a real provider" and "is it switched on" are answered in one place
 * rather than being re-derived — and forgotten — per handler.
 */
export function assertConnectable(id: string): IntegrationProvider {
  const provider = BY_ID.get(id);
  if (!provider) {
    throw new IntegrationError('unknown_provider', `unknown integration provider '${id}'`, { providerId: id });
  }
  if (provider.availability === 'planned') {
    throw new IntegrationError('unknown_provider', `${provider.name} is not available to connect yet`, {
      providerId: id,
    });
  }
  return provider;
}

/** Provider ids that exist at all, live or planned. Used by schema validation. */
export function allProviderIds(): string[] {
  return PROVIDERS.map((p) => p.id);
}
