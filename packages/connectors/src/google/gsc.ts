/**
 * Google Search Console reads — the half that never existed.
 *
 * The E1 onboarding wizard could send a user through Google's consent screen
 * since M1, but nothing ever queried Search Console afterwards: no connector,
 * no route, no stored data. This is the read path, so a connected property
 * actually produces the clicks/impressions/CTR/position numbers the product
 * has been describing.
 *
 * Two calls: list the user's verified properties (to populate the picker at
 * connect time) and query search analytics (the data itself). Response mapping
 * is pure and fixture-tested; `fetchImpl` is injectable, so both are fully
 * exercised without a live OAuth client.
 */
import { googleGet, googlePost } from './api.js';

const SEARCH_CONSOLE_API = 'https://searchconsole.googleapis.com/webmasters/v3';

/** A property the consenting user can see, and their permission on it. */
export interface GscProperty {
  /** The `siteUrl`, used verbatim as the assignment's resource id. */
  siteUrl: string;
  /**
   * 'siteOwner' | 'siteFullUser' | 'siteRestrictedUser' | 'siteUnverifiedUser'.
   * Kept because a restricted user cannot read all the data, and an unverified
   * one cannot read any — better to grey those out in the picker than to let
   * someone select a property that returns nothing.
   */
  permissionLevel: string;
}

interface SitesListResponse {
  siteEntry?: { siteUrl?: string; permissionLevel?: string }[];
}

/**
 * List the verified properties this token can see, for the connect-time picker.
 *
 * A domain property arrives as `sc-domain:example.com`, a URL-prefix property
 * as `https://example.com/`. Both are returned as-is: they are opaque ids to
 * every later call, and normalising them would break the lookup.
 */
export async function listGscProperties(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GscProperty[]> {
  const json = await googleGet<SitesListResponse>(`${SEARCH_CONSOLE_API}/sites`, accessToken, 'sites.list', fetchImpl);
  return (json.siteEntry ?? [])
    .filter((e): e is { siteUrl: string; permissionLevel?: string } => typeof e.siteUrl === 'string')
    .map((e) => ({ siteUrl: e.siteUrl, permissionLevel: e.permissionLevel ?? 'siteUnverifiedUser' }));
}

/** True when a permission level permits reading performance data at all. */
export function canReadGscProperty(permissionLevel: string): boolean {
  return permissionLevel !== 'siteUnverifiedUser';
}

/** The dimensions we group by. Ordered as Google returns them in `keys`. */
export type GscDimension = 'date' | 'query' | 'page' | 'country' | 'device' | 'searchAppearance';

export interface GscQueryOptions {
  /** Inclusive, `YYYY-MM-DD`. */
  startDate: string;
  endDate: string;
  dimensions: GscDimension[];
  /** 'web' | 'image' | 'video' | 'news' | 'discover' | 'googleNews'. Defaults to 'web'. */
  searchType?: string;
  /** Google's hard cap is 25,000 rows per request. */
  rowLimit?: number;
  startRow?: number;
}

/** One search-analytics row, with its dimension values named. */
export interface GscRow {
  /** Dimension values, positionally matching the requested `dimensions`. */
  keys: string[];
  clicks: number;
  impressions: number;
  /** 0..1 as Google reports it, not a percentage. */
  ctr: number;
  /** 1-indexed average position. */
  position: number;
}

interface SearchAnalyticsResponse {
  rows?: { keys?: string[]; clicks?: number; impressions?: number; ctr?: number; position?: number }[];
}

/** Google's per-request row ceiling. Requesting more is rejected, not truncated. */
const MAX_ROW_LIMIT = 25_000;

/**
 * Query search analytics for one property.
 *
 * Missing numeric fields default to 0 rather than throwing: Google omits
 * `clicks` entirely on a row with no clicks, which is a real and common row,
 * not a malformed one.
 */
export async function queryGscSearchAnalytics(
  accessToken: string,
  siteUrl: string,
  options: GscQueryOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<GscRow[]> {
  const url = `${SEARCH_CONSOLE_API}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  const body = {
    startDate: options.startDate,
    endDate: options.endDate,
    dimensions: options.dimensions,
    type: options.searchType ?? 'web',
    rowLimit: Math.min(options.rowLimit ?? 1000, MAX_ROW_LIMIT),
    startRow: options.startRow ?? 0,
  };
  const json = await googlePost<SearchAnalyticsResponse>(
    url,
    accessToken,
    body,
    'searchAnalytics.query',
    fetchImpl,
  );
  return (json.rows ?? []).map((r) => ({
    keys: r.keys ?? [],
    clicks: r.clicks ?? 0,
    impressions: r.impressions ?? 0,
    ctr: r.ctr ?? 0,
    position: r.position ?? 0,
  }));
}

/**
 * Fetch every row for a query, paging past the 25,000-row ceiling.
 *
 * Search Console pages by `startRow` rather than a page token, so this cannot
 * use the shared `paginate` helper. A short page means the end of the data.
 */
export async function queryGscAll(
  accessToken: string,
  siteUrl: string,
  options: Omit<GscQueryOptions, 'startRow'>,
  fetchImpl: typeof fetch = fetch,
  maxRows = 100_000,
): Promise<{ rows: GscRow[]; truncated: boolean }> {
  const pageSize = Math.min(options.rowLimit ?? MAX_ROW_LIMIT, MAX_ROW_LIMIT);
  const rows: GscRow[] = [];
  for (let startRow = 0; startRow < maxRows; startRow += pageSize) {
    const page = await queryGscSearchAnalytics(
      accessToken,
      siteUrl,
      { ...options, rowLimit: pageSize, startRow },
      fetchImpl,
    );
    rows.push(...page);
    if (page.length < pageSize) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

/**
 * Name the dimension values on a row, so downstream code reads `row.query`
 * instead of `row.keys[1]` and cannot silently break when the dimension order
 * changes.
 */
export function namedGscRow(row: GscRow, dimensions: GscDimension[]): Record<string, string> {
  const named: Record<string, string> = {};
  dimensions.forEach((d, i) => {
    named[d] = row.keys[i] ?? '';
  });
  return named;
}
