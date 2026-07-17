import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import {
  unifiedVisibilityScore,
  DEFAULT_CHANNEL_MIX,
  type SurfaceScores,
  type ChannelMix,
} from '@engine/scoring';
import { runAudit, type CrawledPage } from '@engine/diagnosis';
import { generateActions, transition, defaultEnv, type ActionContext } from '@engine/actions';
import { verifyHtmlDeploy, verifyRobotsDeploy } from '@engine/deploy';
import { verifyStripeSignature, mapStripeSubscriptionEvent, isOverLimit, type StripeWebhookEvent } from '@engine/billing';
import { evaluateReadiness } from '@engine/config';
import { createSerpConnector, createLlmConnectors, type SerpQuery, type PromptQuery } from '@engine/connectors';
import { durationMs, type Finding, type PlanTier } from '@engine/core';
import { createDb } from './db.js';
import { requireAuth, type AuthEnv, type AuthUser } from './middleware/auth.js';
import { createEntity, listEntitiesByProject } from './repositories/entities.js';
import { createAction, getAction, listActionsByProject, saveActionTransition } from './repositories/actions.js';
import { upsertFindings } from './repositories/findings.js';
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
 * Persisting results to ClickHouse is out-of-band (same pattern as /audit).
 */
app.post('/projects/:projectId/rank/poll', async (c) => {
  const connector = createSerpConnector(c.env as unknown as Record<string, string | undefined>);
  if (!connector) {
    return c.json({ error: 'SERP provider not configured (set SERPER_API_KEY)' }, 503);
  }
  const body = await c.req.json<{ queries: SerpQuery[] }>();
  const results = await Promise.all((body.queries ?? []).map((q) => connector.fetch(q)));
  return c.json({ projectId: c.req.param('projectId'), vendor: connector.vendor, results });
});

/**
 * A2 AI-visibility poll. Polls every configured LLM engine (OpenAI and/or
 * Gemini) n times for the prompt and returns per-engine samples with citation
 * events. Returns 503 when no LLM key is wired. Aggregating samples into a
 * confidence-band `CitationMeasurement` (A2.6) happens upstream in @engine/scoring.
 */
app.post('/projects/:projectId/ai/poll', async (c) => {
  const connectors = createLlmConnectors(c.env as unknown as Record<string, string | undefined>);
  if (connectors.length === 0) {
    return c.json({ error: 'No LLM engine configured (set OPENAI_API_KEY and/or GEMINI_API_KEY)' }, 503);
  }
  const body = await c.req.json<{ query: PromptQuery; nSamples?: number }>();
  const nSamples = Math.min(Math.max(body.nSamples ?? 3, 1), 5); // A2 n=3–5
  const results = await Promise.all(connectors.map((engine) => engine.poll(body.query, nSamples)));
  return c.json({ projectId: c.req.param('projectId'), engines: connectors.map((e) => e.engine), results });
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

/**
 * Compute the A3 Unified Visibility Score for a project from already-assembled
 * per-surface SoV inputs. This keeps the scoring math (pure, in @engine/scoring)
 * separate from surface assembly: once the A1/A2/B5 ClickHouse rollups are wired
 * (M1.2), a repository will populate `surfaces` server-side. For now the caller
 * supplies them, which also makes the endpoint directly integration-testable.
 */
app.post('/projects/:projectId/pulse', async (c) => {
  const body = await c.req.json<{ surfaces: SurfaceScores; mix?: ChannelMix }>();
  const score = unifiedVisibilityScore(body.surfaces, body.mix ?? DEFAULT_CHANNEL_MIX);
  return c.json({ projectId: c.req.param('projectId'), score });
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
  const body = await c.req.json<{ pages: CrawledPage[] }>();
  const pages = body.pages ?? [];
  const projectId = c.req.param('projectId');
  const db = createDb(c.env.DATABASE_URL);
  const result = runAudit(pages);

  // A page names the entity it belongs to, and that id becomes findings.entity_id.
  // Check the entities are actually this project's before writing: an unchecked
  // id would either trip the FK as a 500, or — worse, since the id is
  // caller-supplied — let one project hang findings off another project's entity.
  const cited = [...new Set(pages.map((p) => p.entityId))];
  if (cited.length > 0) {
    const known = new Set((await listEntitiesByProject(db, projectId)).map((e) => e.id));
    const unknown = cited.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      return c.json({ error: 'pages cite entities that do not belong to this project', unknownEntityIds: unknown }, 400);
    }
  }

  const findings = await upsertFindings(db, result.findings);
  await markFirstCrawl(db, projectId);
  if (findings.length > 0) await markFirstInsight(db, projectId);
  // `findings` overrides the run's copy: same findings, but carrying their
  // persisted uuids, which is what /actions/generate needs to reference.
  return c.json({ projectId, ...result, findings });
});

/**
 * Generate the executable Action(s) for a diagnosis Finding — the executable
 * half of the moat contract (C1/C2/C3.2/C4.4). The Finding comes from B1
 * diagnosis; `context` supplies the page facts (entity, current title, robots.txt)
 * needed to build a concrete before→after diff. Persists each as `proposed` so
 * it enters the Fix Queue with a real id for the lifecycle endpoints below.
 */
app.post('/projects/:projectId/actions/generate', async (c) => {
  const body = await c.req.json<{ finding: Finding; context: ActionContext }>();
  const projectId = c.req.param('projectId');
  const db = createDb(c.env.DATABASE_URL);
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
    try {
      const next = transition(action, to, defaultEnv(), auditActor(c.get('user'), body.actor), body.detail);
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

/** G4/G5: current plan, live usage, and whether the account is over its plan's caps. */
app.get('/accounts/:accountId/plan', async (c) => {
  const accountId = c.req.param('accountId');
  const db = createDb(c.env.DATABASE_URL);
  const [subscription, usage] = await Promise.all([getSubscription(db, accountId), getUsageCounters(db, accountId)]);
  const planTier = subscription?.planTier ?? 'starter';
  return c.json({ subscription, usage, planTier, overLimit: isOverLimit(usage, planTier) });
});

export default app;
