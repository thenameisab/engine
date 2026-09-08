/**
 * The three Google integrations a customer connects themselves, and what each
 * one needs from Google.
 *
 * One registry rather than three hardcoded route handlers, because the OAuth
 * dance is identical for all three — only the scope list, the APIs that must be
 * enabled, and the shape of a "resource" differ. The API layer builds a consent
 * URL and handles a callback generically off this table; adding Bing Webmaster
 * later is a new row plus a resource lister, not a fourth copy of the flow.
 */

/** The providers a customer can connect. Matches the `provider` check constraint in migration 0014. */
export type GoogleProvider = 'gsc' | 'ga4' | 'gbp';

export interface GoogleProviderDef {
  id: GoogleProvider;
  name: string;
  /** What the product does with it, shown in the connect UI. */
  purpose: string;
  /** OAuth scopes requested at consent time. */
  scopes: string[];
  /**
   * What one assignable resource is, in the provider's own words — the label
   * the picker uses ("Choose a property" vs "Choose a location").
   */
  resourceNoun: string;
  /**
   * Google Cloud APIs that must be enabled on the OAuth client's project.
   * Surfaced in the UI and docs because a missing API fails at call time with
   * a 403 that does not obviously mean "go tick a box in the console".
   */
  requiredApis: string[];
  /**
   * True when Google gates the API behind an access request with a quota
   * approval, not just an enable toggle. GBP ships with zero quota on a new
   * project, so a correct client and a valid token still return 403 until a
   * human request is approved — worth saying out loud rather than debugging.
   */
  requiresAccessRequest: boolean;
  /** Whether the granted scope permits writes. Only GBP does, for C5's Fix Queue deploys. */
  writes: boolean;
  /**
   * The brand domain a logo is fetched for (logo.dev keys its image API by
   * domain). All three are Google products, so all three carry `google.com`
   * and render the same mark — the product name is what distinguishes the
   * cards. It is a field rather than a hardcoded Google logo in the dashboard
   * because the next provider added here will not be Google's, and it should
   * bring its own mark without a UI change.
   */
  logoDomain: string;
}

export const GOOGLE_PROVIDERS: Record<GoogleProvider, GoogleProviderDef> = {
  gsc: {
    id: 'gsc',
    name: 'Google Search Console',
    purpose: 'Read verified search performance — clicks, impressions, CTR and position per query and page.',
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
    resourceNoun: 'property',
    requiredApis: ['Google Search Console API'],
    requiresAccessRequest: false,
    writes: false,
    logoDomain: 'google.com',
  },
  ga4: {
    id: 'ga4',
    name: 'Google Analytics 4',
    purpose: 'Read sessions, engagement and conversions by channel — the traffic half of AI-referral attribution (D2.1).',
    scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
    resourceNoun: 'property',
    // Two APIs, and the second is the one people forget: Data API runs the
    // reports, but listing a user's properties to populate a picker is the
    // Admin API. Without it the connect flow has nothing to offer.
    requiredApis: ['Google Analytics Data API', 'Google Analytics Admin API'],
    requiresAccessRequest: false,
    writes: false,
    logoDomain: 'google.com',
  },
  gbp: {
    id: 'gbp',
    name: 'Google Business Profile',
    purpose: 'Read location details and reviews for the local audit (B5), and write approved fixes back (C5).',
    // `business.manage` is the only scope Google offers here; there is no
    // read-only variant, so reading reviews for B5 necessarily grants write
    // access too. The consent screen says so, and the Fix Queue's
    // approve-before-deploy gate is what keeps that power from being used
    // without a human decision.
    scopes: ['https://www.googleapis.com/auth/business.manage'],
    resourceNoun: 'location',
    requiredApis: [
      'My Business Account Management API',
      'My Business Business Information API',
      'Google My Business API',
    ],
    requiresAccessRequest: true,
    writes: true,
    logoDomain: 'google.com',
  },
};

/** Narrow an arbitrary string to a known provider id. */
export function isGoogleProvider(value: string): value is GoogleProvider {
  return value === 'gsc' || value === 'ga4' || value === 'gbp';
}

/**
 * True when a connection's granted scopes cover everything the provider needs.
 *
 * Worth checking rather than assuming: a user can untick a scope on the consent
 * screen and Google will still return a perfectly valid token. Catching that at
 * connect time turns a confusing 403 at report time into "you did not grant the
 * Analytics scope — reconnect".
 */
export function hasRequiredScopes(provider: GoogleProvider, granted: readonly string[]): boolean {
  return GOOGLE_PROVIDERS[provider].scopes.every((s) => granted.includes(s));
}
