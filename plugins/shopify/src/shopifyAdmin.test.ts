import { describe, it, expect, vi } from 'vitest';
import { productHandleFromUrl, findProductIdByHandle, setProductMetafield } from './shopifyAdmin.js';

describe('productHandleFromUrl', () => {
  it('extracts the handle from a storefront product URL', () => {
    expect(productHandleFromUrl('https://shop.example.com/products/acme-widget')).toBe('acme-widget');
  });

  it('extracts the handle when the URL carries query params', () => {
    expect(productHandleFromUrl('https://shop.example.com/products/acme-widget?variant=1')).toBe('acme-widget');
  });

  it('returns null for a non-product URL', () => {
    expect(productHandleFromUrl('https://shop.example.com/pages/about')).toBeNull();
  });

  it('returns null rather than throwing for an unparseable URL', () => {
    expect(productHandleFromUrl('not a url')).toBeNull();
  });
});

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

describe('findProductIdByHandle', () => {
  it('returns the product GID from a well-formed response', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: { productByHandle: { edges: [{ node: { id: 'gid://shopify/Product/1' } } ] } } }),
    );
    const id = await findProductIdByHandle(
      { shopDomain: 'shop.myshopify.com', accessToken: 'tok' },
      'acme-widget',
      fetchImpl as unknown as typeof fetch,
    );
    expect(id).toBe('gid://shopify/Product/1');

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://shop.myshopify.com/admin/api/2025-01/graphql.json');
    expect((init.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe('tok');
  });

  it('returns null when no product matches', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: { productByHandle: { edges: [] } } }));
    const id = await findProductIdByHandle(
      { shopDomain: 'shop.myshopify.com', accessToken: 'tok' },
      'nope',
      fetchImpl as unknown as typeof fetch,
    );
    expect(id).toBeNull();
  });

  it('throws on a GraphQL error response, naming it', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ errors: [{ message: 'Throttled' }] }));
    await expect(
      findProductIdByHandle(
        { shopDomain: 'shop.myshopify.com', accessToken: 'tok' },
        'x',
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow('Throttled');
  });

  it('throws on a non-2xx HTTP status', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, false, 401));
    await expect(
      findProductIdByHandle(
        { shopDomain: 'shop.myshopify.com', accessToken: 'tok' },
        'x',
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow('HTTP 401');
  });
});

describe('setProductMetafield', () => {
  it('sends the mutation with the right namespace/key/type', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: { metafieldsSet: { userErrors: [] } } }),
    );
    await setProductMetafield(
      { shopDomain: 'shop.myshopify.com', accessToken: 'tok' },
      'gid://shopify/Product/1',
      'jsonld',
      '{"@type":"Product"}',
      fetchImpl as unknown as typeof fetch,
    );

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.variables.metafields[0]).toEqual({
      ownerId: 'gid://shopify/Product/1',
      namespace: 'engine_seo',
      key: 'jsonld',
      type: 'json',
      value: '{"@type":"Product"}',
    });
  });

  it('throws naming the field when Shopify rejects the write', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: { metafieldsSet: { userErrors: [{ field: ['metafields', '0', 'value'], message: 'Invalid JSON' }] } },
      }),
    );
    await expect(
      setProductMetafield(
        { shopDomain: 'shop.myshopify.com', accessToken: 'tok' },
        'gid://shopify/Product/1',
        'jsonld',
        'not json',
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow('metafields.0.value: Invalid JSON');
  });
});
