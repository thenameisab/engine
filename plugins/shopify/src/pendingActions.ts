/**
 * The Engine-side half of the sync — pulls the same `cms-plugin` pull queue
 * the WordPress plugin polls (`apps/api`'s `GET .../cms-plugin/actions`,
 * scoped by `plugin=shopify` here) and reports a push back via the ordinary
 * `deploy` transition. Kept separate from the Shopify Admin API client
 * (`shopifyAdmin.ts`) so each side is independently testable.
 */
export interface PendingAction {
  id: string;
  type: string;
  diff: { before?: string; after: string; format: string; field?: string };
  pageUrl: string | null;
}

export interface EngineConfig {
  apiBase: string;
  projectId: string;
  siteId: string;
  apiToken: string;
}

export async function fetchPendingActions(
  config: EngineConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<PendingAction[]> {
  const url = `${config.apiBase.replace(/\/$/, '')}/projects/${encodeURIComponent(config.projectId)}/cms-plugin/actions?plugin=shopify&siteId=${encodeURIComponent(config.siteId)}`;
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${config.apiToken}` } });
  if (!res.ok) {
    throw new Error(`fetching pending actions failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { actions?: PendingAction[] };
  return body.actions ?? [];
}

/** Report an applied action's push back to Engine — the same `deploy` transition every deploy path uses. */
export async function reportDeployed(
  config: EngineConfig,
  actionId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const url = `${config.apiBase.replace(/\/$/, '')}/projects/${encodeURIComponent(config.projectId)}/actions/${encodeURIComponent(actionId)}/deploy`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ actor: `shopify-plugin:${config.siteId}` }),
  });
  if (!res.ok) {
    throw new Error(`reporting deploy for ${actionId} failed: HTTP ${res.status}`);
  }
}
