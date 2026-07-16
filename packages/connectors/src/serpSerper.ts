/**
 * Serper.dev implementation of `SerpConnector` (A1 rank tracking).
 *
 * Serper.dev is the pre-alpha SERP vendor: 2,500 free credits on signup,
 * prepaid credits after (structurally can't bill-shock), Google-native SERP
 * with the features we care about (AI Overview presence, local pack, PAA).
 * The response→`SerpResult` mapping is a pure function so it's unit-testable
 * against recorded fixtures with no live key.
 */
import type {
  SerpConnector,
  SerpQuery,
  SerpResult,
  SerpFeature,
  SerpOrganicResult,
} from './serp.js';

const SERPER_ENDPOINT = 'https://google.serper.dev/search';

/** The subset of Serper.dev's /search response we read. Extra fields are ignored. */
export interface SerperResponse {
  organic?: { title?: string; link?: string; position?: number }[];
  answerBox?: unknown;
  peopleAlsoAsk?: unknown[];
  places?: unknown[];
  shopping?: unknown[];
  knowledgeGraph?: unknown;
  videos?: unknown[];
  aiOverview?: unknown;
  [key: string]: unknown;
}

/** Detect which SERP features are present in a Serper response (A1 SERP-feature chips). */
export function detectSerperFeatures(res: SerperResponse): SerpFeature[] {
  const features: SerpFeature[] = [];
  if (res.answerBox) features.push('featured_snippet');
  if (Array.isArray(res.peopleAlsoAsk) && res.peopleAlsoAsk.length > 0) features.push('people_also_ask');
  if (Array.isArray(res.places) && res.places.length > 0) features.push('local_pack');
  if (Array.isArray(res.shopping) && res.shopping.length > 0) features.push('shopping');
  if (res.knowledgeGraph) features.push('knowledge_panel');
  if (Array.isArray(res.videos) && res.videos.length > 0) features.push('video_carousel');
  // AI Overview presence is the GEO-critical chip; Serper surfaces it as
  // `aiOverview` when Google shows one for the query.
  if (res.aiOverview) features.push('ai_overview');
  return features;
}

/** Pure map: a Serper.dev response + the originating query → our `SerpResult`. */
export function mapSerperResponse(
  query: SerpQuery,
  res: SerperResponse,
  opts: { rawSnapshotRef: string; polledAt: string },
): SerpResult {
  const organic: SerpOrganicResult[] = (res.organic ?? [])
    .filter((o): o is { title: string; link: string; position: number } =>
      typeof o.link === 'string' && typeof o.position === 'number',
    )
    .map((o) => ({ position: o.position, url: o.link, title: o.title ?? '' }));

  return {
    query,
    organic,
    features: detectSerperFeatures(res),
    rawSnapshotRef: opts.rawSnapshotRef,
    polledAt: opts.polledAt,
  };
}

/** Build Serper's request body from a SerpQuery (gl=country, hl=language, location=city). */
export function serperRequestBody(query: SerpQuery): Record<string, unknown> {
  const body: Record<string, unknown> = {
    q: query.keyword,
    gl: query.geo.country.toLowerCase(),
    hl: query.language,
  };
  if (query.geo.city) body.location = query.geo.city;
  // Serper's mobile results come from a distinct SERP; desktop is the default.
  if (query.device === 'mobile') body.device = 'mobile';
  return body;
}

export interface SerperConnectorOptions {
  apiKey: string;
  /** Override for tests / a shared pool. Defaults to global fetch (Workers/Node 18+). */
  fetchImpl?: typeof fetch;
  /**
   * Persist the raw response to the 24-mo raw lake (R2/Parquet) and return its
   * ref. Defaults to a synthetic ref — raw-lake persistence is wired out-of-band.
   */
  rawSink?: (query: SerpQuery, raw: SerperResponse) => Promise<string> | string;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

export class SerperConnector implements SerpConnector {
  readonly vendor = 'serper' as const;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly rawSink: NonNullable<SerperConnectorOptions['rawSink']>;
  private readonly now: () => Date;

  constructor(options: SerperConnectorOptions) {
    if (!options.apiKey) throw new Error('SerperConnector requires an apiKey');
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => new Date());
    this.rawSink =
      options.rawSink ??
      ((query) => `serper:pending:${encodeURIComponent(query.keyword)}:${this.now().toISOString()}`);
  }

  async fetch(query: SerpQuery): Promise<SerpResult> {
    if (query.engine !== 'google') {
      throw new Error(`SerperConnector only supports the 'google' engine (got '${query.engine}')`);
    }
    const resp = await this.fetchImpl(SERPER_ENDPOINT, {
      method: 'POST',
      headers: { 'X-API-KEY': this.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify(serperRequestBody(query)),
    });
    if (!resp.ok) {
      throw new Error(`Serper request failed: ${resp.status} ${await resp.text()}`);
    }
    const raw = (await resp.json()) as SerperResponse;
    const rawSnapshotRef = await this.rawSink(query, raw);
    return mapSerperResponse(query, raw, { rawSnapshotRef, polledAt: this.now().toISOString() });
  }
}
