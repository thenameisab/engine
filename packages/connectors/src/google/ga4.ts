/**
 * Google Analytics 4 — entirely new. GA4 appears in the architecture doc's
 * connector list and as PRD D2.1 (AI-referral revenue attribution), but no code
 * for it existed anywhere in the repo.
 *
 * Two APIs, which is the part that catches people out. The **Admin** API lists
 * the properties a user can see — needed to populate the connect-time picker,
 * and easy to forget to enable because it is not the API that returns any
 * actual analytics. The **Data** API runs the reports. A client with only the
 * Data API enabled produces a connect flow with nothing to choose from.
 */
import { googleGet, googlePost, paginate } from './api.js';

const ADMIN_API = 'https://analyticsadmin.googleapis.com/v1beta';
const DATA_API = 'https://analyticsdata.googleapis.com/v1beta';

/** A GA4 property the consenting user can see. */
export interface Ga4Property {
  /** Resource name, `properties/123456789`. Used verbatim as the assignment's resource id. */
  name: string;
  displayName: string;
  /** IANA zone the property reports in — dates in a report are in this zone, not UTC. */
  timeZone?: string;
  currencyCode?: string;
  /** Set when the property is pending deletion; such a property still lists but returns no data. */
  deleted?: boolean;
}

interface AdminAccountSummariesResponse {
  accountSummaries?: {
    account?: string;
    displayName?: string;
    propertySummaries?: { property?: string; displayName?: string }[];
  }[];
  nextPageToken?: string;
}

/**
 * List every GA4 property the token can see, via `accountSummaries`.
 *
 * `accountSummaries` rather than `properties.list` deliberately: the latter
 * requires an account filter, so listing everything means first listing
 * accounts and then querying per account — N+1 calls for a picker. Account
 * summaries return the whole tree in one paged call.
 *
 * Summaries carry no timezone or currency; those need a per-property
 * `getProperty`. The picker does not need them, so they are left absent rather
 * than triggering a call per property to populate a dropdown.
 */
export async function listGa4Properties(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ properties: Ga4Property[]; truncated: boolean }> {
  const { items, truncated } = await paginate<Ga4Property>(async (pageToken) => {
    const url = new URL(`${ADMIN_API}/accountSummaries`);
    url.searchParams.set('pageSize', '200');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const json = await googleGet<AdminAccountSummariesResponse>(
      url.toString(),
      accessToken,
      'accountSummaries.list',
      fetchImpl,
    );
    const properties = (json.accountSummaries ?? []).flatMap((a) =>
      (a.propertySummaries ?? [])
        .filter((p): p is { property: string; displayName?: string } => typeof p.property === 'string')
        .map((p) => ({ name: p.property, displayName: p.displayName ?? p.property })),
    );
    return { items: properties, nextPageToken: json.nextPageToken };
  });
  return { properties: items, truncated };
}

/** Fetch one property's detail, for the timezone a report's dates are expressed in. */
export async function getGa4Property(
  accessToken: string,
  propertyName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Ga4Property> {
  const json = await googleGet<{
    name?: string;
    displayName?: string;
    timeZone?: string;
    currencyCode?: string;
    deleted?: boolean;
  }>(`${ADMIN_API}/${propertyName}`, accessToken, 'properties.get', fetchImpl);
  return {
    name: json.name ?? propertyName,
    displayName: json.displayName ?? propertyName,
    timeZone: json.timeZone,
    currencyCode: json.currencyCode,
    deleted: json.deleted,
  };
}

export interface Ga4ReportOptions {
  /** Inclusive, `YYYY-MM-DD`, or a GA4 relative date like 'NdaysAgo' / 'today'. */
  startDate: string;
  endDate: string;
  /** e.g. ['date', 'sessionDefaultChannelGroup'] */
  dimensions: string[];
  /** e.g. ['sessions', 'engagedSessions', 'conversions', 'totalRevenue'] */
  metrics: string[];
  limit?: number;
  offset?: number;
}

/** One report row: dimension values and metric values, positionally aligned with the request. */
export interface Ga4Row {
  dimensionValues: string[];
  /**
   * Metric values as **numbers**. The Data API returns every metric as a
   * string, including revenue and rates, so parsing here is not a convenience
   * — it is the difference between summing and concatenating downstream.
   */
  metricValues: number[];
}

interface RunReportResponse {
  dimensionHeaders?: { name?: string }[];
  metricHeaders?: { name?: string }[];
  rows?: { dimensionValues?: { value?: string }[]; metricValues?: { value?: string }[] }[];
  rowCount?: number;
}

export interface Ga4Report {
  dimensionHeaders: string[];
  metricHeaders: string[];
  rows: Ga4Row[];
  /** Total matching rows, which can exceed `rows.length` when a limit applied. */
  rowCount: number;
}

/** GA4's per-request row ceiling. */
const MAX_LIMIT = 100_000;

/**
 * Run a GA4 report.
 *
 * A metric GA4 cannot parse as a number becomes 0 rather than NaN — a NaN
 * propagates silently through every later sum and lands in the UI as a blank,
 * which is far harder to trace back than a zero.
 */
export async function runGa4Report(
  accessToken: string,
  propertyName: string,
  options: Ga4ReportOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<Ga4Report> {
  const body = {
    dateRanges: [{ startDate: options.startDate, endDate: options.endDate }],
    dimensions: options.dimensions.map((name) => ({ name })),
    metrics: options.metrics.map((name) => ({ name })),
    limit: String(Math.min(options.limit ?? 10_000, MAX_LIMIT)),
    offset: String(options.offset ?? 0),
  };
  const json = await googlePost<RunReportResponse>(
    `${DATA_API}/${propertyName}:runReport`,
    accessToken,
    body,
    'properties.runReport',
    fetchImpl,
  );
  return {
    dimensionHeaders: (json.dimensionHeaders ?? []).map((h) => h.name ?? ''),
    metricHeaders: (json.metricHeaders ?? []).map((h) => h.name ?? ''),
    rows: (json.rows ?? []).map((r) => ({
      dimensionValues: (r.dimensionValues ?? []).map((v) => v.value ?? ''),
      metricValues: (r.metricValues ?? []).map((v) => {
        const n = Number(v.value);
        return Number.isFinite(n) ? n : 0;
      }),
    })),
    rowCount: json.rowCount ?? (json.rows ?? []).length,
  };
}

/**
 * Name a report row's values, so callers read `row.sessions` rather than
 * `row.metricValues[2]`.
 */
export function namedGa4Row(row: Ga4Row, report: Ga4Report): Record<string, string | number> {
  const named: Record<string, string | number> = {};
  report.dimensionHeaders.forEach((h, i) => {
    named[h] = row.dimensionValues[i] ?? '';
  });
  report.metricHeaders.forEach((h, i) => {
    named[h] = row.metricValues[i] ?? 0;
  });
  return named;
}

/**
 * The channel-group report behind AI-referral attribution (PRD D2.1).
 *
 * `sessionDefaultChannelGroup` is GA4's own channel classification. When this
 * was written it did not isolate AI assistants; migration 0015's comment says
 * so. Checked against a real property in September 2026, GA4 now reports an
 * "AI Assistant" group and put chatgpt.com, claude.ai, perplexity.ai and
 * gemini.google.com in it, while copilot.com still landed in Unassigned. So
 * the source is stored beside the group, and the read side
 * (apps/api/src/repositories/googleMetrics.ts) counts GA4's group plus a short
 * list of known assistant hosts, and says which of the two classified each
 * source. Nothing here claims a channel GA4 does not report.
 */
export async function ga4ChannelReport(
  accessToken: string,
  propertyName: string,
  startDate: string,
  endDate: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Ga4Report> {
  return runGa4Report(
    accessToken,
    propertyName,
    {
      startDate,
      endDate,
      dimensions: ['date', 'sessionDefaultChannelGroup', 'sessionSource'],
      metrics: ['sessions', 'engagedSessions', 'conversions', 'totalRevenue'],
      limit: 50_000,
    },
    fetchImpl,
  );
}
