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

/** A project's deploy target (packages/core's DeployTarget), as the API stores/returns it. */
export interface DeployTarget {
  kind: 'cms-plugin' | 'edge-worker' | 'github-pr' | 'gbp-api';
  plugin?: 'wordpress' | 'shopify';
  siteId?: string;
  workerName?: string;
  repo?: string;
  branch?: string;
  path?: string;
  locationId?: string;
}

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

/** One entity as `GET /projects/:id/entities` returns it (apps/api). */
export interface ApiEntity {
  id: string;
  canonicalName: string;
}

/**
 * `GET /projects/:id/entities/:entityId/copilot/summary` (M2.2) — the
 * entity-first cross-SEO/GEO join: organic rank (A1), AI citation band (A2),
 * and open findings (B1), all keyed on the one entity.
 */
export interface CopilotSummary {
  entityId: string;
  canonicalName: string;
  organic: { sov: number; keywordsTracked: number };
  ai: { band: { low: number; point: number; high: number }; samplesObserved: number };
  topFindings: { id: string; issueType: string; predictedImpact: number; evidence: { url?: string } }[];
}

/**
 * `POST /projects/:id/copilot/ask` (M2.4) — a natural-language question
 * answered over the same entity-first join, with every figure cited back to
 * its source table and an optional Finding -> Action bridge into the propose
 * route. Mirrors `@engine/copilot`'s `CopilotAnswer`.
 */
export interface CopilotCitation {
  source: 'serp_positions' | 'citation_events' | 'findings';
  label: string;
  ref?: string;
}
export interface CopilotSuggestedAction {
  findingId: string;
  issueType: string;
  actionType: string;
  proposeHref: string;
  label: string;
}
export interface CopilotAnswer {
  intent: 'entity_visibility' | 'organic_vs_ai' | 'top_findings' | 'keyword_rank' | 'unknown';
  entityId?: string;
  answer: string;
  citations: CopilotCitation[];
  drilldown: { kind: 'entity' | 'finding'; id: string }[];
  suggestedAction?: CopilotSuggestedAction;
}

/**
 * B3 Entity & Knowledge Graph Audit — one entity's strength breakdown from
 * `GET/POST /projects/:id/entity-audit`. `score` and each component are 0–1;
 * the components say *why* an entity is weak (missing schema vs. weak
 * corroboration), which is what the view leads with.
 */
export interface EntityStrength {
  entityId: string;
  canonicalName: string;
  score: number;
  components: { wikidata: number; schema: number; sameAsConsistency: number; corroboration: number };
  corroboratingDomains: number;
  updatedAt?: string;
}

/**
 * A5 Competitor Intelligence — the five gap dimensions and one gap row from
 * `GET/POST /projects/:id/entities/:selfEntityId/competitor-audit`. `impact`
 * is 0–1 (share of the competitor set that beats you, or the entity-strength
 * delta); the gap list is the "biggest gaps to close" lead view.
 */
export type GapType = 'keyword-gap' | 'citation-gap' | 'content-gap' | 'entity-gap' | 'backlink-gap';

export interface CompetitorGap {
  type: GapType;
  item: string;
  heldByCount: number;
  heldBy: string[];
  impact: number;
  evidence: Record<string, unknown>;
  updatedAt?: string;
}

export interface CompetitorRef {
  competitorSetId: string;
  entityId: string;
  canonicalName: string;
}

/**
 * A6 Backlink & Mention Index (v1.5) — one citation opportunity from
 * `GET/POST /projects/:id/entities/:selfEntityId/offsite-audit`: a
 * high-authority domain AI engines cite in the category where the entity is
 * absent. `authority`/`impact` are 0–1. The opportunity list is the "citation
 * opportunities" lead view.
 */
export interface CitationOpportunity {
  domain: string;
  authority: number;
  citationCount: number;
  distinctEntities: number;
  impact: number;
  updatedAt?: string;
}

/**
 * B5 Local SEO Audit (v1.5) — one location's local visibility breakdown from
 * `GET /projects/:id/local-audit` (weakest first) and
 * `POST …/entities/:entityId/local-audit`. `score` and each component are 0–1;
 * components say *why* a location scores low (thin GBP vs inconsistent NAP vs
 * unhealthy reviews), which the view leads with.
 */
export interface LocalVisibility {
  entityId: string;
  canonicalName: string;
  score: number;
  components: { gbpCompleteness: number; napConsistency: number; reviewHealth: number };
  reviewsConsidered: number;
  updatedAt?: string;
}

/** M2.5 agency white-label — the branding a report/logo is rendered with. */
export interface ApiAccountBranding {
  companyName?: string;
  logoUrl?: string;
  primaryColor?: string;
}

/** One project as `GET /accounts` nests it under its owning account. */
export interface ApiProject {
  id: string;
  accountId: string;
  name: string;
  domain: string;
  createdAt: string;
}

/** An account with its projects, as `GET /accounts` returns it (apps/api). */
export interface ApiAccount {
  id: string;
  name: string;
  branding: ApiAccountBranding;
  createdAt: string;
  projects: ApiProject[];
}

/** The multi-client grid's view model: one card per account. */
export interface AccountCard {
  id: string;
  name: string;
  branding: ApiAccountBranding;
  projects: ApiProject[];
}

/** Whether a view is showing live API data or the built-in sample. */
export type DataSource = 'live' | 'sample';

export interface Loaded<T> {
  data: T;
  source: DataSource;
}

/* ── Per-account Google integrations (GSC / GA4 / GBP) ─────────────────── */

export type GoogleProviderId = 'gsc' | 'ga4' | 'gbp';

/** Mirrors the API's `/integrations/providers` catalogue entry. */
export interface ProviderCatalogEntry {
  id: GoogleProviderId;
  name: string;
  purpose: string;
  scopes: string[];
  /** 'property' or 'location' — what the picker is choosing. */
  resourceNoun: string;
  requiredApis: string[];
  /** True when Google gates the API behind an access request, not just an enable toggle. */
  requiresAccessRequest: boolean;
  writes: boolean;
}

/**
 * One connected Google account. Note the absence of any token field — the API
 * never returns the stored credential, sealed or otherwise.
 */
export interface IntegrationConnection {
  id: string;
  accountId: string;
  provider: GoogleProviderId;
  googleEmail?: string;
  googleSubject?: string;
  grantedScopes: string[];
  status: 'connected' | 'needs_reauth' | 'revoked';
  connectedBy?: string;
  connectedAt: string;
  lastRefreshAt?: string;
  lastError?: string;
  /** False when the user unticked a scope on Google's consent screen. */
  scopesSufficient: boolean;
}

/** One assignable resource, as the picker shows it. */
export interface ProviderResource {
  id: string;
  label: string;
  /** False for a property the connected account cannot actually read. */
  selectable: boolean;
  detail?: string;
}

export interface IntegrationAssignment {
  id: string;
  connectionId: string;
  provider: GoogleProviderId;
  projectId: string;
  /** Set for gbp only — a location is an entity. */
  entityId?: string;
  resourceId: string;
  resourceLabel?: string;
  createdAt: string;
  lastSyncedAt?: string;
  lastSyncError?: string;
  lastSyncRows?: number;
}

export interface SyncOutcome {
  provider: GoogleProviderId;
  projectId: string;
  resourceId: string;
  rows: number;
  truncated: boolean;
  from: string;
  to: string;
}
