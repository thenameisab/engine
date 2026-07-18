/**
 * A minimal Shopify Admin GraphQL client, scoped to exactly what this plugin
 * needs: resolve a storefront product URL to its Admin API product id, and
 * write a schema/meta fix into that product's metafields.
 *
 * Metafields, not a Script Tag or theme edit: Script Tags inject site-wide
 * JS, not per-product JSON-LD, and a Theme App Extension needs the merchant
 * to place a block in their theme editor — neither fits "no dev ticket"
 * (roadmap C2.2) as directly as writing structured data the merchant's theme
 * can read via `product.metafields.engine_seo.*`. The tradeoff, documented in
 * this plugin's README: rendering the metafield on the storefront still
 * requires a one-time theme change (or a Theme App Extension, a real
 * follow-up) — this plugin makes the data available, not automatically
 * visible, which is an honest scope boundary rather than a promise this slice
 * doesn't keep.
 */
export interface ShopifyConfig {
  shopDomain: string; // e.g. 'my-shop.myshopify.com'
  accessToken: string;
  apiVersion?: string; // defaults to a pinned, known-good version
}

interface GraphQlResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

async function adminGraphQl<T>(
  config: ShopifyConfig,
  query: string,
  variables: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<T> {
  const version = config.apiVersion ?? '2025-01';
  const url = `https://${config.shopDomain}/admin/api/${version}/graphql.json`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': config.accessToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`Shopify Admin API returned HTTP ${res.status}`);
  }
  const body = (await res.json()) as GraphQlResponse<T>;
  if (body.errors?.length) {
    throw new Error(`Shopify Admin API error: ${body.errors.map((e) => e.message).join('; ')}`);
  }
  if (!body.data) {
    throw new Error('Shopify Admin API returned no data');
  }
  return body.data;
}

/**
 * Extract a product handle from a storefront product URL
 * (`https://shop.example.com/products/acme-widget` -> `acme-widget`).
 * Returns null for a URL that isn't a product page — those pages have no
 * Shopify Admin resource to write a metafield onto.
 */
export function productHandleFromUrl(pageUrl: string): string | null {
  try {
    const path = new URL(pageUrl).pathname;
    const match = /\/products\/([^/?#]+)/.exec(path);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

const PRODUCT_BY_HANDLE_QUERY = `
  query ProductByHandle($handle: String!) {
    productByHandle: products(first: 1, query: $handle) {
      edges { node { id } }
    }
  }
`;

/** Resolve a product handle to its Admin API GID (`gid://shopify/Product/…`), or null if not found. */
export async function findProductIdByHandle(
  config: ShopifyConfig,
  handle: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const data = await adminGraphQl<{ productByHandle: { edges: { node: { id: string } }[] } }>(
    config,
    PRODUCT_BY_HANDLE_QUERY,
    { handle: `handle:'${handle}'` },
    fetchImpl,
  );
  return data.productByHandle.edges[0]?.node.id ?? null;
}

const METAFIELDS_SET_MUTATION = `
  mutation SetMetafield($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id key }
      userErrors { field message }
    }
  }
`;

/** Write one Engine-sourced metafield (`engine_seo.<key>`) onto a product. */
export async function setProductMetafield(
  config: ShopifyConfig,
  productId: string,
  key: 'jsonld' | 'meta_title' | 'meta_description',
  value: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const data = await adminGraphQl<{
    metafieldsSet: { userErrors: { field: string[]; message: string }[] };
  }>(
    config,
    METAFIELDS_SET_MUTATION,
    {
      metafields: [
        {
          ownerId: productId,
          namespace: 'engine_seo',
          key,
          type: key === 'jsonld' ? 'json' : 'single_line_text_field',
          value,
        },
      ],
    },
    fetchImpl,
  );
  if (data.metafieldsSet.userErrors.length > 0) {
    const msg = data.metafieldsSet.userErrors.map((e) => `${e.field.join('.')}: ${e.message}`).join('; ');
    throw new Error(`metafieldsSet rejected the write: ${msg}`);
  }
}
