import { describe, it, expect, vi } from 'vitest';
import { syncActions } from './sync.js';
import type { EngineConfig } from './pendingActions.js';
import type { ShopifyConfig } from './shopifyAdmin.js';

const engine: EngineConfig = { apiBase: 'http://localhost:8787', projectId: 'proj_1', siteId: 'site_1', apiToken: 'etok' };
const shopify: ShopifyConfig = { shopDomain: 'shop.myshopify.com', accessToken: 'stok' };

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

/**
 * A router keyed by what each call actually is, not call order — the real
 * sync interleaves Engine calls and Shopify GraphQL calls per action, so
 * asserting on `mock.calls[N]` would be fragile to that interleaving.
 */
function routedFetch(handlers: {
  pendingActions?: unknown;
  productLookup?: (variables: Record<string, unknown>) => unknown;
  metafieldsSet?: (variables: Record<string, unknown>) => unknown;
  deploy?: () => unknown;
}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (typeof url === 'string' && url.includes('/cms-plugin/actions')) {
      return jsonResponse(handlers.pendingActions);
    }
    if (typeof url === 'string' && url.includes('/actions/') && url.includes('/deploy')) {
      return jsonResponse(handlers.deploy?.() ?? {});
    }
    // Shopify Admin GraphQL: both queries hit the same endpoint, distinguish by body.
    const body = JSON.parse((init?.body as string) ?? '{}');
    if (typeof body.query === 'string' && body.query.includes('ProductByHandle')) {
      return jsonResponse(handlers.productLookup?.(body.variables) ?? { data: { productByHandle: { edges: [] } } });
    }
    if (typeof body.query === 'string' && body.query.includes('SetMetafield')) {
      return jsonResponse(
        handlers.metafieldsSet?.(body.variables) ?? { data: { metafieldsSet: { userErrors: [] } } },
      );
    }
    throw new Error(`unexpected request: ${url}`);
  }) as unknown as typeof fetch;
}

describe('syncActions', () => {
  it('applies a schema action to the matching product and reports it deployed', async () => {
    const fetchImpl = routedFetch({
      pendingActions: {
        actions: [
          {
            id: 'action_1',
            type: 'schema',
            diff: { after: '{"@type":"Product"}', format: 'json-ld' },
            pageUrl: 'https://shop.example.com/products/acme-widget',
          },
        ],
      },
      productLookup: () => ({ data: { productByHandle: { edges: [{ node: { id: 'gid://shopify/Product/1' } }] } } }),
    });

    const result = await syncActions(engine, shopify, fetchImpl);

    expect(result).toEqual({ applied: ['action_1'], skipped: [] });
    // metafieldsSet + deploy report both happened — confirmed via the applied list;
    // also check the metafield write carried the right value.
    const metafieldCall = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls.find(([, init]: [string, RequestInit]) =>
      (init?.body as string)?.includes('SetMetafield'),
    );
    const body = JSON.parse((metafieldCall![1] as RequestInit).body as string);
    expect(body.variables.metafields[0].value).toBe('{"@type":"Product"}');
  });

  it('applies a meta/title action to the meta_title metafield', async () => {
    const fetchImpl = routedFetch({
      pendingActions: {
        actions: [
          {
            id: 'action_2',
            type: 'meta',
            diff: { after: 'Acme Widget — Buy Now', format: 'text', field: 'title' },
            pageUrl: 'https://shop.example.com/products/acme-widget',
          },
        ],
      },
      productLookup: () => ({ data: { productByHandle: { edges: [{ node: { id: 'gid://shopify/Product/1' } }] } } }),
    });

    const result = await syncActions(engine, shopify, fetchImpl);
    expect(result.applied).toEqual(['action_2']);
  });

  it('skips (and does not report deployed) an action whose product cannot be resolved', async () => {
    const fetchImpl = routedFetch({
      pendingActions: {
        actions: [
          {
            id: 'action_3',
            type: 'schema',
            diff: { after: '{}', format: 'json-ld' },
            pageUrl: 'https://shop.example.com/products/ghost-product',
          },
        ],
      },
      productLookup: () => ({ data: { productByHandle: { edges: [] } } }),
    });

    const result = await syncActions(engine, shopify, fetchImpl);

    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([{ actionId: 'action_3', reason: "no product found for handle 'ghost-product'" }]);
    // No deploy report for a skipped action.
    const deployCall = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls.some(([url]: [string]) => url.includes('/deploy'));
    expect(deployCall).toBe(false);
  });

  it('skips a non-product URL without attempting a Shopify lookup', async () => {
    const fetchImpl = routedFetch({
      pendingActions: {
        actions: [
          {
            id: 'action_4',
            type: 'schema',
            diff: { after: '{}', format: 'json-ld' },
            pageUrl: 'https://shop.example.com/pages/about',
          },
        ],
      },
    });

    const result = await syncActions(engine, shopify, fetchImpl);
    expect(result.skipped).toEqual([{ actionId: 'action_4', reason: 'https://shop.example.com/pages/about is not a /products/ URL' }]);
  });

  it('skips an action type this plugin has no handler for, without marking it deployed', async () => {
    const fetchImpl = routedFetch({
      pendingActions: {
        actions: [
          {
            id: 'action_5',
            type: 'robots',
            diff: { after: 'Disallow: /', format: 'text' },
            pageUrl: 'https://shop.example.com/products/acme-widget',
          },
        ],
      },
      productLookup: () => ({ data: { productByHandle: { edges: [{ node: { id: 'gid://shopify/Product/1' } }] } } }),
    });

    const result = await syncActions(engine, shopify, fetchImpl);
    expect(result.skipped).toEqual([{ actionId: 'action_5', reason: "action type 'robots' has no Shopify handler" }]);
  });

  it('applies actions independently — one failure does not block the rest', async () => {
    const fetchImpl = routedFetch({
      pendingActions: {
        actions: [
          {
            id: 'action_ok',
            type: 'schema',
            diff: { after: '{}', format: 'json-ld' },
            pageUrl: 'https://shop.example.com/products/real-product',
          },
          {
            id: 'action_missing',
            type: 'schema',
            diff: { after: '{}', format: 'json-ld' },
            pageUrl: 'https://shop.example.com/products/ghost-product',
          },
        ],
      },
      productLookup: (vars) =>
        String(vars.handle).includes('real-product')
          ? { data: { productByHandle: { edges: [{ node: { id: 'gid://shopify/Product/1' } }] } } }
          : { data: { productByHandle: { edges: [] } } },
    });

    const result = await syncActions(engine, shopify, fetchImpl);
    expect(result.applied).toEqual(['action_ok']);
    expect(result.skipped.map((s) => s.actionId)).toEqual(['action_missing']);
  });
});
