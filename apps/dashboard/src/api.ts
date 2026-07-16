/**
 * Typed client for apps/api.
 *
 * `GET /health/integrations` and `POST /projects/:id/pulse` need no database
 * (the A3 score math is pure). `GET /projects/:id/actions` is DB-backed and now
 * reads the real Fix Queue out of Postgres — it does **not** fall back to sample
 * data, because an empty queue and an unreachable API are different facts and a
 * board that invents cards for both is worse than one that says which happened.
 *
 * What still comes from sample: Pulse's trend / wins / risks context, which
 * needs the ClickHouse rollups (M1.2) that aren't wired yet.
 */
import type { ActionCard, ApiAction, PulseData, ReadinessReport, ActionStatus, SerpInspectResult } from './types.js';
import { toActionCard } from './format.js';
import { MOCK_PULSE } from './mock.js';
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
 * Live Unified Visibility Score. Sends representative surface inputs; the API
 * computes the real A3 band + decomposition (pure, no DB). Trend / wins / risks
 * come from the sample context (those need ClickHouse, not wired yet).
 */
export async function fetchPulse(): Promise<PulseData> {
  const surfaces = {
    organic: MOCK_PULSE.contributions[0]!.value,
    ai: {
      low: MOCK_PULSE.contributions[1]!.low ?? 44,
      point: MOCK_PULSE.contributions[1]!.value,
      high: MOCK_PULSE.contributions[1]!.high ?? 52,
    },
    local: MOCK_PULSE.contributions[2]!.value,
  };
  const resp = await request<{ score: { band: { low: number; point: number; high: number } } }>(
    `/projects/${getProjectId()}/pulse`,
    { method: 'POST', body: JSON.stringify({ surfaces }) },
  );
  const band = resp.score.band;
  return {
    ...MOCK_PULSE,
    score: { point: Math.round(band.point), low: Math.round(band.low), high: Math.round(band.high) },
  };
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

const TRANSITION_PATH: Record<Exclude<ActionStatus, 'proposed'>, string> = {
  approved: 'approve',
  deployed: 'deploy',
  verified: 'verify',
  rolled_back: 'rollback',
};

/** Attempt a live Fix Queue transition (DB-backed; may fail in pre-alpha). */
export function transitionAction(actionId: string, to: Exclude<ActionStatus, 'proposed'>): Promise<unknown> {
  return request(`/projects/${getProjectId()}/actions/${actionId}/${TRANSITION_PATH[to]}`, {
    method: 'POST',
    body: JSON.stringify({ actor: 'dashboard:internal' }),
  });
}
