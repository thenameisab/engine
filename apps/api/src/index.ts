import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import {
  unifiedVisibilityScore,
  DEFAULT_CHANNEL_MIX,
  type SurfaceScores,
  type ChannelMix,
} from '@engine/scoring';
import { runAudit, type CrawledPage } from '@engine/diagnosis';
import { runContentAudit } from '@engine/content';
import { generateActions, transition, defaultEnv, type ActionContext } from '@engine/actions';
import { verifyHtmlDeploy, verifyRobotsDeploy, exportActionAsPr } from '@engine/deploy';
import {
  verifyStripeSignature,
  mapStripeSubscriptionEvent,
  isOverLimit,
  resolvePriceId,
  buildCheckoutSessionBody,
  createCheckoutSession,
  type StripeWebhookEvent,
} from '@engine/billing';
import { evaluateReadiness } from '@engine/config';
import { createSerpConnector, createLlmConnectors, type SerpQuery, type PromptQuery } from '@engine/connectors';
import { durationMs, type Finding, type PlanTier, type DeployTarget } from '@engine/core';
import { classifyIntent, transliterateToDevanagari, generatePromptSeeds } from '@engine/keywords';
import { createDb, type Db } from './db.js';
import { checkAuditBody, checkGenerateBody, checkCreateKeywordConfigBody, checkCreateCheckoutBody, checkUuidParam } from './validate.js';
import { requireAuth, type AuthEnv, type AuthUser } from './middleware/auth.js';
import { createEntity, listEntitiesByProject, getEntityInProject } from './repositories/entities.js';
import { buildEntityCopilotSummary } from './repositories/entityCopilot.js';
import {
  createAction,
  getAction,
  listActionsByProject,
  saveActionTransition,
  findingIdsWithActions,
} from './repositories/actions.js';
import { findingBelongsToProject, listFindingsByProject, upsertFindings } from './repositories/findings.js';
import { recordAuditRun, latestAuditRun } from './repositories/auditRuns.js';
import { insertSerpPositions } from './repositories/rankPositions.js';
import { insertCitationEvents } from './repositories/citationEvents.js';
import { assembleSurfaceScores } from './repositories/pulseRollup.js';
import { createKeywordConfig, listKeywordConfigsByEntity } from './repositories/keywordConfigs.js';
import { listPendingCmsPluginActions } from './repositories/cmsPluginActions.js';
import {
  getOnboardingProgress,
  markDomainConnected,
  markGscConnected,
  markFirstCrawl,
  markFirstInsight,
  markFirstFixProposed,
  markFirstFixDeployed,
} from './repositories/onboarding.js';
import { getSubscription, upsertSubscription, getUsageCounters } from './repositories/billing.js';

interface Env extends AuthEnv {
  DATABASE_URL: string;
  GSC_CLIENT_ID?: string;
  GSC_CLIENT_SECRET?: string;
  GSC_REDIRECT_URI?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  /** JSON map of Stripe price id -> our PlanTier, e.g. {"price_growth_monthly":"growth"}. */
  STRIPE_PRICE_TO_TIER?: string;
  STRIPE_SECRET_KEY?: string;
  /** SERP data (A1). SERP_PROVIDER defaults to 'serper'. */
  SERP_PROVIDER?: string;
  SERPER_API_KEY?: string;
  /** LLM engines (A2). Each engine activates only when its key is present. */
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  /** Comma-separated allowed dashboard origins for CORS. '*' (default) is fine for the pre-alpha internal build. */
  CORS_ORIGINS?: string;
  /** C4.5 GitHub PR export — token for the 'github-pr' DeployTarget's real API calls. */
  GITHUB_TOKEN?: string;
}

const app = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();

/**
 * CORS so the browser dashboard (a separate Pages origin) can call this Worker.
 * Defaults to `*` for the pre-alpha internal build; set `CORS_ORIGINS` to a
 * comma-separated allowlist to lock it down.
 */
app.use('*', (c, next) => {
  const configured = c.env.CORS_ORIGINS?.split(',').map((o) => o.trim()).filter(Boolean);
  return cors({
    origin: configured && configured.length > 0 ? configured : '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  })(c, next);
});

/**
 * The auth gate (Neon Auth JWT, or the edge worker's service token). Applied
 * to every project- and account-scoped route, plus readiness — i.e. everything
 * that touches the database or spends live SERP/LLM credit.
 *
 * Deliberately left open, and why:
 *  - `GET /health` — a liveness probe, reveals nothing.
 *  - `POST /billing/webhook` — called by Stripe, which cannot hold a JWT. It
 *    has its own stronger gate: HMAC signature verification (@engine/billing).
 *  - `GET /oauth/gsc/callback` — a browser redirect target from Google; the
 *    OAuth `code` is the credential and is useless without our client secret.
 */
app.use('/health/integrations', requireAuth);
app.use('/projects/*', requireAuth);
app.use('/accounts/*', requireAuth);

app.get('/health', (c) => c.json({ status: 'ok' }));

/**
 * Read a JSON body without trusting it.
 *
 * `c.req.json<T>()` does two things worth separating: it parses (which throws on
 * a body that isn't JSON at all — an uncaught 500) and it *asserts* a type that
 * nothing checked. This returns `unknown` on purpose, so the only way to reach a
 * typed body is through a validator in ./validate.ts. The sentinel keeps
 * "unparseable" distinct from a body that legitimately parsed to `null`.
 */
const UNPARSEABLE = Symbol('unparseable');

async function readJson(c: Context): Promise<unknown> {
  return c.req.json<unknown>().catch(() => UNPARSEABLE);
}

/**
 * Integration readiness (pre-alpha wiring check). Reports, per external
 * integration (Google OAuth/GSC, Stripe, Serper SERP, OpenAI, Gemini),
 * whether its required secrets/vars are present — without ever echoing a
 * secret value. `mvpReady` is true only when every required-for-MVP
 * integration is fully configured. Drives the internal "what's wired?" view.
 */
app.get('/health/integrations', (c) => {
  const report = evaluateReadiness(c.env as unknown as Record<string, string | undefined>);
  return c.json(report);
});

/**
 * A1 rank poll. Fetches live SERP results for the supplied queries via the
 * configured SERP connector (Serper.dev by default). Returns 503 when no SERP
 * key is wired, so a missing account degrades cleanly instead of 500-ing.
 *
 * `entityId` is optional and applies to the whole batch: the SERP Inspector
 * (dashboard) uses this route for one-off ad-hoc lookups that aren't tracked
 * against any entity, and omitting it preserves that "check anything, persist
 * nothing" behavior. When a caller supplies it (the eventual A1 scheduled
 * poller), every result in the batch is persisted to `serp_positions`
 * (migration 0005) so M1.1's warehouse actually accumulates history instead
 * of discarding each poll after responding.
 */
app.post('/projects/:projectId/rank/poll', async (c) => {
  const connector = createSerpConnector(c.env as unknown as Record<string, string | undefined>);
  if (!connector) {
    return c.json({ error: 'SERP provider not configured (set SERPER_API_KEY)' }, 503);
  }
  const projectId = c.req.param('projectId');
  const body = await c.req.json<{ queries: SerpQuery[]; entityId?: string }>();
  const db = createDb(c.env.DATABASE_URL);

  // Check tenancy before spending SERP credit: an entityId from another
  // project would otherwise either trip the insert's FK as a 500, or — worse,
  // since it's caller-supplied — let one project's poll write rows onto
  // another project's entity.
  if (body.entityId) {
    const known = new Set((await listEntitiesByProject(db, projectId)).map((e) => e.id));
    if (!known.has(body.entityId)) {
      return c.json({ error: 'entity does not belong to this project', entityId: body.entityId }, 400);
    }
  }

  const results = await Promise.all((body.queries ?? []).map((q) => connector.fetch(q)));
  if (body.entityId) {
    await insertSerpPositions(db, body.entityId, results);
  }
  return c.json({ projectId, vendor: connector.vendor, results });
});

/**
 * A2 AI-visibility poll. Polls every configured LLM engine (OpenAI and/or
 * Gemini) n times for the prompt and returns per-engine samples with citation
 * events. Returns 503 when no LLM key is wired.
 *
 * Every sample is persisted to `citation_events` (migration 0005) —
 * `PromptQuery.entityId` is already required, so unlike rank/poll there is no
 * ad-hoc/untracked mode to preserve. Aggregating samples into a
 * confidence-band `CitationMeasurement` (A2.6) happens downstream, from the
 * stored rows, in @engine/scoring via the pulse rollup.
 */
app.post('/projects/:projectId/ai/poll', async (c) => {
  const connectors = createLlmConnectors(c.env as unknown as Record<string, string | undefined>);
  if (connectors.length === 0) {
    return c.json({ error: 'No LLM engine configured (set OPENAI_API_KEY and/or GEMINI_API_KEY)' }, 503);
  }
  const projectId = c.req.param('projectId');
  const body = await c.req.json<{ query: PromptQuery; nSamples?: number }>();
  const db = createDb(c.env.DATABASE_URL);

  // Same tenancy reasoning as rank/poll above, before spending LLM credit.
  const known = new Set((await listEntitiesByProject(db, projectId)).map((e) => e.id));
  if (!known.has(body.query?.entityId)) {
    return c.json({ error: 'entity does not belong to this project', entityId: body.query?.entityId }, 400);
  }

  const nSamples = Math.min(Math.max(body.nSamples ?? 3, 1), 5); // A2 n=3–5
  const results = await Promise.all(connectors.map((engine) => engine.poll(body.query, nSamples)));
  await insertCitationEvents(db, results);
  return c.json({ projectId, engines: connectors.map((e) => e.engine), results });
});

app.get('/projects/:projectId/entities', async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  const entities = await listEntitiesByProject(db, c.req.param('projectId'));
  return c.json({ entities });
});

app.post('/projects/:projectId/entities', async (c) => {
  const body = await c.req.json<{ canonicalName: string }>();
  const db = createDb(c.env.DATABASE_URL);
  const entity = await createEntity(db, c.req.param('projectId'), body.canonicalName);
  return c.json({ entity }, 201);
});

const CMS_PLUGINS = ['wordpress', 'shopify'] as const;

/**
 * The 'cms-plugin' DeployTarget's pull queue (C2.2 — "CMS plugin *or*
 * Cloudflare Worker, no dev ticket"). A plugin installed on the customer's
 * WordPress/Shopify site polls this on a schedule (WP-Cron / a scheduled
 * Shopify job), applies each `diff` through the CMS's own API, then calls the
 * existing `POST .../actions/:id/deploy` transition to record the push —
 * that route already exists and already appends the audit entry; this only
 * adds the read side a plugin needs to know *what* to push.
 *
 * Authenticated the same way the crawler is (a bearer service token via
 * `requireAuth`, already applied to every `/projects/*` route) — a plugin
 * install has no user session either.
 */
app.get('/projects/:projectId/cms-plugin/actions', async (c) => {
  const plugin = c.req.query('plugin');
  const siteId = c.req.query('siteId');
  if (!plugin || !(CMS_PLUGINS as readonly string[]).includes(plugin)) {
    return c.json({ error: `invalid plugin: expected one of "wordpress", "shopify"`, field: 'plugin' }, 400);
  }
  if (!siteId) {
    return c.json({ error: 'missing siteId', field: 'siteId' }, 400);
  }
  const db = createDb(c.env.DATABASE_URL);
  const actions = await listPendingCmsPluginActions(db, c.req.param('projectId'), plugin as 'wordpress' | 'shopify', siteId);
  return c.json({ actions });
});

/**
 * A4 keyword & prompt research (MVP slice). Pure and DB-free: intent
 * classification, Hindi/Hinglish transliteration (A4.7 — English + Hindi is
 * the spec's MVP quality bar), and template-generated prompt seeds (A4.8) for
 * each seed keyword. No embeddings/clustering (A4.4) or managed keyword-volume
 * API (A4.1/A4.2) — both need infrastructure/vendor accounts this pre-alpha
 * build doesn't have; this is deterministic, testable research a user can
 * still act on today. Results are not persisted — this is a research/preview
 * call, not tracking; `POST .../keywords` below is the "push into tracking" step.
 */
app.post('/projects/:projectId/keywords/research', async (c) => {
  const body = await c.req.json<{ seeds: string[] }>();
  const results = (body.seeds ?? []).map((seed) => ({
    seed,
    intent: classifyIntent(seed),
    hindiTransliteration: transliterateToDevanagari(seed),
    promptSeeds: generatePromptSeeds(seed),
  }));
  return c.json({ projectId: c.req.param('projectId'), results });
});

/**
 * Push a researched keyword into A1 tracking (A4 spec §4.8's "one-click push").
 * Before this route existed, nothing ever created a `keyword_configs` row —
 * `apps/api/src/repositories/billing.ts` already counts them for the plan's
 * tracked-keyword limit, so that count was permanently zero.
 */
app.post('/projects/:projectId/entities/:entityId/keywords', async (c) => {
  const raw = await readJson(c);
  if (raw === UNPARSEABLE) return c.json({ error: 'body is not valid JSON' }, 400);
  const invalid = checkCreateKeywordConfigBody(raw);
  if (invalid) {
    return c.json({ error: `invalid ${invalid.field}: ${invalid.message}`, field: invalid.field }, 400);
  }
  const projectId = c.req.param('projectId');
  const entityId = c.req.param('entityId');
  const db = createDb(c.env.DATABASE_URL);

  // Same tenancy reasoning as /audit and /actions/generate: entityId is a
  // path param, so an id from another project must not be allowed to attach
  // a tracked keyword to an entity this caller doesn't own.
  const known = new Set((await listEntitiesByProject(db, projectId)).map((e) => e.id));
  if (!known.has(entityId)) {
    return c.json({ error: 'entity does not belong to this project', entityId }, 400);
  }

  const body = raw as {
    keyword: string;
    geoCountry: string;
    geoCity?: string;
    geoPostcode?: string;
    device: 'desktop' | 'mobile' | 'tablet';
    language: string;
    engine: 'google' | 'bing';
    cadence?: 'weekly' | 'daily' | 'on_demand';
  };
  const config = await createKeywordConfig(db, entityId, body);
  return c.json({ config }, 201);
});

app.get('/projects/:projectId/entities/:entityId/keywords', async (c) => {
  const projectId = c.req.param('projectId');
  const entityId = c.req.param('entityId');
  const db = createDb(c.env.DATABASE_URL);
  const known = new Set((await listEntitiesByProject(db, projectId)).map((e) => e.id));
  if (!known.has(entityId)) {
    return c.json({ error: 'entity does not belong to this project', entityId }, 400);
  }
  const configs = await listKeywordConfigsByEntity(db, entityId);
  return c.json({ configs });
});

/**
 * M2.2 "entity graph online": one cross-SEO/GEO query, powered by the
 * entity-first joins the architecture doc named as the thing that "cannot be
 * retrofitted" — organic rank (A1), AI citation band (A2), and open findings
 * (B1) all read through the same `entity_id`, which is the Copilot's first
 * real query rather than a mock.
 */
app.get('/projects/:projectId/entities/:entityId/copilot/summary', async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  const entity = await getEntityInProject(db, c.req.param('projectId'), c.req.param('entityId'));
  if (!entity) {
    return c.json({ error: 'entity does not belong to this project', entityId: c.req.param('entityId') }, 400);
  }
  const summary = await buildEntityCopilotSummary(db, entity.id, entity.canonicalName);
  return c.json({ summary });
});

/**
 * Compute the A3 Unified Visibility Score for a project from caller-supplied
 * per-surface inputs. Kept alongside the GET below (not replaced by it)
 * because it needs no database and is directly integration-testable — useful
 * for exercising the pure scoring math (@engine/scoring) in isolation, or for
 * a caller that has already assembled surfaces itself (e.g. a one-off report
 * against surfaces that were never polled through this API).
 */
app.post('/projects/:projectId/pulse', async (c) => {
  const body = await c.req.json<{ surfaces: SurfaceScores; mix?: ChannelMix }>();
  const score = unifiedVisibilityScore(body.surfaces, body.mix ?? DEFAULT_CHANNEL_MIX);
  return c.json({ projectId: c.req.param('projectId'), score });
});

/**
 * The A3 Unified Visibility Score assembled server-side from persisted A1/A2
 * data (migration 0005) — the M1.2 rollup the POST route above was always
 * meant to be fed by. Reads each entity's most recent SERP positions and the
 * last 30 days of citation samples, blends them via the same pure
 * `unifiedVisibilityScore`, and reports how much data went in
 * (`keywordsTracked`/`citationSamples`) so a project with nothing polled yet
 * renders as "no data" rather than a confident, meaningless 0.
 */
app.get('/projects/:projectId/pulse', async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  const projectId = c.req.param('projectId');
  const { surfaces, mix, keywordsTracked, citationSamples } = await assembleSurfaceScores(
    db,
    projectId,
    DEFAULT_CHANNEL_MIX,
  );
  const hasData = keywordsTracked > 0 || citationSamples > 0;
  const score = hasData ? unifiedVisibilityScore(surfaces, mix) : null;
  // The AI surface's own band, alongside the blended score: Architecture §3.2
  // says a point is never surfaced for AI visibility, and the unified score's
  // decomposition only carries a point (the band midpoint, used for weighting)
  // — so the dashboard's AI contribution tile needs this to render its own
  // low/high rather than falling back to a bare number.
  return c.json({ projectId, score, aiBand: hasData ? surfaces.ai : null, keywordsTracked, citationSamples });
});

/**
 * Run the B1 technical audit (M1.3) over a set of crawled pages and return the
 * scored `Finding` inventory plus the lead technical-health score. The crawl
 * itself (B1.1 Playwright, Cloudflare Queues) runs out-of-band and persists
 * `CrawledPage` records; here we take them directly so the diagnosis rule engine
 * (pure, in @engine/diagnosis) is integration-testable and the crawl transport
 * stays swappable.
 */
app.post('/projects/:projectId/audit', async (c) => {
  const raw = await readJson(c);
  if (raw === UNPARSEABLE) return c.json({ error: 'body is not valid JSON' }, 400);
  // The pages come off the wire, and the rule engine trusts its input completely
  // (`page.metaDescription.trim()`). Without this, a crawler that drifts from the
  // CrawledPage contract gets a 500 from deep inside @engine/diagnosis naming
  // neither the page nor the field — same reasoning as the entity check below.
  const invalid = checkAuditBody(raw);
  if (invalid) {
    return c.json({ error: `invalid ${invalid.field}: ${invalid.message}`, field: invalid.field }, 400);
  }
  const body = raw as { pages?: CrawledPage[]; target?: DeployTarget };
  const pages = body.pages ?? [];
  const projectId = c.req.param('projectId');
  const db = createDb(c.env.DATABASE_URL);
  const result = runAudit(pages);

  // A page names the entity it belongs to, and that id becomes findings.entity_id.
  // Check the entities are actually this project's before writing: an unchecked
  // id would either trip the FK as a 500, or — worse, since the id is
  // caller-supplied — let one project hang findings off another project's entity.
  // Fetched once and reused for B2.1 entity-coverage facts below, rather than
  // a second query for the same rows.
  const cited = [...new Set(pages.map((p) => p.entityId))];
  const projectEntities = cited.length > 0 ? await listEntitiesByProject(db, projectId) : [];
  if (cited.length > 0) {
    const known = new Set(projectEntities.map((e) => e.id));
    const unknown = cited.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      return c.json({ error: 'pages cite entities that do not belong to this project', unknownEntityIds: unknown }, 400);
    }
  }

  // B2 content/extractability (M2.1) — a separate scored dimension from B1's
  // technical health, not folded into it (§8 defines the health score as
  // technical-issue-only). B2.1 entity coverage scores against each page's
  // own entity's known name/keywords; pages with no captured content
  // (bodyText absent) contribute neither a finding nor a score, not a false
  // "healthy" or "unhealthy".
  const entityCoverageFacts = new Map(
    projectEntities.map((e) => [e.id, { canonicalName: e.canonicalName, keywords: e.keywords }]),
  );
  const contentResult = runContentAudit(pages, { entities: entityCoverageFacts });

  const findings = await upsertFindings(db, [...result.findings, ...contentResult.findings]);
  // Record the run itself. The health score is normalized by pages audited, so
  // it belongs to this run and cannot be recomputed from the findings later —
  // without this row, GET /audit would have to invent one.
  const run = await recordAuditRun(db, {
    projectId,
    pagesAudited: result.pagesAudited,
    findingsCount: findings.length,
    healthScore: result.healthScore,
  });
  await markFirstCrawl(db, projectId);
  if (findings.length > 0) await markFirstInsight(db, projectId);

  const proposedActions = body.target ? await autoProposeMetaFixes(db, findings, pages, body.target) : [];
  if (proposedActions.length > 0) await markFirstFixProposed(db, projectId);

  // `findings` overrides the run's copy: same findings, but carrying their
  // persisted uuids, which is what /actions/generate needs to reference.
  return c.json({
    projectId,
    ...result,
    findings,
    run,
    proposedActions,
    content: { pageScores: contentResult.pageScores, pagesWithoutContent: contentResult.pagesWithoutContent },
  });
});

/**
 * C3.2 "at scale": when the caller opts in with a `target`, propose meta
 * title/description fixes for every eligible finding from this crawl in one
 * call, instead of the caller looping `/actions/generate` once per finding.
 * Scoped to meta only (not schema/robots/redirect) — those need entity facts
 * or evidence this route doesn't have reason to assume the caller wants
 * auto-applied. Skips a finding that already has any Action, so a re-audit
 * of an unchanged site doesn't pile up duplicate proposals.
 */
const META_AUTO_ISSUE_TYPES = new Set(['meta-title-missing', 'meta-description-missing']);

async function autoProposeMetaFixes(
  db: Db,
  findings: Finding[],
  pages: CrawledPage[],
  target: DeployTarget,
) {
  const eligible = findings.filter((f) => META_AUTO_ISSUE_TYPES.has(f.issueType));
  if (eligible.length === 0) return [];

  const already = await findingIdsWithActions(db, eligible.map((f) => f.id));
  const pageByUrl = new Map(pages.map((p) => [p.url, p]));

  const created = [];
  for (const finding of eligible) {
    if (already.has(finding.id)) continue;
    const url = (finding.evidence as { url?: string }).url;
    const page = url ? pageByUrl.get(url) : undefined;
    const ctx: ActionContext = {
      url: url ?? '',
      target,
      currentTitle: page?.title,
      currentMetaDescription: page?.metaDescription,
    };
    for (const action of generateActions(finding, ctx)) {
      created.push(await createAction(db, action));
    }
  }
  return created;
}

/**
 * The project's finding inventory — the read side of the audit (B1 → the
 * dashboard's Audit view). `/audit` persisted findings that nothing could ever
 * read back, which is why that view rendered mocks.
 *
 * `healthScore` comes from the newest recorded run, not from these findings: it
 * is normalized by pages audited, so recomputing it here would silently change
 * its meaning. It is null for a project that has never been audited — that is a
 * real answer, and better than telling a new user their unscanned site scores
 * 100.
 */
app.get('/projects/:projectId/audit', async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  const projectId = c.req.param('projectId');
  const [findings, run] = await Promise.all([
    listFindingsByProject(db, projectId),
    latestAuditRun(db, projectId),
  ]);
  return c.json({
    findings,
    healthScore: run?.healthScore ?? null,
    lastRunAt: run?.createdAt ?? null,
    pagesAudited: run?.pagesAudited ?? null,
  });
});

/**
 * Generate the executable Action(s) for a diagnosis Finding — the executable
 * half of the moat contract (C1/C2/C3.2/C4.4). The Finding comes from B1
 * diagnosis; `context` supplies the page facts (entity, current title, robots.txt)
 * needed to build a concrete before→after diff. Persists each as `proposed` so
 * it enters the Fix Queue with a real id for the lifecycle endpoints below.
 */
app.post('/projects/:projectId/actions/generate', async (c) => {
  const raw = await readJson(c);
  if (raw === UNPARSEABLE) return c.json({ error: 'body is not valid JSON' }, 400);
  // An Action built from a malformed context carries the hole all the way to the
  // insert: a missing `target` becomes postgres.js' UNDEFINED_VALUE, which is a
  // 500 blaming us for the caller's body. Reject it here, naming the field.
  const invalid = checkGenerateBody(raw);
  if (invalid) {
    return c.json({ error: `invalid ${invalid.field}: ${invalid.message}`, field: invalid.field }, 400);
  }
  const body = raw as { finding: Finding; context: ActionContext };
  const projectId = c.req.param('projectId');
  const db = createDb(c.env.DATABASE_URL);

  // `finding.id` becomes actions.finding_id, a uuid FK, and is caller-supplied —
  // exactly the situation the /audit entity check above exists for. Unchecked, a
  // finding that isn't this project's either trips the FK as a 500 (or, if it is
  // not a uuid at all, a `invalid input syntax` 500), or — worse — lets one
  // project hang an Action off another project's finding.
  if (!(await findingBelongsToProject(db, body.finding.id, projectId))) {
    return c.json({ error: 'finding does not belong to this project', findingId: body.finding.id }, 400);
  }

  const generated = generateActions(body.finding, body.context);
  const actions = await Promise.all(generated.map((action) => createAction(db, action)));
  if (actions.length > 0) await markFirstFixProposed(db, projectId);
  return c.json({ projectId, actions });
});

/**
 * The project's Fix Queue (C1 kanban). Reads the persisted queue rather than the
 * generate call's return value, so a reload shows real lifecycle state — this is
 * the read side the dashboard's board renders.
 */
app.get('/projects/:projectId/actions', async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  const actions = await listActionsByProject(db, c.req.param('projectId'));
  return c.json({ actions });
});

app.get('/projects/:projectId/actions/:actionId', async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  const action = await getAction(db, c.req.param('actionId'));
  if (!action) return c.json({ error: 'action not found' }, 404);
  return c.json({ action });
});

/**
 * Fix Queue lifecycle (C1 core). Each endpoint loads the persisted Action,
 * applies @engine/actions' guarded state-machine transition (illegal moves
 * throw → 409), and saves the result with its appended audit entry. `deploy`
 * only flips status: the edge-worker deploy target (apps/workers) reads
 * `deployed` actions live and applies their diffs per-request — there is no
 * separate push step for M1.4's Cloudflare Worker path.
 */
/**
 * Who to record in the immutable audit log (C1.8). For a signed-in human this
 * is their verified identity, never the caller-supplied `actor` — an audit
 * trail you can write yourself into is not an audit trail. A trusted machine
 * principal may still label itself: the shared service token proves only that
 * *some* internal caller holds it, so its self-report (which health check
 * fired, which runner reported) is strictly more information than
 * `service:internal` alone, and it is already inside the trust boundary.
 */
function auditActor(user: AuthUser, claimedActor?: string): string {
  if (user.isService) return claimedActor ?? user.id;
  return user.email ?? user.id;
}

function actionTransitionHandler(to: 'approved' | 'deployed' | 'rolled_back') {
  return async (c: Context<{ Bindings: Env; Variables: { user: AuthUser } }>) => {
    const body = await c.req
      .json<{ actor?: string; detail?: object }>()
      .catch(() => ({}) as { actor?: string; detail?: object });
    const db = createDb(c.env.DATABASE_URL);
    const action = await getAction(db, c.req.param('actionId') as string);
    if (!action) return c.json({ error: 'action not found' }, 404);

    // C4.5: a 'github-pr' target has no live-request path to apply a diff
    // through (unlike edge-worker/cms-plugin) — 'deployed' here means
    // "opened the PR", so the export happens synchronously as part of this
    // transition rather than a separate push step.
    let detail = body.detail;
    if (to === 'deployed' && action.target.kind === 'github-pr') {
      if (!c.env.GITHUB_TOKEN) {
        return c.json({ error: 'GitHub PR export is not configured (set GITHUB_TOKEN)' }, 503);
      }
      try {
        const pr = await exportActionAsPr(c.env.GITHUB_TOKEN, action);
        detail = { ...detail, prUrl: pr.url, prNumber: pr.number };
      } catch (err) {
        return c.json({ error: `GitHub PR export failed: ${(err as Error).message}` }, 502);
      }
    }

    try {
      const next = transition(action, to, defaultEnv(), auditActor(c.get('user'), body.actor), detail);
      const saved = await saveActionTransition(db, next);
      if (to === 'deployed') await markFirstFixDeployed(db, c.req.param('projectId') as string);
      return c.json({ action: saved });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 409);
    }
  };
}

app.post('/projects/:projectId/actions/:actionId/approve', actionTransitionHandler('approved'));
app.post('/projects/:projectId/actions/:actionId/deploy', actionTransitionHandler('deployed'));
app.post('/projects/:projectId/actions/:actionId/rollback', actionTransitionHandler('rolled_back'));

/**
 * Verify a `deployed` Action landed on the live surface (M1.4/M1.5) before
 * moving it to `verified`. Caller supplies the post-deploy content it fetched
 * (rendered HTML for schema/meta, robots.txt text for robots) — same pattern
 * as /audit and /pulse: the fetch transport is out-of-band, the check itself
 * (@engine/deploy) is pure and integration-testable here.
 */
app.post('/projects/:projectId/actions/:actionId/verify', async (c) => {
  const body = await c.req.json<{ actor?: string; renderedHtml?: string; robotsTxt?: string }>();
  const db = createDb(c.env.DATABASE_URL);
  const action = await getAction(db, c.req.param('actionId'));
  if (!action) return c.json({ error: 'action not found' }, 404);

  const matched =
    action.type === 'robots'
      ? verifyRobotsDeploy(body.robotsTxt ?? '', action)
      : verifyHtmlDeploy(body.renderedHtml ?? '', action);
  if (!matched) {
    return c.json({ error: 'verification failed: deployed content does not match the proposed diff' }, 409);
  }

  try {
    const next = transition(action, 'verified', defaultEnv(), auditActor(c.get('user'), body.actor));
    const saved = await saveActionTransition(db, next);
    return c.json({ action: saved });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 409);
  }
});

/**
 * E onboarding activation (M1.6). `GET /onboarding` returns the checklist plus
 * the two roadmap KPIs: time to first insight (E2, target <10 min) and time
 * to first proposed fix (E3, target <48h), both measured from domain-connect.
 */
app.get('/projects/:projectId/onboarding', async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  const progress = await getOnboardingProgress(db, c.req.param('projectId'));
  return c.json({
    progress,
    kpis: {
      msToFirstInsight: durationMs(progress.domainConnectedAt, progress.firstInsightAt),
      msToFirstFixProposed: durationMs(progress.domainConnectedAt, progress.firstFixProposedAt),
    },
  });
});

app.post('/projects/:projectId/onboarding/domain-connected', async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  const progress = await markDomainConnected(db, c.req.param('projectId'));
  return c.json({ progress });
});

/**
 * E1 GSC connect wizard, step 1: build the Google OAuth consent URL. Pure URL
 * construction — no live call, so it's testable without a real Google Cloud
 * OAuth client. `GSC_CLIENT_ID`/`GSC_REDIRECT_URI` are unset until that
 * client exists; this 500s clearly rather than emitting a broken URL.
 */
app.get('/projects/:projectId/onboarding/gsc/connect-url', (c) => {
  const { GSC_CLIENT_ID, GSC_REDIRECT_URI } = c.env;
  if (!GSC_CLIENT_ID || !GSC_REDIRECT_URI) {
    return c.json({ error: 'GSC OAuth is not configured (GSC_CLIENT_ID/GSC_REDIRECT_URI)' }, 500);
  }
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', GSC_CLIENT_ID);
  url.searchParams.set('redirect_uri', GSC_REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('scope', 'https://www.googleapis.com/auth/webmasters.readonly');
  url.searchParams.set('state', c.req.param('projectId'));
  return c.json({ url: url.toString() });
});

/**
 * E1 GSC connect wizard, step 2: the OAuth redirect target. Exchanges the
 * authorization code for tokens via Google's token endpoint — a real network
 * call to Google, so this path is typechecked and logically correct but not
 * exercised against a live Google Cloud OAuth client in this environment.
 * Token storage (where the access/refresh token actually lands) is left for
 * when a real client exists to test against, rather than guessed at now.
 */
app.get('/oauth/gsc/callback', async (c) => {
  const { GSC_CLIENT_ID, GSC_CLIENT_SECRET, GSC_REDIRECT_URI } = c.env;
  const code = c.req.query('code');
  const projectId = c.req.query('state');
  if (!GSC_CLIENT_ID || !GSC_CLIENT_SECRET || !GSC_REDIRECT_URI) {
    return c.json({ error: 'GSC OAuth is not configured' }, 500);
  }
  if (!code || !projectId) return c.json({ error: 'missing code or state' }, 400);

  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: GSC_CLIENT_ID,
      client_secret: GSC_CLIENT_SECRET,
      redirect_uri: GSC_REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenResp.ok) return c.json({ error: 'token exchange failed' }, 502);

  const db = createDb(c.env.DATABASE_URL);
  const progress = await markGscConnected(db, projectId);
  return c.json({ progress });
});

/**
 * G3 Stripe webhook. Signature-verified (@engine/billing, no Stripe SDK) so
 * this is fully exercisable without a live Stripe account — see
 * packages/billing's tests. `STRIPE_PRICE_TO_TIER` maps Stripe price ids to
 * our PlanTier; subscriptions must carry `metadata.accountId` (set at
 * checkout) so we know which account to update.
 */
app.post('/billing/webhook', async (c) => {
  const { STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_TO_TIER } = c.env;
  if (!STRIPE_WEBHOOK_SECRET) return c.json({ error: 'billing webhook is not configured' }, 500);

  const payload = await c.req.text();
  const sigHeader = c.req.header('stripe-signature') ?? '';
  const validSignature = await verifyStripeSignature(payload, sigHeader, STRIPE_WEBHOOK_SECRET);
  if (!validSignature) return c.json({ error: 'invalid signature' }, 400);

  const event = JSON.parse(payload) as StripeWebhookEvent;
  const priceToTier: Record<string, PlanTier> = STRIPE_PRICE_TO_TIER ? JSON.parse(STRIPE_PRICE_TO_TIER) : {};
  const mapped = mapStripeSubscriptionEvent(event, priceToTier);
  if (!mapped) return c.json({ received: true, applied: false });

  const db = createDb(c.env.DATABASE_URL);
  const subscription = await upsertSubscription(db, mapped.accountId, mapped.update);
  return c.json({ received: true, applied: true, subscription });
});

/**
 * M1.7 "Starter/Growth purchasable via Stripe". Creates a real Stripe Checkout
 * Session and returns its URL for the dashboard to redirect the browser to —
 * the missing other half of `/billing/webhook`, which could already receive a
 * subscription update but had no route that could create the subscription a
 * customer would actually pay for.
 *
 * `STRIPE_PRICE_TO_TIER` (already required for the webhook) is reused here,
 * inverted, rather than adding a second price/tier map that could drift out
 * of sync with the one the webhook trusts.
 */
app.post('/accounts/:accountId/billing/checkout', async (c) => {
  const { STRIPE_SECRET_KEY, STRIPE_PRICE_TO_TIER } = c.env;
  if (!STRIPE_SECRET_KEY) {
    return c.json({ error: 'Stripe checkout is not configured (set STRIPE_SECRET_KEY)' }, 503);
  }

  const raw = await readJson(c);
  if (raw === UNPARSEABLE) return c.json({ error: 'body is not valid JSON' }, 400);
  const invalid = checkCreateCheckoutBody(raw);
  if (invalid) {
    return c.json({ error: `invalid ${invalid.field}: ${invalid.message}`, field: invalid.field }, 400);
  }
  const body = raw as { tier: PlanTier; successUrl: string; cancelUrl: string; customerEmail?: string };

  const priceToTier: Record<string, PlanTier> = STRIPE_PRICE_TO_TIER ? JSON.parse(STRIPE_PRICE_TO_TIER) : {};
  const priceId = resolvePriceId(body.tier, priceToTier);
  if (!priceId) {
    return c.json({ error: `no Stripe price configured for tier '${body.tier}'`, field: 'tier' }, 400);
  }

  const sessionBody = buildCheckoutSessionBody({
    priceId,
    accountId: c.req.param('accountId'),
    successUrl: body.successUrl,
    cancelUrl: body.cancelUrl,
    customerEmail: body.customerEmail,
  });
  const session = await createCheckoutSession(STRIPE_SECRET_KEY, sessionBody);
  return c.json({ checkoutUrl: session.url, sessionId: session.id });
});

/** G4/G5: current plan, live usage, and whether the account is over its plan's caps. */
app.get('/accounts/:accountId/plan', async (c) => {
  const accountId = c.req.param('accountId');
  const invalid = checkUuidParam(accountId, 'accountId');
  if (invalid) return c.json({ error: invalid.message, field: invalid.field }, 400);
  const db = createDb(c.env.DATABASE_URL);
  const [subscription, usage] = await Promise.all([getSubscription(db, accountId), getUsageCounters(db, accountId)]);
  const planTier = subscription?.planTier ?? 'starter';
  return c.json({ subscription, usage, planTier, overLimit: isOverLimit(usage, planTier) });
});

export default app;
