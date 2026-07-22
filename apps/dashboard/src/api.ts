/**
 * Typed client for apps/api.
 *
 * `GET /health/integrations` needs no database (pure readiness check).
 * `GET /projects/:id/actions`, `GET /projects/:id/audit`, and
 * `GET /projects/:id/pulse` are all DB-backed and read real Postgres —
 * none falls back to sample data, because "empty" and "unreachable" are
 * different facts and a view that invents rows for both is worse than one
 * that says which happened.
 */
import type {
  AccountCard,
  ActionCard,
  ApiAccount,
  ApiAccountBranding,
  ApiAction,
  ApiEntity,
  ApiFinding,
  ApiProject,
  ApiPulseResponse,
  AuditData,
  CitationOpportunity,
  CompetitorGap,
  CompetitorRef,
  CopilotAnswer,
  CopilotSummary,
  EntityStrength,
  GapType,
  LocalVisibility,
  PulseData,
  ReadinessReport,
  ActionStatus,
  DeployTarget,
  SerpInspectResult,
} from './types.js';
import { toAccountCard, toActionCard, toFindingRow, toPulseData } from './format.js';
import { getApiToken } from './auth/neonAuth.js';

const BASE_KEY = 'engine.apiBaseUrl';
const PROJECT_KEY = 'engine.projectId';
const ACCOUNT_KEY = 'engine.accountId';

export function getApiBaseUrl(): string {
  return localStorage.getItem(BASE_KEY) ?? '';
}
export function setApiBaseUrl(url: string): void {
  localStorage.setItem(BASE_KEY, url.trim().replace(/\/$/, ''));
}
export function getProjectId(): string {
  return localStorage.getItem(PROJECT_KEY) ?? 'demo';
}
export function setProjectId(id: string): void {
  localStorage.setItem(PROJECT_KEY, id.trim() || 'demo');
}
/** The account the Clients grid last selected — null until the user picks one. */
export function getAccountId(): string | null {
  return localStorage.getItem(ACCOUNT_KEY);
}
export function setAccountId(id: string): void {
  localStorage.setItem(ACCOUNT_KEY, id);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const base = getApiBaseUrl();
  if (!base) throw new Error('no API base URL configured');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  // The API verifies this against Neon Auth's JWKS. Null when there's no real
  // remote session (dev-session fallback): the request then 401s and the
  // caller falls back to sample data, rather than the API quietly being open.
  const token = await getApiToken();
  try {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init?.headers ?? {}),
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

/** Live readiness (works without a database). */
export function fetchIntegrations(): Promise<ReadinessReport> {
  return request<ReadinessReport>('/health/integrations');
}

/**
 * The project's Unified Visibility Score (A3), assembled server-side from
 * persisted A1 rank positions and A2 citation events (migration 0005). `score`
 * is null for a project with nothing polled yet — the view renders that as
 * "no data", not a 0 that would read as "zero visibility".
 */
export async function fetchPulse(): Promise<PulseData> {
  const resp = await request<ApiPulseResponse>(`/projects/${getProjectId()}/pulse`);
  return toPulseData(resp);
}

interface RankPollResponse {
  vendor: string;
  results: {
    query: { keyword: string; geo: { country: string } };
    organic: { position: number; url: string; title: string }[];
    features: string[];
    polledAt: string;
  }[];
}

/**
 * Live SERP lookup for one keyword via `POST /projects/:id/rank/poll` (Serper).
 * This is genuinely live and needs no database — just a wired SERP key.
 */
export async function rankPoll(keyword: string, country: string): Promise<SerpInspectResult> {
  const query = { keyword, geo: { country }, device: 'desktop', language: 'en', engine: 'google' };
  const resp = await request<RankPollResponse>(`/projects/${getProjectId()}/rank/poll`, {
    method: 'POST',
    body: JSON.stringify({ queries: [query] }),
  });
  const r = resp.results[0];
  if (!r) throw new Error('no SERP result returned');
  return {
    keyword: r.query.keyword,
    country: r.query.geo.country,
    vendor: resp.vendor,
    features: r.features,
    organic: r.organic,
    polledAt: r.polledAt,
  };
}

/**
 * The project's live Fix Queue from `GET /projects/:id/actions` (DB-backed).
 *
 * An empty array is a real answer — a project with no audit run yet has no
 * actions — so this does not fall back to sample data. The board says so.
 */
export async function fetchActions(): Promise<ActionCard[]> {
  const resp = await request<{ actions: ApiAction[] }>(`/projects/${getProjectId()}/actions`);
  return resp.actions.map(toActionCard);
}

/**
 * The project's finding inventory (B1 technical audit).
 *
 * No sample fallback, for the same reason `fetchActions` has none: an empty
 * inventory and an unreachable API are different facts, and inventing findings
 * for either is how this view spent its life showing a health score of 72 for a
 * site nobody had crawled.
 */
export async function fetchAudit(): Promise<AuditData> {
  const resp = await request<{
    findings: ApiFinding[];
    healthScore: number | null;
    lastRunAt: string | null;
    pagesAudited: number | null;
  }>(`/projects/${getProjectId()}/audit`);
  const findings = resp.findings.map(toFindingRow);
  return {
    healthScore: resp.healthScore,
    // Derived, not reported: it is a count of what the view is already holding,
    // so computing it here cannot disagree with the rows on screen.
    autoFixableCount: findings.filter((f) => f.autoFixable).length,
    findings,
    lastRunAt: resp.lastRunAt,
    pagesAudited: resp.pagesAudited,
  };
}

const TRANSITION_PATH: Record<Exclude<ActionStatus, 'proposed'>, string> = {
  approved: 'approve',
  deployed: 'deploy',
  verified: 'verify',
  rolled_back: 'rollback',
};

/** The project's tracked entities — the Copilot's own picker list. */
export function fetchEntities(): Promise<ApiEntity[]> {
  return request<{ entities: ApiEntity[] }>(`/projects/${getProjectId()}/entities`).then((r) => r.entities);
}

/**
 * The Copilot's one real query (M2.2): a cross-SEO/GEO summary for a single
 * entity, joined server-side across A1 (organic), A2 (AI citation), and B1
 * (findings) through `entity_id`.
 */
export function fetchCopilotSummary(entityId: string): Promise<CopilotSummary> {
  return request<{ summary: CopilotSummary }>(
    `/projects/${getProjectId()}/entities/${entityId}/copilot/summary`,
  ).then((r) => r.summary);
}

/**
 * M2.4 Copilot GA: ask a natural-language question and get a cited,
 * drill-downable answer. The server does the intent parse + entity-first
 * retrieval; the client just sends the question and renders the citations and
 * the optional Finding -> Action suggestion.
 */
export function askCopilot(question: string): Promise<{ answer: CopilotAnswer; latencyMs: number }> {
  return request<{ answer: CopilotAnswer; latencyMs: number }>(`/projects/${getProjectId()}/copilot/ask`, {
    method: 'POST',
    body: JSON.stringify({ question }),
  });
}

/**
 * B3 entity-graph audit. GET reads the persisted strengths (weakest first);
 * POST re-runs the deterministic audit over the project's entities, persisting
 * findings (into the shared inventory) and strengths, and returns both.
 */
export function fetchEntityStrengths(): Promise<EntityStrength[]> {
  return request<{ strengths: EntityStrength[] }>(`/projects/${getProjectId()}/entity-audit`).then((r) => r.strengths);
}
export function runEntityAudit(): Promise<{ entitiesAudited: number; findingsCount: number; strengths: EntityStrength[] }> {
  return request<{ entitiesAudited: number; findingsCount: number; strengths: EntityStrength[] }>(
    `/projects/${getProjectId()}/entity-audit`,
    { method: 'POST', body: JSON.stringify({}) },
  );
}

/**
 * B5 Local SEO Audit. GET the project's persisted local visibility scores
 * (weakest first); GET/PUT a location's settable profile facts; POST re-runs
 * the deterministic audit for a location, persisting local findings + score.
 */
export function fetchLocalVisibility(): Promise<LocalVisibility[]> {
  return request<{ visibility: LocalVisibility[] }>(`/projects/${getProjectId()}/local-audit`).then((r) => r.visibility);
}
export function fetchLocalProfile(entityId: string): Promise<Record<string, unknown> | null> {
  return request<{ profile: Record<string, unknown> | null }>(
    `/projects/${getProjectId()}/entities/${entityId}/local-profile`,
  ).then((r) => r.profile);
}
export function saveLocalProfile(entityId: string, profile: Record<string, unknown>): Promise<unknown> {
  return request(`/projects/${getProjectId()}/entities/${entityId}/local-profile`, {
    method: 'PUT',
    body: JSON.stringify({ profile }),
  });
}
export function runLocalAudit(entityId: string): Promise<{ entityId: string; findingsCount: number; visibility: LocalVisibility }> {
  return request(`/projects/${getProjectId()}/entities/${entityId}/local-audit`, { method: 'POST', body: JSON.stringify({}) });
}

/**
 * A5 Competitor Intelligence. List/add/remove the competitor set for a
 * self-entity, and GET/POST the gap analysis. GET reads the persisted ranked
 * gaps (biggest first); POST re-runs the deterministic set-difference over the
 * self-entity vs. its competitors, persisting findings + gaps, and returns both
 * the flat ranked list and the per-type grouping for the four gap tables.
 */
export function fetchCompetitors(selfEntityId: string): Promise<CompetitorRef[]> {
  return request<{ competitors: CompetitorRef[] }>(
    `/projects/${getProjectId()}/entities/${selfEntityId}/competitors`,
  ).then((r) => r.competitors);
}
export function addCompetitor(selfEntityId: string, competitorEntityId: string): Promise<{ id: string }> {
  return request<{ id: string }>(`/projects/${getProjectId()}/entities/${selfEntityId}/competitors`, {
    method: 'POST',
    body: JSON.stringify({ competitorEntityId }),
  });
}
export function removeCompetitor(selfEntityId: string, competitorSetId: string): Promise<unknown> {
  return request(`/projects/${getProjectId()}/entities/${selfEntityId}/competitors/${competitorSetId}`, {
    method: 'DELETE',
  });
}
export function fetchCompetitorGaps(selfEntityId: string): Promise<CompetitorGap[]> {
  return request<{ gaps: CompetitorGap[] }>(
    `/projects/${getProjectId()}/entities/${selfEntityId}/competitor-audit`,
  ).then((r) => r.gaps);
}
export function runCompetitorAudit(
  selfEntityId: string,
): Promise<{ selfEntityId: string; competitorsAudited: number; findingsCount: number; gaps: CompetitorGap[]; byType: Record<GapType, CompetitorGap[]> }> {
  return request(`/projects/${getProjectId()}/entities/${selfEntityId}/competitor-audit`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

/**
 * A6 Backlink & Mention Index. GET reads the persisted citation opportunities
 * (biggest first); POST re-mines the A2 citation archive for the self-entity's
 * category, persisting off-site findings + opportunities, and returns both plus
 * the full per-domain intelligence.
 */
export function fetchCitationOpportunities(selfEntityId: string): Promise<CitationOpportunity[]> {
  return request<{ opportunities: CitationOpportunity[] }>(
    `/projects/${getProjectId()}/entities/${selfEntityId}/offsite-audit`,
  ).then((r) => r.opportunities);
}
export function runOffsiteAudit(
  selfEntityId: string,
): Promise<{ selfEntityId: string; observationsAnalyzed: number; categorySize: number; findingsCount: number; opportunities: CitationOpportunity[] }> {
  return request(`/projects/${getProjectId()}/entities/${selfEntityId}/offsite-audit`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

/**
 * The project's configured deploy target — where a generated fix lands. Null
 * until the user sets one in Settings; the Audit view reads it to know whether
 * "Propose fix" can work yet.
 */
export function fetchDeployTarget(): Promise<DeployTarget | null> {
  return request<{ target: DeployTarget | null }>(`/projects/${getProjectId()}/deploy-target`).then((r) => r.target);
}

/** Set the project's deploy target. */
export function saveDeployTarget(target: DeployTarget): Promise<DeployTarget> {
  return request<{ target: DeployTarget }>(`/projects/${getProjectId()}/deploy-target`, {
    method: 'PUT',
    body: JSON.stringify({ target }),
  }).then((r) => r.target);
}

/**
 * Ask the API to generate the fix(es) for a finding (M2.3 #3). The server
 * rebuilds the context from the stored crawl + the project's deploy target, so
 * the client sends only the finding id. Returns the created actions (empty,
 * with a note, when the fix needs context this crawl didn't capture).
 */
export function proposeFix(findingId: string): Promise<{ actions: ApiAction[]; note?: string }> {
  return request<{ actions: ApiAction[]; note?: string }>(
    `/projects/${getProjectId()}/findings/${findingId}/propose`,
    { method: 'POST', body: JSON.stringify({}) },
  );
}

/** Attempt a live Fix Queue transition (DB-backed; may fail in pre-alpha). */
export function transitionAction(actionId: string, to: Exclude<ActionStatus, 'proposed'>): Promise<unknown> {
  return request(`/projects/${getProjectId()}/actions/${actionId}/${TRANSITION_PATH[to]}`, {
    method: 'POST',
    body: JSON.stringify({ actor: 'dashboard:internal' }),
  });
}

/**
 * M2.5 agency white-label: every account the signed-in caller belongs to,
 * each with its project list — the multi-client grid's data source. No
 * sample fallback, same reasoning as `fetchActions`/`fetchAudit`: an empty
 * list (no clients yet) and an unreachable API are different facts.
 */
export async function fetchAccounts(): Promise<AccountCard[]> {
  const resp = await request<{ accounts: ApiAccount[] }>('/accounts');
  return resp.accounts.map(toAccountCard);
}

export async function createAccountApi(name: string): Promise<AccountCard> {
  const resp = await request<{ account: ApiAccount }>('/accounts', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  return toAccountCard({ ...resp.account, projects: [] });
}

export async function createProjectApi(accountId: string, name: string, domain: string): Promise<ApiProject> {
  const resp = await request<{ project: ApiProject }>(`/accounts/${accountId}/projects`, {
    method: 'POST',
    body: JSON.stringify({ name, domain }),
  });
  return resp.project;
}

export async function updateBrandingApi(accountId: string, branding: ApiAccountBranding): Promise<ApiAccount> {
  const resp = await request<{ account: ApiAccount }>(`/accounts/${accountId}/branding`, {
    method: 'PATCH',
    body: JSON.stringify(branding),
  });
  return resp.account;
}

/**
 * The branded report is a self-contained HTML document (`text/html`), not
 * JSON — fetched with the same auth header as every other call, then handed
 * to the caller as a Blob URL so it can be opened in a new tab rather than
 * re-rendered as dashboard chrome.
 */
export async function fetchReportUrl(accountId: string): Promise<string> {
  const base = getApiBaseUrl();
  if (!base) throw new Error('no API base URL configured');
  const token = await getApiToken();
  const res = await fetch(`${base}/accounts/${accountId}/report`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const html = await res.text();
  return URL.createObjectURL(new Blob([html], { type: 'text/html' }));
}
