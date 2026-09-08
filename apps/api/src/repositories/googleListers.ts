/**
 * The Google resource listers, registered against `@engine/integrations`'s
 * lister seam.
 *
 * They live in the API rather than in the library because they depend on
 * `@engine/connectors`' Google API clients, and the library deliberately has no
 * vendor clients in it beyond the ones whose listing is a single REST call.
 * Importing this module registers them; the route then asks the registry
 * instead of branching on a provider id, which is what lets a new provider's
 * picker work with no route change.
 */
import {
  listGscProperties,
  canReadGscProperty,
  listGa4Properties,
  listGbpAccounts,
  listGbpLocations,
} from '@engine/connectors';
import { registerLister, IntegrationError, type ListerContext } from '@engine/integrations';

function requireToken(ctx: ListerContext): string {
  if (!ctx.accessToken) {
    throw new IntegrationError('invalid_credentials', `${ctx.provider.name} needs an access token`, {
      providerId: ctx.provider.id,
    });
  }
  return ctx.accessToken;
}

registerLister('gsc', async (ctx) => {
  const properties = await listGscProperties(requireToken(ctx));
  return {
    resources: properties.map((p) => ({
      id: p.siteUrl,
      label: p.siteUrl,
      // Surfaced so the picker can disable rather than silently offer a
      // property that returns no data.
      selectable: canReadGscProperty(p.permissionLevel),
      detail: p.permissionLevel,
    })),
    // Search Console returns every verified property in one response.
    truncated: false,
  };
});

registerLister('ga4', async (ctx) => {
  const { properties, truncated } = await listGa4Properties(requireToken(ctx));
  return {
    resources: properties.map((p) => ({ id: p.name, label: p.displayName, selectable: true })),
    truncated,
  };
});

registerLister('gbp', async (ctx) => {
  // GBP resources are two levels deep: locations live under an account, so list
  // the accounts and then their locations. Flattened because the picker only
  // ever assigns a location.
  const token = requireToken(ctx);
  const { accounts } = await listGbpAccounts(token);
  const resources: { id: string; label: string; selectable: boolean; detail?: string }[] = [];
  let truncated = false;
  for (const account of accounts) {
    const { locations, truncated: pageTruncated } = await listGbpLocations(token, account.name);
    truncated = truncated || pageTruncated;
    for (const location of locations) {
      resources.push({
        id: location.name,
        label: location.title || location.name,
        selectable: true,
        detail: [account.accountName, location.storeCode, location.locality].filter(Boolean).join(' · '),
      });
    }
  }
  return { resources, truncated };
});
