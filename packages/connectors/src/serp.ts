/**
 * The SERP adapter interface (Architecture §1 Layer 1, §3.3).
 * DataForSEO is the primary vendor, SerpAPI the failover; both implement
 * this interface so the poller (A1) never depends on vendor shape.
 * One SerpQuery = one tracked {keyword, geo, device, language} tuple (A1.1-A1.3).
 */
export interface SerpQuery {
  keyword: string;
  geo: { country: string; city?: string; postcode?: string };
  device: 'desktop' | 'mobile' | 'tablet';
  language: string;
  engine: 'google' | 'bing';
}

export type SerpFeature =
  | 'featured_snippet'
  | 'people_also_ask'
  | 'local_pack'
  | 'shopping'
  | 'ai_overview'
  | 'ai_mode'
  | 'knowledge_panel'
  | 'video_carousel';

export interface SerpOrganicResult {
  position: number;
  url: string;
  title: string;
}

export interface SerpResult {
  query: SerpQuery;
  organic: SerpOrganicResult[];
  features: SerpFeature[];
  rawSnapshotRef: string; // pointer into R2/Parquet raw lake, 24-mo retention
  polledAt: string;
}

export interface SerpConnector {
  vendor: 'dataforseo' | 'serpapi';
  fetch(query: SerpQuery): Promise<SerpResult>;
}
