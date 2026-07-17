/**
 * View-model types for the dashboard. Deliberately self-contained (not imported
 * from @engine/* ) so the browser build has zero cross-package resolution — the
 * dashboard shapes the API's JSON into exactly what each view needs.
 */

/** The A3 unified score with its honest confidence band. */
export interface ScoreBand {
  point: number;
  low: number;
  high: number;
}

export interface ChannelContribution {
  key: 'organic' | 'ai' | 'local';
  label: string;
  /** Present as a band when the channel carries uncertainty (AI Share of Model). */
  value: number;
  low?: number;
  high?: number;
  sub: string;
}

/** The `GET /projects/:id/pulse` response shape (apps/api). */
export interface ApiPulseResponse {
  score: {
    band: { low: number; point: number; high: number };
    decomposition: {
      organic: { score: number; weight: number };
      ai: { score: number; weight: number };
      local: { score: number; weight: number };
    };
  } | null;
  /** The AI surface's own confidence band (Architecture §3.2: never a bare point). */
  aiBand: { low: number; point: number; high: number } | null;
  keywordsTracked: number;
  citationSamples: number;
}

export interface PulseData {
  /**
   * Null when the project has no polled A1/A2 data yet (no keyword poll, no
   * AI-visibility poll) — the API reports `score: null` rather than a 0,
   * which would read as "zero visibility" instead of "nothing measured".
   */
  score: ScoreBand | null;
  contributions: ChannelContribution[];
  /** How much data went into `score`, so the view can say why it's null. */
  keywordsTracked: number;
  citationSamples: number;
}

export type ActionStatus = 'proposed' | 'approved' | 'deployed' | 'verified' | 'rolled_back';

/** An Action exactly as `GET /projects/:id/actions` returns it (apps/api). */
export interface ApiAction {
  id: string;
  findingId: string;
  type: string;
  target: { kind: string; plugin?: string; siteId?: string; workerName?: string; repo?: string; locationId?: string };
  diff: { before: string; after: string; format: string; field?: string };
  status: ActionStatus;
  predictedImpact: number;
}

export interface ActionCard {
  id: string;
  kind: string; // Schema / Robots / Meta / Redirect …
  title: string;
  impact?: number;
  effort?: string;
  status: ActionStatus;
}

/** A `Finding` as `GET /projects/:id/audit` returns it (@engine/core's contract). */
export interface ApiFinding {
  id: string;
  entityId: string;
  source: string;
  issueType: string;
  severity: number;
  predictedImpact: number;
  evidence: { url?: string; nonExecutableReason?: string; [k: string]: unknown };
  actionTemplates: { type: string; label: string; description: string }[];
  createdAt: string;
}

export interface FindingRow {
  id: string;
  type: string;
  title: string;
  severity: 'high' | 'medium' | 'low';
  predictedImpact: number;
  autoFixable: boolean;
  url: string;
}

export interface AuditData {
  /**
   * Null when the project has never been audited. The API reports the score of
   * the newest recorded run, and there isn't one — a project with no crawl has
   * no health score, and 100 would read as "your site is perfect".
   */
  healthScore: number | null;
  autoFixableCount: number;
  findings: FindingRow[];
  lastRunAt: string | null;
  pagesAudited: number | null;
}

/** Mirrors @engine/config's ReadinessReport shape (structural, not imported). */
export interface IntegrationReadiness {
  id: string;
  name: string;
  category: string;
  requiredForMvp: boolean;
  status: 'configured' | 'partial' | 'missing';
  missing: { name: string; description: string }[];
  optionalPresent: string[];
}

export interface ReadinessReport {
  integrations: IntegrationReadiness[];
  mvpReady: boolean;
  summary: { configured: number; partial: number; missing: number; total: number };
}

/** One organic SERP result (A1). */
export interface SerpOrganic {
  position: number;
  url: string;
  title: string;
}

/** A live SERP lookup for one keyword (SERP Inspector). */
export interface SerpInspectResult {
  keyword: string;
  country: string;
  vendor: string;
  features: string[];
  organic: SerpOrganic[];
  polledAt: string;
}

/** Whether a view is showing live API data or the built-in sample. */
export type DataSource = 'live' | 'sample';

export interface Loaded<T> {
  data: T;
  source: DataSource;
}
