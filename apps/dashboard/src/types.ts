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

/**
 * Findings that share an issue type, one entry per page. Severity and
 * auto-fixability are properties of the issue type, so they live on the group;
 * predicted impact depends on the page, so it stays on each finding.
 */
export interface FindingGroup {
  type: string;
  title: string;
  severity: FindingRow['severity'];
  autoFixable: boolean;
  pageCount: number;
  findings: FindingRow[];
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
  /** Brand domain for the logo, or '' when the integration has no vendor. */
  logoDomain: string;
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

/**
 * A provider id is a plain string now, not a union of the three Google ones.
 *
 * The registry in `@engine/integrations` is the source of truth and it grows;
 * a union here would have to be edited every time it does, which is exactly the
 * coupling the registry exists to remove. The alias is kept so call sites still
 * read as "a provider id" rather than "a string".
 */
export type GoogleProviderId = string;
export type ProviderId = string;

/** One field of an API-key provider's connect form. Never carries a value. */
export interface ProviderField {
  name: string;
  label: string;
  /** Sealed and never readable again. A non-secret field is shown back to the user. */
  secret: boolean;
  help?: string;
  /** Anchored client-side, matching the server's own check. */
  pattern?: string;
}

/** Mirrors the API's `/integrations/providers` catalogue entry. */
export interface ProviderCatalogEntry {
  id: ProviderId;
  name: string;
  vendor?: string;
  purpose: string;
  category?: string;
  /** 'available' | 'beta' | 'planned'. Planned rows are shown but not connectable. */
  availability?: 'available' | 'beta' | 'planned';
  /** How this provider is connected: a consent flow, or a pasted key. */
  authKind?: 'oauth2' | 'api_key';
  /** Present for an api_key provider — the form to render. */
  fields?: ProviderField[];
  scopes: string[];
  /** 'property', 'location', 'zone' — what the picker is choosing. */
  resourceNoun: string;
  /** Vendor-side setup a human must do first. `requiredApis` is the older name. */
  setupSteps?: string[];
  requiredApis: string[];
  /** True when the vendor gates the API behind an access request, not just a toggle. */
  requiresAccessRequest: boolean;
  writes: boolean;
  /** Brand domain for the logo. */
  logoDomain: string;
  docsUrl?: string;
}

/**
 * One connected Google account. Note the absence of any token field — the API
 * never returns the stored credential, sealed or otherwise.
 */
export interface IntegrationConnection {
  id: string;
  accountId: string;
  provider: ProviderId;
  /** 'oauth2' or 'api_key'. Absent once the credential has been cleared. */
  credentialKind?: 'oauth2' | 'api_key';
  /** Non-secret settings of an API-key credential — a site URL, a username. */
  publicFields?: Record<string, string>;
  /**
   * Display label for the connected vendor account — an email for Google, a
   * portal name elsewhere. `googleEmail` is the field's old name, kept
   * optional so a dashboard build can read an API deploy of either vintage:
   * the two halves are never updated in the same instant.
   */
  externalLabel?: string;
  externalSubject?: string;
  googleEmail?: string;
  googleSubject?: string;
  grantedScopes: string[];
  status: 'connected' | 'needs_reauth' | 'revoked';
  connectedBy?: string;
  connectedAt: string;
  lastRefreshAt?: string;
  lastError?: string;
  /** False when the user unticked a scope on the consent screen. */
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

/** One row of the integration audit trail (`/accounts/:id/integrations/events`). */
export interface IntegrationEvent {
  id: string;
  provider: ProviderId;
  /** 'connected' | 'refresh_failed' | 'disconnected' | … — see the API's registry. */
  type: string;
  /** 'user:<id>' or 'service:<name>'. A nightly sync is not the person who connected it. */
  actor: string;
  reason?: string;
  detail?: string;
  metadata: Record<string, unknown>;
  occurredAt: string;
}

/* ── Platform administration (operator-only) ───────────────────────────── */

/** Engine's own OAuth client for a vendor. Never carries the secret. */
export interface PlatformClient {
  vendor: string;
  clientId: string;
  redirectUri: string;
  configured: boolean;
  configuredBy?: string;
  configuredAt: string;
  updatedAt: string;
}

export interface PlatformCredentialEvent {
  id: string;
  vendor: string;
  type: string;
  actor: string;
  detail?: string;
  occurredAt: string;
}

/** `GET /platform/oauth-clients/:vendor`. */
export interface PlatformClientView {
  vendor: string;
  client: PlatformClient | null;
  /** Derived from the request origin, so it cannot be mistyped. */
  suggestedRedirectUri: string;
  /** True when this deployment still supplies the client as Worker config. */
  configuredByEnvironment: boolean;
  events: PlatformCredentialEvent[];
}

/** A person who can sign in. Admin-only data — it is the whole user list. */
export interface PlatformUser {
  id: string;
  email?: string;
  name?: string;
  platformRole: 'admin' | 'user';
  hasCredential: boolean;
  createdAt: string;
}
