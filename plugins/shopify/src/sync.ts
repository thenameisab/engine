import { fetchPendingActions, reportDeployed, type EngineConfig, type PendingAction } from './pendingActions.js';
import {
  findProductIdByHandle,
  productHandleFromUrl,
  setProductMetafield,
  type ShopifyConfig,
} from './shopifyAdmin.js';

export interface SyncResult {
  applied: string[];
  skipped: { actionId: string; reason: string }[];
}

/**
 * Pull `approved` shopify-targeted actions, write each into the matching
 * product's metafields, and report it deployed. Mirrors the WordPress
 * plugin's `engine_seo_sync_actions()`: best-effort per action, so one
 * unresolvable product doesn't block the rest of the sync.
 */
export async function syncActions(
  engine: EngineConfig,
  shopify: ShopifyConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<SyncResult> {
  const actions = await fetchPendingActions(engine, fetchImpl);
  const result: SyncResult = { applied: [], skipped: [] };

  for (const action of actions) {
    const outcome = await applyOne(action, shopify, fetchImpl);
    if (outcome.ok) {
      await reportDeployed(engine, action.id, fetchImpl);
      result.applied.push(action.id);
    } else {
      result.skipped.push({ actionId: action.id, reason: outcome.reason });
    }
  }

  return result;
}

async function applyOne(
  action: PendingAction,
  shopify: ShopifyConfig,
  fetchImpl: typeof fetch,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!action.pageUrl) {
    return { ok: false, reason: 'no page URL on the finding' };
  }
  const handle = productHandleFromUrl(action.pageUrl);
  if (!handle) {
    return { ok: false, reason: `${action.pageUrl} is not a /products/ URL` };
  }

  const productId = await findProductIdByHandle(shopify, handle, fetchImpl);
  if (!productId) {
    return { ok: false, reason: `no product found for handle '${handle}'` };
  }

  if (action.type === 'schema') {
    await setProductMetafield(shopify, productId, 'jsonld', action.diff.after, fetchImpl);
    return { ok: true };
  }
  if (action.type === 'meta' && action.diff.field === 'title') {
    await setProductMetafield(shopify, productId, 'meta_title', action.diff.after, fetchImpl);
    return { ok: true };
  }
  if (action.type === 'meta' && action.diff.field === 'description') {
    await setProductMetafield(shopify, productId, 'meta_description', action.diff.after, fetchImpl);
    return { ok: true };
  }

  // Other action types (redirect/robots/content/gbp) aren't this plugin's
  // job; leaving them unreported (not marked deployed) rather than silently
  // dropping them means they stay visible in the Fix Queue for another path.
  return { ok: false, reason: `action type '${action.type}' has no Shopify handler` };
}
