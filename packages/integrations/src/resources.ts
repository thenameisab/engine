/**
 * "What can this connection be pointed at?" — one answer shape, many vendors.
 *
 * This is the piece the registry could not make into data. Endpoints and scopes
 * are declarative; turning a vendor's own listing response into "things a
 * project can be assigned to" is code, because every vendor describes it
 * differently. A Search Console property is a `siteUrl` string with a
 * permission level, a Cloudflare zone is an id plus a name, a Bing site is a
 * bare URL, and GBP locations live two levels deep under accounts.
 *
 * So listers are registered against a provider id rather than being switched on
 * inside the route. The route asks the registry and renders whatever comes
 * back; adding a provider's lister does not touch it.
 *
 * `selectable: false` exists because "we can see it but you cannot use it" is a
 * real and common state — a Search Console property with read-only-restricted
 * access, a zone the token cannot edit. Offering it and failing later is worse
 * than showing it greyed out with the reason.
 */
import { IntegrationError } from './errors.js';
import { vendorFetch, parseJson, type HttpOptions } from './http.js';
import { applyApiKey, type ApiKeyCredential } from './credentials.js';
import type { IntegrationProvider } from './types.js';

export interface ProviderResource {
  /** The vendor's own identifier, stored verbatim so a later call needs no reconstruction. */
  id: string;
  /** What the picker shows. */
  label: string;
  /** False when the connection can see it but cannot use it. */
  selectable: boolean;
  /** Why, or extra context — a permission level, a store code, a locality. */
  detail?: string;
}

export interface ResourceListing {
  resources: ProviderResource[];
  /** True when the vendor had more than we fetched, so the UI can say so. */
  truncated: boolean;
}

/** How a lister is called. Exactly one of the credentials is present. */
export interface ListerContext {
  provider: IntegrationProvider;
  /** For an OAuth provider: a freshly minted access token. */
  accessToken?: string;
  /** For an API-key provider: the opened credential. */
  apiKey?: ApiKeyCredential;
  http?: HttpOptions;
}

export type ResourceLister = (ctx: ListerContext) => Promise<ResourceListing>;

const LISTERS = new Map<string, ResourceLister>();

/**
 * Register a lister for a provider.
 *
 * Called at module load by whoever owns the vendor's client — the API layer for
 * Google, this file for the vendors whose listing is a single REST call.
 * Re-registering replaces, so a host can override one without forking.
 */
export function registerLister(providerId: string, lister: ResourceLister): void {
  LISTERS.set(providerId, lister);
}

export function getLister(providerId: string): ResourceLister | undefined {
  return LISTERS.get(providerId);
}

/** Provider ids that can currently populate a picker. */
export function providersWithListers(): string[] {
  return [...LISTERS.keys()].sort();
}

/**
 * List a provider's resources, or fail in a way the route can render.
 *
 * A registry provider with no lister is a 'not_configured' failure rather than
 * an empty list: an empty picker says "this account has nothing", which is a
 * different and misleading claim.
 */
export async function listResources(ctx: ListerContext): Promise<ResourceListing> {
  const lister = LISTERS.get(ctx.provider.id);
  if (!lister) {
    throw new IntegrationError(
      'not_configured',
      `${ctx.provider.name} has no resource listing implemented yet`,
      { providerId: ctx.provider.id },
    );
  }
  return lister(ctx);
}

/* ── Listers whose vendor call is a single authenticated GET ─────────────── */

function requireApiKey(ctx: ListerContext): ApiKeyCredential {
  if (!ctx.apiKey) {
    throw new IntegrationError('invalid_credentials', `${ctx.provider.name} needs a stored API key`, {
      providerId: ctx.provider.id,
    });
  }
  return ctx.apiKey;
}

/**
 * Bing Webmaster Tools — the verified sites on the key's account.
 *
 * The response is `{ d: [...] }`: this is an old WCF JSON endpoint and `d` is
 * its envelope, not a field anyone chose. Unwrapped here so nothing downstream
 * has to know that.
 */
registerLister('bing-webmaster', async (ctx) => {
  const credential = requireApiKey(ctx);
  const { url, headers } = applyApiKey(
    ctx.provider,
    credential,
    'https://ssl.bing.com/webmaster/api.svc/json/GetUserSites',
  );
  const res = await vendorFetch(url, { method: 'GET', headers }, { ...ctx.http, providerId: ctx.provider.id });
  if (!res.ok) {
    throw new IntegrationError(
      res.status === 401 || res.status === 403 ? 'invalid_credentials' : 'vendor_error',
      `Bing Webmaster returned HTTP ${res.status}: ${res.text.slice(0, 200)}`,
      { providerId: ctx.provider.id, status: res.status },
    );
  }
  const body = parseJson<{ d?: { Url?: string; IsVerified?: boolean }[] }>(
    res,
    'Bing Webmaster site listing',
    ctx.provider.id,
  );
  const resources = (body.d ?? [])
    .filter((s): s is { Url: string; IsVerified?: boolean } => typeof s.Url === 'string')
    .map((site) => ({
      id: site.Url,
      label: site.Url,
      // An unverified site returns no data at all, so offering it would produce
      // a connection that looks fine and reports nothing.
      selectable: site.IsVerified !== false,
      detail: site.IsVerified === false ? 'not verified in Bing Webmaster Tools' : undefined,
    }));
  // This endpoint returns every site in one response; there is no paging to
  // truncate, so the flag is honestly false rather than unknown.
  return { resources, truncated: false };
});

/**
 * Cloudflare — the zones the token can see.
 *
 * `per_page=50` and a single page on purpose: a picker showing fifty zones is
 * already past what anyone scrolls, and `truncated` tells the UI to say so
 * rather than silently presenting a partial list as complete.
 */
registerLister('cloudflare', async (ctx) => {
  const credential = requireApiKey(ctx);
  const { url, headers } = applyApiKey(
    ctx.provider,
    credential,
    'https://api.cloudflare.com/client/v4/zones?per_page=50',
  );
  const res = await vendorFetch(url, { method: 'GET', headers }, { ...ctx.http, providerId: ctx.provider.id });
  const body = parseJson<{
    success?: boolean;
    errors?: { message?: string }[];
    result?: { id?: string; name?: string; status?: string; permissions?: string[] }[];
    result_info?: { total_count?: number; count?: number };
  }>(res, 'Cloudflare zone listing', ctx.provider.id);

  if (!res.ok || body.success === false) {
    // Cloudflare answers 200 with success:false as readily as it answers 4xx,
    // so the body has to be consulted rather than the status alone.
    const detail = body.errors?.map((e) => e.message).filter(Boolean).join('; ') || res.text.slice(0, 200);
    throw new IntegrationError(
      res.status === 401 || res.status === 403 ? 'invalid_credentials' : 'vendor_error',
      `Cloudflare returned HTTP ${res.status}: ${detail}`,
      { providerId: ctx.provider.id, status: res.status },
    );
  }

  const resources = (body.result ?? [])
    .filter((z): z is { id: string; name: string; status?: string } => typeof z.id === 'string' && typeof z.name === 'string')
    .map((zone) => ({
      id: zone.id,
      label: zone.name,
      // A zone that is not active cannot serve a rule, so a fix deployed to it
      // would appear to succeed and change nothing.
      selectable: zone.status === undefined || zone.status === 'active',
      detail: zone.status && zone.status !== 'active' ? `zone is ${zone.status}` : undefined,
    }));
  const total = body.result_info?.total_count;
  return { resources, truncated: typeof total === 'number' && total > resources.length };
});
