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
  ApiAuditRequest,
  AccountCard,
  ActionCard,
  ApiAccount,
  ApiAccountBranding,
  AccountKind,
  ApiAction,
  ApiEntity,
  ApiFinding,
  ApiProject,
  ApiPulseResponse,
  AuditData,
  CrawlCoverage,
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
  TrackedKeyword,
  GoogleProviderId,
  ProviderId,
  IntegrationEvent,
  PlatformClient,
  PlatformClientView,
  PlatformUser,
  ProviderCatalogEntry,
  QueueHealth,
  IntegrationConnection,
  IntegrationAssignment,
  ProviderResource,
  SyncOutcome,
  SearchTraffic,
  AiVisibility,
  EntityPrompts,
  GroundedAnswer,
  PromptCitationResult,
  AiModels,
  ShareOfVoice,
  EffectiveCadence,
  AccountCadenceRow,
  CadenceOverride,
} from './types.js';
import {
  accountVocabulary,
  showsClientColumn,
  toAccountCard,
  toActionCard,
  toFindingRow,
  toPulseData,
  type AccountVocabulary,
} from './format.js';
import { getApiToken } from './auth/neonAuth.js';
import { getStoredApiToken, signOut } from './auth/session.js';

const PROJECT_KEY = 'engine.projectId';
const ACCOUNT_KEY = 'engine.accountId';
const ACCOUNT_KINDS_KEY = 'engine.accountKinds';
const AI_MODEL_KEY = 'engine.aiModel';

declare global {
  interface Window {
    /** API origin, written into the page by `scripts/assembleSite.mjs`. */
    ENGINE_API_BASE?: string;
  }
}

/**
 * The API origin for a page served from a loopback host.
 *
 * `wrangler dev` serves apps/api here (see `.claude/launch.json`), and the
 * dashboard is served from a different port, so the two are always
 * cross-origin locally. Hardcoding the pair is what makes `pnpm build` and
 * `wrangler dev` work together with no configuration at all.
 */
const LOCAL_API_BASE = 'http://localhost:8787';

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    hostname.endsWith('.localhost')
  );
}

/**
 * Where the dashboard talks to apps/api. Resolved, never asked for.
 *
 * Three sources, most specific first:
 *
 *  1. **Settings**, for the one person who needs to point a local page at a
 *     deployed API or vice versa. An escape hatch, not the normal path.
 *  2. **`window.ENGINE_API_BASE`**, written into `index.html` at build time by
 *     `scripts/assembleSite.mjs` from the `ENGINE_API_BASE` environment
 *     variable. This is how a deployed build knows.
 *  3. **`http://localhost:8787`** when the page itself is on a loopback host,
 *     because that is where `wrangler dev` always serves the API.
 *
 * This used to be Settings alone, which was fine while sign-in went straight to
 * Neon Auth. It stopped being fine when sign-in started going through the API:
 * Settings is behind the sign-in screen, so a fresh browser could not reach the
 * one field it needed. The interim fix put the field on the sign-in card, which
 * worked but asked every user to know a deployment detail. Knowing the API
 * origin is the build's job, so the build does it.
 */
export function getApiBaseUrl(): string {
  const baked = typeof window !== 'undefined' ? window.ENGINE_API_BASE : undefined;
  if (baked) return baked.trim().replace(/\/$/, '');
  if (typeof location !== 'undefined' && isLoopbackHost(location.hostname)) return LOCAL_API_BASE;
  return '';
}

/** The selected project id, or '' when none has been chosen. */
export function getProjectId(): string {
  return localStorage.getItem(PROJECT_KEY) ?? '';
}

/**
 * The selected project id, or a clear failure.
 *
 * This used to default to the literal string `'demo'`, left over from before
 * projects were real rows. `'demo'` is not a uuid, so every project route
 * answered 400 and each view rendered a validation error about a project the
 * user never chose. Saying "no project selected" is the honest version of the
 * same fact, and views already surface a thrown message.
 */
function requireProjectId(): string {
  const id = getProjectId();
  if (!id) throw new Error('No site selected. Choose one from the switcher at the top of the rail, or add one in Set up.');
  return id;
}

export function setProjectId(id: string): void {
  localStorage.setItem(PROJECT_KEY, id.trim());
}
/** The account the Clients grid last selected — null until the user picks one. */
export function getAccountId(): string | null {
  return localStorage.getItem(ACCOUNT_KEY);
}
export function setAccountId(id: string): void {
  localStorage.setItem(ACCOUNT_KEY, id);
}

/* ── What kind of accounts this user has ──────────────────────────────────── */

const ACCOUNT_KINDS: readonly AccountKind[] = ['company', 'agency', 'individual'];

/**
 * The kinds of every account the signed-in user belongs to, as the last
 * `/accounts` response gave them.
 *
 * Whether the product says "client" is a property of the whole workspace, not
 * of the screen asking. Two readers cannot wait for a fetch to answer it: the
 * shell decides on the first frame whether the client column exists, and the
 * `clients` route decides whether to redirect before any view runs. So the
 * answer is cached in memory and in storage — the first paint after a reload
 * uses what was true last visit, and the `/accounts` call the shell already
 * makes corrects it within the same one.
 *
 * An empty list means nothing has been fetched yet and nothing was stored. It
 * reads as a single company, which is the quiet answer: no client column, no
 * client vocabulary, and no flash of either for the customer who should never
 * see them.
 */
let accountKinds: AccountKind[] | null = null;

function isAccountKind(v: unknown): v is AccountKind {
  return typeof v === 'string' && (ACCOUNT_KINDS as readonly string[]).includes(v);
}

export function knownAccountKinds(): AccountKind[] {
  if (accountKinds) return accountKinds;
  try {
    const raw = localStorage.getItem(ACCOUNT_KINDS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    accountKinds = Array.isArray(parsed) ? parsed.filter(isAccountKind) : [];
  } catch {
    // Storage unavailable, or a value written by an older build. Either way
    // the fetch below replaces it within the visit.
    accountKinds = [];
  }
  return accountKinds;
}

function rememberAccountKinds(cards: readonly AccountCard[]): void {
  accountKinds = cards.map((a) => a.kind);
  try {
    localStorage.setItem(ACCOUNT_KINDS_KEY, JSON.stringify(accountKinds));
  } catch {
    /* storage unavailable — the in-memory copy still holds for this visit */
  }
}

/** The nouns this workspace uses for an account. See `accountVocabulary`. */
export function currentAccountVocabulary(): AccountVocabulary {
  return accountVocabulary(knownAccountKinds());
}

/** Whether the workspace column of account squares is rendered at all. */
export function showsClients(): boolean {
  return showsClientColumn(knownAccountKinds());
}

/**
 * Whether the client layer exists — the one condition on the Clients grid and
 * on every screen that says "client". Derived from the vocabulary rather than
 * re-tested here, so there is one definition of what makes a workspace an
 * agency's.
 */
export function isAgencyWorkspace(): boolean {
  return currentAccountVocabulary().agency;
}

/**
 * The bearer token for this session, from whichever sign-in produced it.
 *
 * Two sources, checked in that order. A password sign-in stores a token the
 * API minted and verifies itself; a Google sign-in has none stored and mints
 * one per request from the Neon Auth cookie. Null when neither applies: the
 * request then 401s, rather than the API quietly being open.
 *
 * One function, because this has now been the cause of two identical bugs.
 * `request` had both sources from the start, but every call that hand-rolls
 * its own fetch to get a different timeout re-derived the token — and each
 * one that reached only for the Google path answered "missing bearer token"
 * to every password user. It happened to the branded report (fixed in #71)
 * and then again to Sync now. A caller that cannot use `request` must still
 * not have to remember this.
 */
async function authToken(): Promise<string | null> {
  return getStoredApiToken() ?? (await getApiToken());
}

/**
 * A 401 whose body carries `code: "expired"` (`apps/api/src/middleware/auth.ts`).
 * The other 401 is a request that carried no token at all, which a reload can
 * still recover from — only the expired one is worth signing the user out for.
 */
function isExpiredSession(body: string): boolean {
  try {
    return (JSON.parse(body) as { code?: string }).code === 'expired';
  } catch {
    return false;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const base = getApiBaseUrl();
  if (!base) throw new Error('no API base URL configured');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  const token = await authToken();
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
    if (!res.ok) {
      const body = await res.text();
      // The API says which kind of 401 this is. An expired session is not
      // something the customer can act on from the screen they are on, so
      // every view used to render the same dead banner and leave them there.
      // Ending the session puts them on sign-in, which is the only next step.
      if (res.status === 401 && isExpiredSession(body)) signOut();
      throw new Error(`${res.status} ${body}`);
    }
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
  const resp = await request<ApiPulseResponse>(`/projects/${requireProjectId()}/pulse`);
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
  const resp = await request<RankPollResponse>(`/projects/${requireProjectId()}/rank/poll`, {
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
  const resp = await request<{ actions: ApiAction[] }>(`/projects/${requireProjectId()}/actions`);
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
    coverage: CrawlCoverage | null;
  }>(`/projects/${requireProjectId()}/audit`);
  const findings = resp.findings.map(toFindingRow);
  return {
    healthScore: resp.healthScore,
    // Derived, not reported: it is a count of what the view is already holding,
    // so computing it here cannot disagree with the rows on screen.
    autoFixableCount: findings.filter((f) => f.autoFixable).length,
    findings,
    lastRunAt: resp.lastRunAt,
    pagesAudited: resp.pagesAudited,
    coverage: resp.coverage ?? null,
  };
}

/**
 * "Run audit": queue a crawl for the selected project, or the one named. The
 * API answers 409 when one is already queued or running; callers read that
 * through `readableError` as a plain sentence.
 */
export async function requestAudit(projectId = requireProjectId()): Promise<{ request: ApiAuditRequest; dispatched: boolean }> {
  return request<{ request: ApiAuditRequest; dispatched: boolean }>(`/projects/${projectId}/audit-requests`, {
    method: 'POST',
    body: '{}',
  });
}

export async function fetchLatestAuditRequest(): Promise<ApiAuditRequest | null> {
  const resp = await request<{ request: ApiAuditRequest | null }>(`/projects/${requireProjectId()}/audit-requests/latest`);
  return resp.request;
}

const TRANSITION_PATH: Record<Exclude<ActionStatus, 'proposed'>, string> = {
  approved: 'approve',
  deployed: 'deploy',
  verified: 'verify',
  rolled_back: 'rollback',
};

/** The project's tracked entities — the Copilot's own picker list. */
export function fetchEntities(): Promise<ApiEntity[]> {
  return request<{ entities: ApiEntity[] }>(`/projects/${requireProjectId()}/entities`).then((r) => r.entities);
}

/**
 * The Copilot's one real query (M2.2): a cross-SEO/GEO summary for a single
 * entity, joined server-side across A1 (organic), A2 (AI citation), and B1
 * (findings) through `entity_id`.
 */
export function fetchCopilotSummary(entityId: string): Promise<CopilotSummary> {
  return request<{ summary: CopilotSummary }>(
    `/projects/${requireProjectId()}/entities/${entityId}/copilot/summary`,
  ).then((r) => r.summary);
}

/**
 * M2.4 Copilot GA: ask a natural-language question and get a cited,
 * drill-downable answer. The server does the intent parse + entity-first
 * retrieval; the client just sends the question and renders the citations and
 * the optional Finding -> Action suggestion.
 */
export function askCopilot(question: string): Promise<{ answer: CopilotAnswer; latencyMs: number }> {
  return request<{ answer: CopilotAnswer; latencyMs: number }>(`/projects/${requireProjectId()}/copilot/ask`, {
    method: 'POST',
    body: JSON.stringify({ question }),
  });
}

/**
 * When one of the four deterministic audits last ran, and what set it off.
 *
 * Carried by every one of their GET routes because the result alone cannot
 * say it: an audit that runs and finds nothing persists no row, so an empty
 * screen has always been ambiguous between "never run" and "run, all clear".
 */
export interface AuditLastRun {
  kind: 'entity' | 'offsite' | 'competitor' | 'local';
  trigger: 'crawl' | 'schedule' | 'manual';
  findingsCount: number;
  ranAt: string;
}

/**
 * B3 entity-graph audit. GET reads the persisted strengths (weakest first);
 * POST re-runs the deterministic audit over the project's entities, persisting
 * findings (into the shared inventory) and strengths, and returns both.
 */
export function fetchEntityStrengths(): Promise<{ strengths: EntityStrength[]; lastRun: AuditLastRun | null }> {
  return request<{ strengths: EntityStrength[]; lastRun: AuditLastRun | null }>(
    `/projects/${requireProjectId()}/entity-audit`,
  );
}
export function runEntityAudit(): Promise<{ entitiesAudited: number; findingsCount: number; strengths: EntityStrength[] }> {
  return request<{ entitiesAudited: number; findingsCount: number; strengths: EntityStrength[] }>(
    `/projects/${requireProjectId()}/entity-audit`,
    { method: 'POST', body: JSON.stringify({}) },
  );
}

/**
 * B5 Local SEO Audit. GET the project's persisted local visibility scores
 * (weakest first); GET/PUT a location's settable profile facts; POST re-runs
 * the deterministic audit for a location, persisting local findings + score.
 */
export function fetchLocalVisibility(): Promise<{ visibility: LocalVisibility[]; lastRun: AuditLastRun | null }> {
  return request<{ visibility: LocalVisibility[]; lastRun: AuditLastRun | null }>(
    `/projects/${requireProjectId()}/local-audit`,
  );
}
export function fetchLocalProfile(entityId: string): Promise<Record<string, unknown> | null> {
  return request<{ profile: Record<string, unknown> | null }>(
    `/projects/${requireProjectId()}/entities/${entityId}/local-profile`,
  ).then((r) => r.profile);
}
export function saveLocalProfile(entityId: string, profile: Record<string, unknown>): Promise<unknown> {
  return request(`/projects/${requireProjectId()}/entities/${entityId}/local-profile`, {
    method: 'PUT',
    body: JSON.stringify({ profile }),
  });
}
export function runLocalAudit(entityId: string): Promise<{ entityId: string; findingsCount: number; visibility: LocalVisibility }> {
  return request(`/projects/${requireProjectId()}/entities/${entityId}/local-audit`, { method: 'POST', body: JSON.stringify({}) });
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
    `/projects/${requireProjectId()}/entities/${selfEntityId}/competitors`,
  ).then((r) => r.competitors);
}
export function addCompetitor(selfEntityId: string, competitorEntityId: string): Promise<{ id: string }> {
  return request<{ id: string }>(`/projects/${requireProjectId()}/entities/${selfEntityId}/competitors`, {
    method: 'POST',
    body: JSON.stringify({ competitorEntityId }),
  });
}
/**
 * Add a competitor by their website — the one thing a customer knows about a
 * rival. Creates the competitor entity if this is the first time it is named.
 */
export function addCompetitorByDomain(
  selfEntityId: string,
  domain: string,
): Promise<{ id: string; entityId: string; canonicalName: string; domain: string }> {
  return request(`/projects/${requireProjectId()}/entities/${selfEntityId}/competitors`, {
    method: 'POST',
    body: JSON.stringify({ domain }),
  });
}
export function removeCompetitor(selfEntityId: string, competitorSetId: string): Promise<unknown> {
  return request(`/projects/${requireProjectId()}/entities/${selfEntityId}/competitors/${competitorSetId}`, {
    method: 'DELETE',
  });
}
export function fetchCompetitorGaps(selfEntityId: string): Promise<{ gaps: CompetitorGap[]; lastRun: AuditLastRun | null }> {
  return request<{ gaps: CompetitorGap[]; lastRun: AuditLastRun | null }>(
    `/projects/${requireProjectId()}/entities/${selfEntityId}/competitor-audit`,
  );
}
export function runCompetitorAudit(
  selfEntityId: string,
): Promise<{ selfEntityId: string; competitorsAudited: number; findingsCount: number; gaps: CompetitorGap[]; byType: Record<GapType, CompetitorGap[]> }> {
  return request(`/projects/${requireProjectId()}/entities/${selfEntityId}/competitor-audit`, {
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
export function fetchCitationOpportunities(
  selfEntityId: string,
): Promise<{ opportunities: CitationOpportunity[]; lastRun: AuditLastRun | null }> {
  return request<{ opportunities: CitationOpportunity[]; lastRun: AuditLastRun | null }>(
    `/projects/${requireProjectId()}/entities/${selfEntityId}/offsite-audit`,
  );
}
export function runOffsiteAudit(
  selfEntityId: string,
): Promise<{ selfEntityId: string; observationsAnalyzed: number; categorySize: number; findingsCount: number; opportunities: CitationOpportunity[] }> {
  return request(`/projects/${requireProjectId()}/entities/${selfEntityId}/offsite-audit`, {
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
  return request<{ target: DeployTarget | null }>(`/projects/${requireProjectId()}/deploy-target`).then((r) => r.target);
}

/** Set the project's deploy target. */
export function saveDeployTarget(target: DeployTarget): Promise<DeployTarget> {
  return request<{ target: DeployTarget }>(`/projects/${requireProjectId()}/deploy-target`, {
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
export interface ProposeBatchResult {
  issueType: string;
  findingsInGroup: number;
  findingsAttempted: number;
  actions: ApiAction[];
  skipped: { type: string; reason: string; findingId?: string; url?: string }[];
}

/**
 * Propose the fix for every page in one issue group. A crawl reports one
 * finding per page per issue, so fixing a missing <title> across a site used to
 * be one click per page.
 */
export function proposeBatch(issueType: string): Promise<ProposeBatchResult> {
  return request<ProposeBatchResult>(`/projects/${requireProjectId()}/findings/propose-batch`, {
    method: 'POST',
    body: JSON.stringify({ issueType }),
  });
}

export function proposeFix(findingId: string): Promise<{ actions: ApiAction[]; skipped: { type: string; reason: string }[] }> {
  return request<{ actions: ApiAction[]; skipped: { type: string; reason: string }[] }>(
    `/projects/${requireProjectId()}/findings/${findingId}/propose`,
    { method: 'POST', body: JSON.stringify({}) },
  );
}

/**
 * Confirm a fix's wording, optionally replacing it with the reviewer's edit.
 * Only content rewrites need this, and the API refuses to approve one without
 * it — the words that deploy have to be words a person read.
 */
export async function reviewAction(actionId: string, after?: string): Promise<ApiAction> {
  const resp = await request<{ action: ApiAction }>(
    `/projects/${requireProjectId()}/actions/${actionId}/review`,
    { method: 'POST', body: JSON.stringify(after === undefined ? {} : { after }) },
  );
  return resp.action;
}

export interface ApiVerifyRequest {
  status: 'queued' | 'running' | 'done' | 'failed';
  verified: boolean | null;
  error: string | null;
  finishedAt: string | null;
}

/** What the last check of this deployed fix found, if anything has checked it. */
export function fetchVerifyStatus(actionId: string): Promise<ApiVerifyRequest | null> {
  return request<{ request: ApiVerifyRequest | null }>(
    `/projects/${requireProjectId()}/actions/${actionId}/verify-status`,
  ).then((r) => r.request);
}

/** Ask for the live page to be checked now, rather than waiting for the pass. */
export function requestVerify(actionId: string): Promise<unknown> {
  return request(`/projects/${requireProjectId()}/actions/${actionId}/verify-request`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

/** Attempt a live Fix Queue transition (DB-backed; may fail in pre-alpha). */
export function transitionAction(actionId: string, to: Exclude<ActionStatus, 'proposed'>): Promise<unknown> {
  return request(`/projects/${requireProjectId()}/actions/${actionId}/${TRANSITION_PATH[to]}`, {
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
  const cards = resp.accounts.map(toAccountCard);
  // The one call every screen already makes is also the one place that knows
  // the kinds, so it is where the cache is filled rather than in a second
  // request the shell would have to remember to make.
  rememberAccountKinds(cards);
  return cards;
}

export async function createAccountApi(name: string, kind: AccountKind): Promise<AccountCard> {
  const resp = await request<{ account: ApiAccount }>('/accounts', {
    method: 'POST',
    body: JSON.stringify({ name, kind }),
  });
  return toAccountCard({ ...resp.account, projects: [] });
}

/**
 * Change what kind of thing this account is.
 *
 * The cache of kinds is refilled from the response rather than the requested
 * value, because the vocabulary ("client" vs "site") and the client layer both
 * read it — a select that optimistically said "agency" while the API refused
 * the change would rename half the product until the next reload.
 */
export async function setAccountKindApi(accountId: string, kind: AccountKind): Promise<AccountCard> {
  const resp = await request<{ account: ApiAccount }>(`/accounts/${accountId}`, {
    method: 'PATCH',
    body: JSON.stringify({ kind }),
  });
  const card = toAccountCard({ ...resp.account, projects: [] });
  await fetchAccounts();
  return card;
}

export async function createProjectApi(accountId: string, name: string, domain: string): Promise<ApiProject> {
  const resp = await request<{ project: ApiProject }>(`/accounts/${accountId}/projects`, {
    method: 'POST',
    body: JSON.stringify({ name, domain }),
  });
  return resp.project;
}

/**
 * Rename the selected site. Setup derives the name from the address, so the
 * first name a site has is a guess; this is how it is corrected. The API
 * refuses a change of address, which is a new site rather than a rename.
 */
export async function renameProjectApi(name: string): Promise<ApiProject> {
  const resp = await request<{ project: ApiProject }>(`/projects/${requireProjectId()}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  });
  return resp.project;
}

/**
 * The brand (entity) a site is audited as. Takes the project id explicitly
 * rather than reading the selected one: onboarding creates the project and the
 * entity in one go, before anything has been selected.
 */
export async function createEntityApi(projectId: string, canonicalName: string, schemaType?: string): Promise<ApiEntity> {
  const resp = await request<{ entity: ApiEntity }>(`/projects/${projectId}/entities`, {
    method: 'POST',
    body: JSON.stringify(schemaType ? { canonicalName, schemaType } : { canonicalName }),
  });
  return resp.entity;
}

/**
 * Change what kind of thing a brand is. It decides the `@type` of the
 * structured data Engine proposes, which is why a fix is refused outright
 * rather than falling back to a type that describes nothing.
 */
export async function setEntityKindApi(entityId: string, schemaType: string): Promise<ApiEntity> {
  const resp = await request<{ entity: ApiEntity }>(`/projects/${requireProjectId()}/entities/${entityId}`, {
    method: 'PATCH',
    body: JSON.stringify({ schemaType }),
  });
  return resp.entity;
}

/**
 * Rename a brand. The same route as `setEntityKindApi`, which takes either
 * field: sending only the one the customer changed means two open tabs cannot
 * overwrite each other's other field.
 */
export async function renameEntityApi(entityId: string, canonicalName: string): Promise<ApiEntity> {
  const resp = await request<{ entity: ApiEntity }>(`/projects/${requireProjectId()}/entities/${entityId}`, {
    method: 'PATCH',
    body: JSON.stringify({ canonicalName }),
  });
  return resp.entity;
}

/** Starts the onboarding clock (time to first insight is measured from here). */
export function markDomainConnectedApi(projectId: string): Promise<unknown> {
  return request(`/projects/${projectId}/onboarding/domain-connected`, { method: 'POST' });
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
  const token = await authToken();
  const res = await fetch(`${base}/accounts/${accountId}/report`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const html = await res.text();
  return URL.createObjectURL(new Blob([html], { type: 'text/html' }));
}

/* ── Per-account customer integrations ─────────────────────────────────── */

/**
 * The provider catalogue. Unauthenticated on the API side (a static product
 * description), but routed through `request` anyway so it obeys the same base
 * URL and timeout as everything else.
 */
export async function fetchProviderCatalog(includePlanned = false): Promise<ProviderCatalogEntry[]> {
  const resp = await request<{ providers: ProviderCatalogEntry[] }>(
    `/integrations/providers${includePlanned ? '?planned=1' : ''}`,
  );
  return resp.providers;
}

/**
 * An account's connections, plus whether Engine's own identity is registered
 * with each vendor. `vendorsConfigured` is read per vendor because the answer
 * differs — Google can be set up while the GitHub App is not. `oauthConfigured`
 * is the older single boolean, kept as a fallback for the moments when the
 * Worker is a deploy behind the dashboard.
 */
export async function fetchConnections(
  accountId: string,
): Promise<{ connections: IntegrationConnection[]; vendorsConfigured: Record<string, boolean> }> {
  const resp = await request<{
    connections: IntegrationConnection[];
    vendorsConfigured?: Record<string, boolean>;
    oauthConfigured?: boolean;
  }>(`/accounts/${accountId}/integrations`);
  return {
    connections: resp.connections,
    vendorsConfigured: resp.vendorsConfigured ?? { google: Boolean(resp.oauthConfigured) },
  };
}

/**
 * Start a connect flow. Returns Google's consent URL for the caller to open —
 * deliberately not a redirect, so the dashboard can use a popup and keep the
 * page it is on.
 */
export async function fetchConnectUrl(
  accountId: string,
  provider: GoogleProviderId,
  returnTo?: string,
): Promise<string> {
  const resp = await request<{ url: string }>(`/accounts/${accountId}/integrations/${provider}/connect-url`, {
    method: 'POST',
    body: JSON.stringify({ returnTo }),
  });
  return resp.url;
}

/** The properties or locations this connection can see, for the picker. */
export async function fetchProviderResources(
  accountId: string,
  provider: GoogleProviderId,
): Promise<{ resources: ProviderResource[]; truncated?: boolean }> {
  return request<{ resources: ProviderResource[]; truncated?: boolean }>(
    `/accounts/${accountId}/integrations/${provider}/resources`,
  );
}

export async function disconnectProvider(
  accountId: string,
  provider: ProviderId,
): Promise<{ revokedAtVendor: boolean; revocationSupported: boolean }> {
  const resp = await request<{
    disconnected: boolean;
    revokedAtVendor?: boolean;
    revocationSupported?: boolean;
    revokedAtGoogle?: boolean;
  }>(`/accounts/${accountId}/integrations/${provider}`, { method: 'DELETE' });
  // `revokedAtGoogle` is the field's old name. Read both so this build works
  // against an API deploy of either vintage; a Pages build and a Worker deploy
  // never land in the same instant.
  const revokedAtVendor = resp.revokedAtVendor ?? resp.revokedAtGoogle ?? false;
  return { revokedAtVendor, revocationSupported: resp.revocationSupported ?? true };
}

/**
 * Connect a provider that takes a pasted API key.
 *
 * The second connect path, for vendors with no consent screen. The values go
 * straight to the API and are never stored client-side — not in localStorage,
 * not in a component that outlives the submit.
 */
export async function connectApiKey(
  accountId: string,
  provider: ProviderId,
  fields: Record<string, string>,
): Promise<IntegrationConnection> {
  const resp = await request<{ connection: IntegrationConnection }>(
    `/accounts/${accountId}/integrations/${provider}/api-key`,
    { method: 'POST', body: JSON.stringify(fields) },
  );
  return resp.connection;
}

/** The integration audit trail for this account. Owner-only on the API side. */
export async function fetchIntegrationEvents(accountId: string): Promise<IntegrationEvent[]> {
  const resp = await request<{ events: IntegrationEvent[] }>(`/accounts/${accountId}/integrations/events`);
  return resp.events;
}

/**
 * Whether the Local screen applies to this project — a Business Profile
 * connection, or location facts typed in on Integrations. One server-side
 * answer rather than two client-side checks, so the tab strip and the screen
 * cannot disagree.
 */
export async function fetchLocalAvailability(): Promise<boolean> {
  const resp = await request<{ available: boolean }>(`/projects/${requireProjectId()}/local-availability`);
  return resp.available === true;
}

export async function fetchProjectIntegrations(): Promise<{
  assignments: IntegrationAssignment[];
  connections: IntegrationConnection[];
  /** The client the selected project belongs to. Absent from an older API deploy. */
  account?: { id: string; name: string | null };
}> {
  return request<{
    assignments: IntegrationAssignment[];
    connections: IntegrationConnection[];
    account?: { id: string; name: string | null };
  }>(`/projects/${requireProjectId()}/integrations`);
}

/**
 * Search Console and Analytics figures for the selected project, from the
 * rows the sync stored. Never a live Google call: the page must answer in the
 * same time whether Google is up or not.
 */
export function fetchSearchTraffic(): Promise<SearchTraffic> {
  return request<SearchTraffic>(`/projects/${requireProjectId()}/search-traffic`);
}

export async function assignProviderResource(
  provider: GoogleProviderId,
  body: { resourceId: string; resourceLabel?: string; entityId?: string },
): Promise<IntegrationAssignment> {
  const resp = await request<{ assignment: IntegrationAssignment }>(
    `/projects/${requireProjectId()}/integrations/${provider}`,
    { method: 'PUT', body: JSON.stringify(body) },
  );
  return resp.assignment;
}

export async function unassignProviderResource(assignmentId: string): Promise<void> {
  await request<{ removed: boolean }>(
    `/projects/${requireProjectId()}/integrations/assignments/${assignmentId}`,
    { method: 'DELETE' },
  );
}

/**
 * Pull fresh data now. A sync can legitimately take longer than the shared
 * 8-second timeout in `request` — a 28-day Search Console window is thousands
 * of rows — so this issues its own fetch with a longer budget rather than
 * reporting a timeout for work that is still running.
 */
export async function syncProvider(
  provider: GoogleProviderId,
  range?: { from: string; to: string },
): Promise<SyncOutcome | { locations: number; skipped: number }> {
  const base = getApiBaseUrl();
  if (!base) throw new Error('no API base URL configured');
  const token = await authToken();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const res = await fetch(`${base}/projects/${requireProjectId()}/integrations/${provider}/sync`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(range ?? {}),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const json = (await res.json()) as { synced?: SyncOutcome; locations?: number; skipped?: number };
    if (json.synced) return json.synced;
    return { locations: json.locations ?? 0, skipped: json.skipped ?? 0 };
  } finally {
    clearTimeout(timeout);
  }
}

/* ── Platform administration ───────────────────────────────────────────── */

/**
 * Whether the signed-in user may configure Engine's own credentials.
 *
 * Asked for every user so the dashboard can decide whether to render the
 * section. It reveals only whether *you* are an administrator, which you
 * already know; the API answers 404 to everyone else on the routes themselves.
 */
export async function fetchPlatformAccess(): Promise<{ isAdmin: boolean }> {
  return request<{ isAdmin: boolean }>('/platform/access');
}

export async function fetchPlatformClient(vendor: string): Promise<PlatformClientView> {
  return request<PlatformClientView>(`/platform/oauth-clients/${vendor}`);
}

export async function savePlatformClient(
  vendor: string,
  body: { clientId: string; clientSecret: string; redirectUri: string },
): Promise<PlatformClient> {
  const resp = await request<{ client: PlatformClient }>(`/platform/oauth-clients/${vendor}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  return resp.client;
}

export async function clearPlatformClient(vendor: string): Promise<void> {
  await request<{ cleared: boolean }>(`/platform/oauth-clients/${vendor}`, { method: 'DELETE' });
}

/** Everyone who can sign in. Admin-only; the API answers 404 to anyone else. */
/** Set or replace the signed-in user's password (`POST /auth/password`). Also the reset path: sign in with a code, then set one. */
export async function setPasswordApi(password: string): Promise<void> {
  await request<{ ok: true }>('/auth/password', { method: 'POST', body: JSON.stringify({ password }) });
}

export interface ApiInvitation {
  id: string;
  accountId: string;
  email: string;
  role: 'owner' | 'member';
  expiresAt: string;
  createdAt: string;
}

export async function fetchInvitations(accountId: string): Promise<ApiInvitation[]> {
  const data = await request<{ invitations: ApiInvitation[] }>(`/accounts/${encodeURIComponent(accountId)}/invitations`);
  return data.invitations;
}

export async function inviteToAccount(accountId: string, email: string): Promise<ApiInvitation> {
  const data = await request<{ invitation: ApiInvitation }>(`/accounts/${encodeURIComponent(accountId)}/invitations`, {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
  return data.invitation;
}

export async function withdrawInvitation(accountId: string, invitationId: string): Promise<void> {
  await request<{ ok: true }>(`/accounts/${encodeURIComponent(accountId)}/invitations/${encodeURIComponent(invitationId)}`, {
    method: 'DELETE',
  });
}

/** Who gets named instead of you: share of voice per brand over the mined samples. */
export async function fetchShareOfVoice(entityId: string): Promise<ShareOfVoice> {
  return request<ShareOfVoice>(`/projects/${requireProjectId()}/entities/${encodeURIComponent(entityId)}/share-of-voice`);
}

/** The account's effective cadence and where each value came from. */
export async function fetchAccountCadence(accountId: string): Promise<EffectiveCadence & { accountId: string }> {
  return request<EffectiveCadence & { accountId: string }>(`/accounts/${encodeURIComponent(accountId)}/cadence`);
}

export async function fetchPlatformCadences(): Promise<AccountCadenceRow[]> {
  const data = await request<{ accounts: AccountCadenceRow[] }>('/platform/accounts/cadence');
  return data.accounts;
}

export async function setAccountCadence(accountId: string, override: CadenceOverride): Promise<EffectiveCadence> {
  return request<EffectiveCadence>(`/platform/accounts/${encodeURIComponent(accountId)}/cadence`, {
    method: 'PUT',
    body: JSON.stringify(override),
  });
}

/** Queue depth and last completion, for the operator checklist. Admin only. */
export async function fetchQueueHealth(): Promise<QueueHealth> {
  return (await request<{ queue: QueueHealth }>('/platform/queue')).queue;
}

export async function fetchPlatformUsers(): Promise<{ users: PlatformUser[]; adminCount: number }> {
  return request<{ users: PlatformUser[]; adminCount: number }>('/platform/users');
}

export async function setUserRole(userId: string, role: 'admin' | 'user'): Promise<void> {
  await request<{ userId: string }>(`/platform/users/${encodeURIComponent(userId)}/role`, {
    method: 'PUT',
    body: JSON.stringify({ role }),
  });
}

/**
 * The project's tracked keywords with their current position. Read from
 * `serp_positions`, not from a live lookup: the table must render in the same
 * time whether Serper is up or not, and a page load must never spend a
 * per-lookup credit.
 */
export function fetchTrackedKeywords(): Promise<TrackedKeyword[]> {
  return request<{ keywords: TrackedKeyword[] }>(`/projects/${requireProjectId()}/keywords`).then((r) => r.keywords);
}

/**
 * Start tracking a keyword against an entity. The scheduled poll picks it up
 * on its next pass; nothing is polled here, so adding twenty keywords costs
 * twenty rows and no credit.
 */
export async function trackKeyword(
  entityId: string,
  body: { keyword: string; geoCountry: string; device?: 'desktop' | 'mobile'; language?: string },
): Promise<void> {
  await request<{ config: TrackedKeyword }>(
    `/projects/${requireProjectId()}/entities/${entityId}/keywords`,
    {
      method: 'POST',
      body: JSON.stringify({
        keyword: body.keyword,
        geoCountry: body.geoCountry,
        device: body.device ?? 'desktop',
        language: body.language ?? 'en',
        engine: 'google',
      }),
    },
  );
}

export async function untrackKeyword(keywordId: string): Promise<void> {
  await request<{ ok: boolean }>(`/projects/${requireProjectId()}/keywords/${keywordId}`, { method: 'DELETE' });
}

/** The prompt bank for one brand, with seeds from its tracked keywords. */
export function fetchEntityPrompts(entityId: string): Promise<EntityPrompts> {
  return request<EntityPrompts>(`/projects/${requireProjectId()}/entities/${entityId}/prompts`);
}

/** Replace the prompt bank. The editor sends the list it is showing. */
export function saveEntityPrompts(entityId: string, prompts: string[]): Promise<{ prompts: string[] }> {
  return request<{ prompts: string[] }>(`/projects/${requireProjectId()}/entities/${entityId}/prompts`, {
    method: 'PUT',
    body: JSON.stringify({ prompts }),
  });
}

/** Cited share by engine over the stored samples. */
export function fetchAiVisibility(entityId: string): Promise<AiVisibility> {
  return request<AiVisibility>(`/projects/${requireProjectId()}/entities/${entityId}/ai-visibility`);
}

export interface AiStreamHandlers {
  /** Ask Engine only: the cited answer, before any model token. */
  onGrounded?: (grounded: GroundedAnswer) => void;
  /** The model is still reasoning. */
  onThinking?: (delta: string) => void;
  onText?: (delta: string) => void;
  /** Prompt mode only: whether the finished answer named the brand. */
  onResult?: (result: PromptCitationResult) => void;
  onError?: (message: string) => void;
  onDone?: (info: { rephrased: boolean }) => void;
}

export type AiStreamRequest =
  | { mode: 'prompt'; entityId: string; prompt: string; model?: string }
  | { mode: 'ask'; question: string; model?: string };

/** Which models this deployment can offer, and which the poll is pinned to. */
export function fetchAiModels(): Promise<AiModels> {
  return request<AiModels>(`/projects/${requireProjectId()}/ai/models`);
}

/**
 * The model the person last picked, remembered per browser.
 *
 * Per viewer rather than per project because it is a preference about waiting,
 * not a property of the brand being measured: one person wants a fast answer
 * while they work and another wants the considered one. Nothing stored depends
 * on it — the scheduled poll has its own fixed model.
 */
export function getAiModel(): string | null {
  try {
    return localStorage.getItem(AI_MODEL_KEY);
  } catch {
    return null;
  }
}

export function setAiModel(id: string): void {
  try {
    localStorage.setItem(AI_MODEL_KEY, id);
  } catch {
    /* a browser with site data blocked still gets the default */
  }
}

/**
 * Read one streamed answer from `POST /projects/:id/ai/stream`.
 *
 * Written by hand rather than with `EventSource`, which cannot POST, cannot
 * carry an `authorization` header, and reconnects on its own — all three wrong
 * here: the request has a body, every project route is gated by a bearer
 * token, and a silent retry would ask a reasoning model the same question
 * twice and bill for both.
 *
 * `request` is not reused either, because its 8-second timeout is shorter than
 * a measured Sarvam answer (7.5 s to complete, 3.2 s to its first answer
 * token). The caller passes a signal instead, so a person can stop a stream
 * and closing the panel does not leave one running.
 */
export async function streamAi(
  body: AiStreamRequest,
  handlers: AiStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const base = getApiBaseUrl();
  if (!base) throw new Error('no API base URL configured');
  const token = await authToken();

  const res = await fetch(`${base}/projects/${requireProjectId()}/ai/stream`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });
  // A refusal arrives as ordinary JSON with a status, before the stream opens
  // — that is why the route settles every error case first.
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  if (!res.body) throw new Error('the response carried no body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  /** Dispatch one complete `event:`/`data:` block. */
  const dispatch = (block: string): void => {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    if (data.length === 0) return;
    let payload: unknown;
    try {
      payload = JSON.parse(data.join('\n'));
    } catch {
      return;
    }
    switch (event) {
      case 'grounded':
        handlers.onGrounded?.(payload as GroundedAnswer);
        break;
      case 'thinking':
        handlers.onThinking?.((payload as { delta: string }).delta);
        break;
      case 'text':
        handlers.onText?.((payload as { delta: string }).delta);
        break;
      case 'result':
        handlers.onResult?.(payload as PromptCitationResult);
        break;
      case 'error':
        handlers.onError?.((payload as { message: string }).message);
        break;
      case 'done':
        handlers.onDone?.(payload as { rephrased: boolean });
        break;
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Events are separated by a blank line, and a network chunk can split
      // one anywhere — so only whole blocks are dispatched and the remainder
      // is carried forward.
      let split: number;
      while ((split = buffer.indexOf('\n\n')) !== -1) {
        dispatch(buffer.slice(0, split));
        buffer = buffer.slice(split + 2);
      }
    }
    if (buffer.trim()) dispatch(buffer);
  } finally {
    reader.releaseLock();
  }
}
