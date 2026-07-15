import { Hono, type Context } from 'hono';
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
import { durationMs, type Finding, type PlanTier } from '@engine/core';
import { createDb } from './db.js';
import { createEntity, listEntitiesByProject } from './repositories/entities.js';
import { createAction, getAction, saveActionTransition } from './repositories/actions.js';
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

interface Env {
  DATABASE_URL: string;
  GSC_CLIENT_ID?: string;
  GSC_CLIENT_SECRET?: string;
  GSC_REDIRECT_URI?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  /** JSON map of Stripe price id -> our PlanTier, e.g. {"price_growth_monthly":"growth"}. */
  STRIPE_PRICE_TO_TIER?: string;
}

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.json({ status: 'ok' }));

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
  const result = runAudit(body.pages ?? []);
  const projectId = c.req.param('projectId');
  const db = createDb(c.env.DATABASE_URL);
  await markFirstCrawl(db, projectId);
  if (result.findings.length > 0) await markFirstInsight(db, projectId);
  return c.json({ projectId, ...result });
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
function actionTransitionHandler(to: 'approved' | 'deployed' | 'rolled_back') {
  return async (c: Context<{ Bindings: Env }>) => {
    const body = await c.req
      .json<{ actor?: string; detail?: object }>()
      .catch(() => ({}) as { actor?: string; detail?: object });
    const db = createDb(c.env.DATABASE_URL);
    const action = await getAction(db, c.req.param('actionId') as string);
    if (!action) return c.json({ error: 'action not found' }, 404);
    try {
      const next = transition(action, to, defaultEnv(), body.actor ?? 'system', body.detail);
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
    const next = transition(action, 'verified', defaultEnv(), body.actor ?? 'system');
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
