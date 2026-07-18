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
  ActionCard,
  ApiAction,
  ApiEntity,
  ApiFinding,
  ApiPulseResponse,
  AuditData,
  CopilotSummary,
  PulseData,
  ReadinessReport,
  ActionStatus,
  SerpInspectResult,
} from './types.js';
import { toActionCard, toFindingRow, toPulseData } from './format.js';
import { getApiToken } from './auth/neonAuth.js';

const BASE_KEY = 'engine.apiBaseUrl';
const PROJECT_KEY = 'engine.projectId';

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

/** Attempt a live Fix Queue transition (DB-backed; may fail in pre-alpha). */
export function transitionAction(actionId: string, to: Exclude<ActionStatus, 'proposed'>): Promise<unknown> {
  return request(`/projects/${getProjectId()}/actions/${actionId}/${TRANSITION_PATH[to]}`, {
    method: 'POST',
    body: JSON.stringify({ actor: 'dashboard:internal' }),
  });
}
