import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import {
  unifiedVisibilityScore,
  DEFAULT_CHANNEL_MIX,
  type SurfaceScores,
  type ChannelMix,
} from '@engine/scoring';
import { runAudit, type CrawledPage } from '@engine/diagnosis';
import { runContentAudit } from '@engine/content';
import {
  generateActions,
  generateContentAction,
  transition,
  reviewMarked,
  requiresHumanReview,
  defaultEnv,
  type ActionContext,
} from '@engine/actions';
import { verifyHtmlDeploy, verifyRobotsDeploy, verifyGbpDeploy, exportActionAsPr, getGbpAccessToken, deployGbpAction } from '@engine/deploy';
import {
  verifyStripeSignature,
  mapStripeSubscriptionEvent,
  isOverLimit,
  PLAN_LIMITS,
  resolvePriceId,
  buildCheckoutSessionBody,
  createCheckoutSession,
  type StripeWebhookEvent,
} from '@engine/billing';
import { evaluateReadiness } from '@engine/config';
import {
  verifyLocalCredentials,
  signLocalSession,
  localRosterSize,
  verifyPassword,
  hashPassword,
  needsRehash,
  dummyHash,
  type LocalUser,
} from '@engine/auth';
import { getCredentialByEmail, updatePasswordHash } from './repositories/userCredentials.js';
import {
  createSerpConnector,
  createLlmConnectors,
  createStreamingLlmConnector,
  buildCitationEvent,
  isKnownLlmModel,
  LLM_MODEL_CHOICES,
  DEFAULT_LLM_MODEL_ID,
  type SerpQuery,
  type PromptQuery,
} from '@engine/connectors';
import { durationMs, isEntityKind, isEntityRole, type Action, type Entity, type Finding, type PlanTier, type DeployTarget } from '@engine/core';
import { classifyIntent, transliterateToDevanagari, generatePromptSeeds } from '@engine/keywords';
import { createDb, type Db } from './db.js';
import { checkAuditRequestBody, checkAuditRequestFinishBody, AUDIT_REQUEST_MAX_PAGES_DEFAULT,
  checkAuditBody,
  checkGenerateBody,
  checkCreateKeywordConfigBody,
  checkCreateCheckoutBody,
  checkUuidParam,
  checkCreateAccountBody,
  checkCreateProjectBody,
  checkBrandingBody,
  checkDeployTargetBody,
  checkLoginBody,
} from './validate.js';
import { requireAuth, type AuthEnv, type AuthUser } from './middleware/auth.js';
import { integrationsRoutes } from './routes/integrations.js';
import { runScheduledSync } from './repositories/googleSync.js';
import { getAccessToken, ConnectionUnavailableError } from './repositories/integrations.js';
import { keyringFrom } from './repositories/oauthFlows.js';
import { resolveSerpKey } from './repositories/serpKey.js';
import { runScheduledRankPoll, RANK_POLL_CRON } from './repositories/rankPoll.js';
import {
  runScheduledAiPoll,
  citationTargets,
  AI_POLL_CRON,
  AI_VISIBILITY_LOOKBACK_DAYS,
  MAX_PROMPTS_PER_ENTITY,
  MAX_PROMPT_LENGTH,
} from './repositories/aiPoll.js';
import { isPlatformAdmin, getPlatformClientStatus } from './repositories/platformCredentials.js';
import {
  createEntity,
  listEntitiesByProject,
  getEntityInProject,
  setEntitySchemaType,
  setEntityPrompts,
} from './repositories/entities.js';
import { buildEntityCopilotSummary } from './repositories/entityCopilot.js';
import { answerQuestion, logCopilotQuery } from './repositories/copilotQuery.js';
import { PHRASING_SYSTEM_PROMPT } from '@engine/copilot';
import { runProjectEntityAudit, listEntityStrengths } from './repositories/entityAudit.js';
import {
  setLocalProfile,
  getLocalProfile,
  runProjectLocalAudit,
  listLocalVisibility,
  type ProfileInput,
} from './repositories/local.js';
import {
  addCompetitor,
  removeCompetitor,
  listCompetitors,
  runProjectCompetitorAudit,
  listCompetitorGaps,
  addCompetitorByDomain,
  recordCompetitorStandings,
} from './repositories/competitor.js';
import { runProjectOffsiteAudit, listCitationOpportunities } from './repositories/offsite.js';
import {
  createAction,
  getAction,
  listActionsByProject,
  saveActionTransition,
  saveActionReview,
  findingIdsWithActions,
} from './repositories/actions.js';
import { findingBelongsToProject, getFindingInProject, listFindingsByProject, upsertFindings } from './repositories/findings.js';
import { recordAuditRun, latestAuditRun, type AuditRunCoverage } from './repositories/auditRuns.js';
import { entityJsonLdProperties, entitySchemaType } from './repositories/entityJsonLd.js';
import { proposeForFinding, PROPOSE_BATCH_CAP, type ProposeSkip } from './repositories/propose.js';
import { createVerifyRequest, latestVerifyRequest, finishVerifyRequest, getAuditRequest } from './repositories/auditRequests.js';
import {
  recordDeterministicAuditRun,
  latestDeterministicAuditRun,
  runEntityAuditAfterCrawl,
  runScheduledDeterministicAudits,
} from './repositories/deterministicAudits.js';
import { upsertCrawledPages, getCrawledPage, listInternalLinkTargets } from './repositories/crawledPages.js';
import { getProjectDeployTarget, setProjectDeployTarget } from './repositories/projectTarget.js';
import { insertSerpPositions } from './repositories/rankPositions.js';
import { insertCitationEvents, citedShareByEngine } from './repositories/citationEvents.js';
import { assembleSurfaceScores } from './repositories/pulseRollup.js';
import { brandTerms, searchSummary, trafficSummary, type SyncState } from './repositories/googleMetrics.js';
import { listAssignments, listConnections, connectedProvidersByAccount } from './repositories/integrations.js';
import { getProject,
  upsertUser,
  createAccount,
  isAccountMember,
  getProjectAccountId,
  listAccountsForUser,
  createProject,
  getAccount,
  updateAccountBranding,
  listProjectsByAccount,
} from './repositories/accounts.js';
import { renderAccountReportHtml, type ProjectReportRow } from './report.js';
import {
  createKeywordConfig,
  listKeywordConfigsByEntity,
  listTrackedKeywords,
  deleteKeywordConfig,
} from './repositories/keywordConfigs.js';
import { listPendingCmsPluginActions } from './repositories/cmsPluginActions.js';
import {
  getOnboardingProgress,
  markDomainConnected,
  markFirstCrawl,
  markFirstInsight,
  markFirstFixProposed,
  markFirstFixDeployed,
} from './repositories/onboarding.js';
import { getSubscription, upsertSubscription, getUsageCounters } from './repositories/billing.js';
import {
  createAuditRequest,
  latestAuditRequest,
  listQueuedAuditRequests,
  claimAuditRequest,
  finishAuditRequest,
  type AuditRequestOutcome,
} from './repositories/auditRequests.js';
import { dispatchCrawlWorkflow, type DispatchEnv } from './githubDispatch.js';

interface Env extends AuthEnv, DispatchEnv {
  DATABASE_URL: string;
  /**
   * Bootstrap admin list. The stored `users.platform_role` is authoritative;
   * this only breaks the circle of "promotion happens on a screen only an
   * admin can reach" for the very first one.
   */
  PLATFORM_ADMIN_EMAILS?: string;
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
  /**
   * C5 GBP automation, **legacy single-tenant fallback**. One owner's consent
   * for the whole deployment — correct while nothing was multi-tenant, wrong
   * once two customers have Business Profiles, because the second customer's
   * fix would be written to the first one's listing.
   *
   * The deploy route now reads the project's own account connection
   * (`integration_connections`, migration 0014) and only falls back to these if
   * no connection exists. Remove them once every account has connected.
   */
  GBP_REFRESH_TOKEN?: string;
  GBP_CLIENT_ID?: string;
  GBP_CLIENT_SECRET?: string;
  /**
   * Per-account Google integrations (GSC + GA4 + GBP, migration 0014). One
   * OAuth client serves all three — they differ only by scope. These replace
   * the single-tenant `GSC_*` and `GBP_*` pairs above, which hold one
   * credential for the whole deployment; those stay until the connectors that
   * read them are migrated over.
   */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
  /** base64 of 32 random bytes (`openssl rand -base64 32`). Seals refresh tokens at rest. */
  ENCRYPTION_KEY?: string;
  /** The rotation form of the above: `v2:<key>,v1:<key>`, newest first. Either satisfies the seal. */
  ENCRYPTION_KEYS?: string;
  /** Signs the OAuth `state` parameter, so a callback cannot be pointed at another account. */
  OAUTH_STATE_SECRET?: string;
  /** Dashboard origin, for the post-consent return link. */
  DASHBOARD_URL?: string;
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
    // 'PATCH' added for M2.5's branding update route — the browser's real
    // PATCH request otherwise fails after a *successful* preflight, since the
    // preflight itself reports which methods are allowed. 'PUT'/'DELETE' added
    // for the integration assign/disconnect routes, which hit the same trap.
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
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
 *  - `GET /oauth/google/callback` — a browser redirect target from Google. It
 *    carries no Authorization header and cannot; the **signed `state`** is what
 *    authenticates it, naming the account and user we minted it for
 *    (`packages/auth/src/oauthState.ts`). This replaces the old
 *    `/oauth/gsc/callback`, whose `state` was a bare project id.
 *  - `GET /integrations/providers` — a static description of what can be
 *    connected. No account data, no secrets.
 */
app.use('/health/integrations', requireAuth);
app.use('/projects/*', requireAuth);
app.use('/accounts/*', requireAuth);
// Machine-only routes for the crawl runner. requireAuth admits a service token
// or a person; the routes themselves then refuse the person (see requireService).
app.use('/internal/*', requireAuth);
// Engine's own OAuth client lives behind these. The handlers check
// PLATFORM_ADMIN_EMAILS, but that check reads the authenticated user's email —
// without this line there is no authenticated user for it to read, and the
// admin gate is comparing against nothing.
app.use('/platform/*', requireAuth);

app.get('/health', (c) => c.json({ status: 'ok' }));

/**
 * Resolve a presented credential to a user, from the database first and the
 * `LOCAL_AUTH_USERS` secret second.
 *
 * **The database is authoritative once a row exists for that address.** A
 * stored credential that fails to verify is a failed sign-in, full stop — it
 * does not then get a second try against the environment roster. Without that
 * rule, changing someone's password in the database would not actually change
 * it: a stale roster entry left in the Worker secret would keep letting the
 * old one through, and nothing would report the conflict.
 *
 * The roster remains as a fallback for addresses with no stored credential, so
 * local development works with no database and the deployment did not have to
 * be cut over in one step. It is the transition path, not the destination.
 *
 * Timing: a miss in the database spends one dummy derivation before falling
 * through. PBKDF2 is deliberately slow, so returning early on "no such user"
 * would make an unknown address measurably faster than a wrong password and
 * turn this endpoint into a roster oracle over the network.
 */
type AuthOutcome =
  | { kind: 'ok'; user: LocalUser }
  | { kind: 'rejected' }
  /** Nothing could answer the question — not "wrong password". */
  | { kind: 'unavailable' };

async function authenticate(
  env: Env,
  email: string | undefined,
  password: string | undefined,
): Promise<AuthOutcome> {
  const address = (email ?? '').trim().toLowerCase();
  const presented = password ?? '';
  const rosterConfigured = localRosterSize(env.LOCAL_AUTH_USERS) > 0;

  if (env.DATABASE_URL) {
    let stored: Awaited<ReturnType<typeof getCredentialByEmail>> = null;
    let reachable = true;
    try {
      stored = await getCredentialByEmail(createDb(env.DATABASE_URL), address);
    } catch (err) {
      reachable = false;
      console.error('credential lookup failed', err);
    }

    if (stored) {
      const ok = await verifyPassword(presented, stored.passwordHash);
      if (!ok) return { kind: 'rejected' };
      // Upgrade the work factor on the way past — this is the only moment the
      // plaintext exists to re-derive from. Best effort: a failed re-hash must
      // not fail the sign-in that just succeeded.
      if (needsRehash(stored.passwordHash)) {
        try {
          await updatePasswordHash(createDb(env.DATABASE_URL), stored.user.id, await hashPassword(presented));
        } catch (err) {
          console.error('password re-hash failed', err);
        }
      }
      return { kind: 'ok', user: stored.user };
    }

    // The credential store is the only configured source and it did not
    // answer. Saying "those credentials are not valid" here would be a lie
    // with a cost: the person retypes a correct password, doubts it, and the
    // outage looks like their mistake. Same reasoning that removed the dev
    // session bypass in August — unreachable is reported as unreachable.
    if (!reachable && !rosterConfigured) return { kind: 'unavailable' };

    // A real miss, not an outage. Spend a derivation before falling through:
    // PBKDF2 is slow by design, so returning early here would make an unknown
    // address measurably faster than a wrong password.
    if (reachable) await verifyPassword(presented, dummyHash());
  }

  const user = verifyLocalCredentials(address, presented, env.LOCAL_AUTH_USERS);
  return user ? { kind: 'ok', user } : { kind: 'rejected' };
}

/**
 * Credential sign-in for the fixed pre-alpha roster.
 *
 * Public by necessity — it is how a caller *becomes* authenticated — and the
 * only unauthenticated route that can mint a principal. It exists because Neon
 * Auth's Google flow cannot sign anyone in to the deployed dashboard today
 * (the Pages origin is not on Neon Auth's trusted-origins list), and the
 * product has three users who need in. See `packages/auth/src/localAuth.ts`.
 *
 * Returns 503 when unconfigured rather than 401: "credential sign-in is not
 * enabled on this deployment" and "your password is wrong" are different
 * facts, and the sign-in screen says different things about them.
 *
 * Every rejection returns the same message and the same status. Distinguishing
 * "no such user" from "wrong password" turns a login form into a roster
 * oracle, and the roster is three people's email addresses.
 */
app.post('/auth/login', async (c) => {
  const secret = c.env.LOCAL_AUTH_SECRET;
  const rosterRaw = c.env.LOCAL_AUTH_USERS;
  if (!secret || (!c.env.DATABASE_URL && localRosterSize(rosterRaw) === 0)) {
    return c.json(
      { error: 'Credential sign-in is not configured on this deployment (LOCAL_AUTH_SECRET, and a database or LOCAL_AUTH_USERS).' },
      503,
    );
  }

  const raw = await readJson(c);
  if (raw === UNPARSEABLE) return c.json({ error: 'body is not valid JSON' }, 400);
  const invalid = checkLoginBody(raw);
  if (invalid) return c.json({ error: `invalid ${invalid.field}: ${invalid.message}`, field: invalid.field }, 400);
  const body = raw as { email: string; password: string };

  const outcome = await authenticate(c.env, body.email, body.password);
  if (outcome.kind === 'unavailable') {
    return c.json({ error: 'Credential sign-in is temporarily unavailable on this deployment.' }, 503);
  }
  if (outcome.kind === 'rejected') return c.json({ error: 'Those credentials are not valid.' }, 401);
  const user = outcome.user;

  const token = await signLocalSession(user, secret);

  // Create the `users` row now, at sign-in, rather than leaving it to the
  // first authenticated request. `account_members.user_id` FKs to it, so
  // without this the very first thing a new user does — create a client —
  // fails on a foreign key against a principal that has never been written.
  try {
    await upsertUser(createDb(c.env.DATABASE_URL), user);
  } catch (err) {
    // The credential is valid; the database is a separate concern. Signing in
    // still succeeds, and `upsertUser` runs again on the first API call.
    console.error('sign-in succeeded but upsertUser failed', err);
  }

  return c.json({ token, user: { id: user.id, email: user.email, name: user.name } });
});

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
 * Retrofitted ownership check for every `/projects/:projectId/*` route below.
 * Before M2.5's `account_members` existed there was nothing to check
 * membership against, so `requireAuth` only ever proved *some* caller was
 * signed in — any authenticated user could poll, read, or write any project
 * just by knowing its id. Mirrors the entity/finding ownership checks already
 * in these handlers ("check tenancy before spending credit/writing data"),
 * just for the `projectId` path param itself, once per route.
 *
 * Skipped for service callers (the crawl runner, edge worker auto-rollback):
 * they authenticate with the shared `INTERNAL_API_TOKEN`, not a Neon Auth
 * user id, so there is no `account_members` row to check — that shared
 * secret is already their trust boundary (same reasoning as `auditActor`
 * below).
 */
async function projectAccessError(
  db: Db,
  projectId: string,
  user: AuthUser,
): Promise<{ status: 403 | 404; body: { error: string; projectId: string } } | null> {
  if (user.isService) return null;
  const accountId = await getProjectAccountId(db, projectId);
  if (!accountId) return { status: 404, body: { error: 'project not found', projectId } };
  if (!(await isAccountMember(db, accountId, user.id))) {
    return { status: 403, body: { error: 'you are not a member of this project', projectId } };
  }
  return null;
}

/**
 * Integration readiness (pre-alpha wiring check). Reports, per external
 * integration (Google OAuth/GSC, Stripe, Serper SERP, OpenAI, Gemini),
 * whether its required secrets/vars are present — without ever echoing a
 * secret value. `mvpReady` is true only when every required-for-MVP
 * integration is fully configured. Drives the internal "what's wired?" view.
 */
/**
 * Which vendor keys *this deployment* has wired.
 *
 * Admin-only. It names environment variables and says which are missing, which
 * is operator information: a customer learning that `SERPER_API_KEY` is unset
 * gains nothing they can act on and sees the inside of someone else's
 * infrastructure. It was gated by `requireAuth` alone, which meant every
 * signed-in customer could read it.
 */
app.get('/health/integrations', async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  let admin = false;
  try {
    admin = await isPlatformAdmin(db, c.get('user'), c.env);
  } catch {
    admin = false;
  }
  if (!admin) return c.json({ error: 'not found' }, 404);
  const report = evaluateReadiness(c.env as unknown as Record<string, string | undefined>);
  return c.json(report);
});

/**
 * A1 rank poll. Fetches live SERP results for the supplied queries via the
 * configured SERP connector (Serper.dev by default), on the client's own
 * Serper key where one is connected and on the platform key otherwise
 * (`resolveSerpKey`). Returns 503 when neither exists, so a missing account
 * degrades cleanly instead of 500-ing.
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
  const projectId = c.req.param('projectId');
  const body = await c.req.json<{ queries: SerpQuery[]; entityId?: string }>();
  const db = createDb(c.env.DATABASE_URL);

  const accessError = await projectAccessError(db, projectId, c.get('user'));
  if (accessError) return c.json(accessError.body, accessError.status);

  // Whose key pays for this lookup: the client's own Serper connection, or
  // ours as the fallback. Resolved after the access check, so an unauthorised
  // caller never reaches a credential read. The project is read once for both
  // its account (whose key) and its domain (whose position to record).
  const project = await getProject(db, projectId);
  if (!project) return c.json({ error: 'project not found', projectId }, 404);
  const apiKey = await resolveSerpKey(db, project.accountId, await keyringFrom(c.env), c.env);
  const connector = createSerpConnector({
    ...(c.env as unknown as Record<string, string | undefined>),
    SERPER_API_KEY: apiKey ?? undefined,
  });
  if (!connector) {
    console.warn('SERP provider not configured: no client Serper connection and no SERPER_API_KEY');
    return c.json(
      { error: 'Search-ranking lookups are not set up for this client yet. Connect Serper on the Integrations screen.' },
      503,
    );
  }

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
    await insertSerpPositions(db, body.entityId, results, project.domain);
    // Same response, no extra lookup: see `recordCompetitorStandings`.
    await recordCompetitorStandings(db, projectId, body.entityId, results).catch((error: unknown) => {
      console.warn(
        `competitor standings not recorded for ${projectId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    });
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
    // The variable names belong in the Worker log, where the operator reads
    // them, not in a message a customer sees as a toast.
    console.warn('No LLM engine configured: set OPENAI_API_KEY and/or GEMINI_API_KEY');
    return c.json({ error: 'AI-answer sampling is not configured on this deployment.' }, 503);
  }
  const projectId = c.req.param('projectId');
  const body = await c.req.json<{ query: PromptQuery; nSamples?: number }>();
  const db = createDb(c.env.DATABASE_URL);

  const accessError = await projectAccessError(db, projectId, c.get('user'));
  if (accessError) return c.json(accessError.body, accessError.status);

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

/**
 * The models a customer may pick for a live answer, with the byline each one
 * is described by.
 *
 * A route rather than a constant in the dashboard bundle because the list is
 * a function of what this deployment's key can actually reach: step 1 found
 * that every GLM name the account was asked for is refused by the vendor, so
 * a hardcoded front-end list would offer models that 400. `defaultModel` is
 * what the interactive surfaces preselect.
 *
 * `pollModel` is reported separately and is not selectable. The scheduled poll
 * that fills `citation_events` stays on one model deliberately: a citation
 * band is a measurement over time, and mixing models inside one window would
 * show a change in the measuring instrument as a change in the brand's AI
 * visibility.
 */
app.get('/projects/:projectId/ai/models', async (c) => {
  const projectId = c.req.param('projectId');
  const db = createDb(c.env.DATABASE_URL);
  const accessError = await projectAccessError(db, projectId, c.get('user'));
  if (accessError) return c.json(accessError.body, accessError.status);

  const configured = Boolean((c.env as unknown as Record<string, string | undefined>).SARVAM_API_KEY);
  return c.json({
    models: configured ? LLM_MODEL_CHOICES : [],
    defaultModel: DEFAULT_LLM_MODEL_ID,
    pollModel: (c.env as unknown as Record<string, string | undefined>).SARVAM_MODEL ?? DEFAULT_LLM_MODEL_ID,
  });
});

/**
 * One streamed answer, for both surfaces that ask a model something live.
 *
 * Two modes, because "stream a model's tokens to a waiting browser" is the
 * shared part and the grounding is not:
 *
 *   mode 'prompt'  (AI answers) — ask the engine the customer's own prompt,
 *                  verbatim, and report afterwards whether the brand was
 *                  named. This is "what does an AI engine say about us".
 *   mode 'ask'     (Ask Engine) — answer from the customer's own data. The
 *                  deterministic, cited answer is computed first and sent
 *                  before a single model token, then the model streams a
 *                  rewording of it.
 *
 * The ordering in 'ask' mode is the design, not an implementation detail. The
 * Copilot's contract (packages/copilot) is that figures and citations are
 * built by the retrieval layer and are never model-authored; phrasing may
 * reword prose and nothing else. Sending the grounded answer first makes that
 * true of the streamed path as well — the answer a customer can act on has
 * already arrived when the model starts, so a model that fails, stalls or
 * truncates costs tone and nothing else.
 *
 * Nothing here writes `citation_events`. A single ad-hoc sample is not a
 * measurement: A2 stores citation rates as bands over n=3-5 samples, and
 * letting a person's "try this prompt" clicks land in the same table would
 * move the band by hand. The scheduled poll owns that table.
 */
app.post('/projects/:projectId/ai/stream', async (c) => {
  const projectId = c.req.param('projectId');
  const raw = await readJson(c);
  if (raw === UNPARSEABLE) return c.json({ error: 'body is not valid JSON' }, 400);
  const body = raw as { mode?: unknown; entityId?: unknown; prompt?: unknown; question?: unknown; model?: unknown };

  // The caller's model pick, checked against the registry before it can reach
  // the vendor. An unknown id is refused here rather than forwarded, because
  // the vendor's own rejection enumerates every model on the account in a
  // message a customer would see.
  if (body.model !== undefined && (typeof body.model !== 'string' || !isKnownLlmModel(body.model))) {
    return c.json({ error: 'unknown model', field: 'model' }, 400);
  }

  const connector = createStreamingLlmConnector(
    c.env as unknown as Record<string, string | undefined>,
    body.model as string | undefined,
  );
  if (!connector) {
    console.warn('No streaming LLM engine configured: set SARVAM_API_KEY');
    return c.json({ error: 'AI answers are not set up on this deployment yet.' }, 503);
  }

  const mode = body.mode === 'ask' ? 'ask' : 'prompt';
  const text = typeof (mode === 'ask' ? body.question : body.prompt) === 'string'
    ? String(mode === 'ask' ? body.question : body.prompt).trim()
    : '';
  if (!text) {
    const field = mode === 'ask' ? 'question' : 'prompt';
    return c.json({ error: `${field} is required`, field }, 400);
  }

  const db = createDb(c.env.DATABASE_URL);
  const accessError = await projectAccessError(db, projectId, c.get('user'));
  if (accessError) return c.json(accessError.body, accessError.status);

  // Everything that can fail with a status code is settled before the stream
  // opens. Once the response is a 200 event-stream the status is already sent,
  // so a failure after this point can only be an `error` event — which the
  // client has to handle anyway, but which is a worse way to learn that an
  // entity id was wrong.
  let entity: Entity | null = null;
  let project: { domain: string } | null = null;
  if (mode === 'prompt') {
    if (typeof body.entityId !== 'string') {
      return c.json({ error: 'entityId is required', field: 'entityId' }, 400);
    }
    entity = await getEntityInProject(db, projectId, body.entityId);
    if (!entity) {
      return c.json({ error: 'entity does not belong to this project', entityId: body.entityId }, 400);
    }
    project = await getProject(db, projectId);
  }

  return streamSSE(c, async (sse) => {
    /** Send one named event, JSON-encoded. */
    const send = (event: string, data: unknown) => sse.writeSSE({ event, data: JSON.stringify(data) });

    // What the model is actually asked, per mode.
    let modelPrompt = text;
    if (mode === 'ask') {
      const result = await answerQuestion(db, projectId, text);
      // The cited answer, before any model token. From here the stream is
      // optional polish.
      await send('grounded', {
        answer: result.answer.answer,
        intent: result.answer.intent,
        citations: result.answer.citations,
        drilldown: result.answer.drilldown,
        suggestedAction: result.answer.suggestedAction ?? null,
        latencyMs: result.latencyMs,
      });
      try {
        await logCopilotQuery(db, projectId, text, result.answer.intent, result.latencyMs, result.entityId);
      } catch {
        /* swallow: the log is telemetry, not the product */
      }
      // An `unknown` intent has no facts behind it, so there is nothing for a
      // model to reword — and asking it to would invite it to answer the
      // question itself, which is the one thing the phrasing layer forbids.
      if (result.answer.intent === 'unknown') {
        await send('done', { rephrased: false });
        return;
      }
      modelPrompt = `${PHRASING_SYSTEM_PROMPT}\n\n${result.answer.answer}`;
    }

    let answerText = '';
    try {
      for await (const chunk of connector.stream(modelPrompt)) {
        if (chunk.type === 'text') answerText += chunk.delta;
        await send(chunk.type, { delta: chunk.delta });
      }
    } catch (error) {
      // In 'ask' mode the grounded answer is already on the wire, so this
      // degrades tone. In 'prompt' mode it is the whole answer, so it is a
      // failure the screen has to show.
      await send('error', { message: error instanceof Error ? error.message : String(error) });
      return;
    }

    if (mode === 'prompt' && entity && project) {
      // Decided here rather than in the connector because the stream yields
      // deltas, not an answer: `buildCitationEvent` needs the whole text.
      const targets = citationTargets({
        canonical_name: entity.canonicalName,
        domain: project.domain,
        urls: entity.urls,
      });
      const citation = buildCitationEvent(answerText, [], targets);
      await send('result', {
        cited: citation.cited,
        sourcesCited: citation.sourcesCited,
        targets,
        engine: connector.engine,
      });
    }
    await send('done', { rephrased: mode === 'ask' && answerText.length > 0 });
  });
});

app.get('/projects/:projectId/entities', async (c) => {
  const projectId = c.req.param('projectId');
  const db = createDb(c.env.DATABASE_URL);
  const accessError = await projectAccessError(db, projectId, c.get('user'));
  if (accessError) return c.json(accessError.body, accessError.status);
  // `role` defaults to the customer's own brands: this route feeds every brand
  // picker in the product, and offering a rival as something to audit, track
  // or set a location on would be wrong in each of them. `?role=all` is there
  // for the Competitors screen, which has to name both sides.
  const roleParam = c.req.query('role') ?? 'self';
  if (roleParam !== 'all' && !isEntityRole(roleParam)) {
    return c.json({ error: `invalid role: expected 'self', 'competitor' or 'all', got '${roleParam}'`, field: 'role' }, 400);
  }
  const entities = await listEntitiesByProject(db, projectId, roleParam);
  return c.json({ entities });
});

app.post('/projects/:projectId/entities', async (c) => {
  const body = await c.req.json<{ canonicalName: string; schemaType?: string }>();
  const projectId = c.req.param('projectId');
  const db = createDb(c.env.DATABASE_URL);
  const accessError = await projectAccessError(db, projectId, c.get('user'));
  if (accessError) return c.json(accessError.body, accessError.status);
  // An unrecognised kind is rejected rather than coerced: the value becomes the
  // `@type` of structured data on the customer's live site.
  if (body.schemaType !== undefined && !isEntityKind(body.schemaType)) {
    return c.json({ error: 'invalid schemaType', field: 'schemaType' }, 400);
  }
  const entity = await createEntity(db, projectId, body.canonicalName, body.schemaType);
  return c.json({ entity }, 201);
});

/**
 * Change what kind of thing a brand is (`Entity.schemaType`). It decides the
 * `@type` of every JSON-LD fix Engine proposes for this brand, so it is
 * editable after setup, not only at it.
 */
app.patch('/projects/:projectId/entities/:entityId', async (c) => {
  const raw = await readJson(c);
  if (raw === UNPARSEABLE) return c.json({ error: 'body is not valid JSON' }, 400);
  const body = raw as { schemaType?: unknown };
  if (!isEntityKind(body.schemaType)) {
    return c.json({ error: 'invalid schemaType', field: 'schemaType' }, 400);
  }
  const projectId = c.req.param('projectId');
  const db = createDb(c.env.DATABASE_URL);
  const accessError = await projectAccessError(db, projectId, c.get('user'));
  if (accessError) return c.json(accessError.body, accessError.status);
  const entity = await setEntitySchemaType(db, projectId, c.req.param('entityId'), body.schemaType);
  if (!entity) return c.json({ error: 'entity not found' }, 404);
  return c.json({ entity });
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
  const projectId = c.req.param('projectId');
  const db = createDb(c.env.DATABASE_URL);
  const accessError = await projectAccessError(db, projectId, c.get('user'));
  if (accessError) return c.json(accessError.body, accessError.status);
  const actions = await listPendingCmsPluginActions(db, projectId, plugin as 'wordpress' | 'shopify', siteId);
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
  const projectId = c.req.param('projectId');
  const db = createDb(c.env.DATABASE_URL);
  const accessError = await projectAccessError(db, projectId, c.get('user'));
  if (accessError) return c.json(accessError.body, accessError.status);
  const results = (body.seeds ?? []).map((seed) => ({
    seed,
    intent: classifyIntent(seed),
    hindiTransliteration: transliterateToDevanagari(seed),
    promptSeeds: generatePromptSeeds(seed),
  }));
  return c.json({ projectId, results });
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

  const accessError = await projectAccessError(db, projectId, c.get('user'));
  if (accessError) return c.json(accessError.body, accessError.status);

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
  // G5's tracked-keyword cap, checked here because this is the only route that
  // can exceed it. `getUsageCounters` has counted `keyword_configs` since G4
  // and `PLAN_LIMITS` has held the numbers, but nothing ever compared them, so
  // a Starter account could track a thousand keywords — each one a paid Serper
  // lookup on every scheduled poll.
  const accountId = await getProjectAccountId(db, projectId);
  if (!accountId) return c.json({ error: 'project not found', projectId }, 404);
  const [subscription, usage] = await Promise.all([getSubscription(db, accountId), getUsageCounters(db, accountId)]);
  const tier = subscription?.planTier ?? 'starter';
  const limit = PLAN_LIMITS[tier].keywords;
  if (usage.keywords >= limit) {
    return c.json(
      {
        error: `This plan tracks up to ${limit} keywords, and ${usage.keywords} are already tracked. Stop tracking one, or move to a larger plan.`,
        limit,
        tracked: usage.keywords,
      },
      409,
    );
  }

  const config = await createKeywordConfig(db, entityId, body);
  return c.json({ config }, 201);
});

/**
 * Every keyword tracked for this project, with its current position and the
 * one before it. The per-entity list above answers "what is tracked for this
 * brand"; a customer looking at a site wants all of them in one table, and the
 * screen needs the positions joined on rather than fetched per row.
 */
app.get('/projects/:projectId/keywords', async (c) => {
  const projectId = c.req.param('projectId');
  const db = createDb(c.env.DATABASE_URL);
  const accessError = await projectAccessError(db, projectId, c.get('user'));
  if (accessError) return c.json(accessError.body, accessError.status);
  const keywords = await listTrackedKeywords(db, projectId);
  return c.json({ keywords });
});

/** Stop tracking a keyword. Its observed positions are kept. */
app.delete('/projects/:projectId/keywords/:keywordId', async (c) => {
  const projectId = c.req.param('projectId');
  const keywordId = c.req.param('keywordId');
  const invalid = checkUuidParam(keywordId, 'keywordId');
  if (invalid) return c.json({ error: invalid.message, field: invalid.field }, 400);
  const db = createDb(c.env.DATABASE_URL);
  const accessError = await projectAccessError(db, projectId, c.get('user'));
  if (accessError) return c.json(accessError.body, accessError.status);
  const removed = await deleteKeywordConfig(db, projectId, keywordId);
  if (!removed) return c.json({ error: 'keyword not found in this project', keywordId }, 404);
  return c.json({ ok: true });
});

app.get('/projects/:projectId/entities/:entityId/keywords', async (c) => {
  const projectId = c.req.param('projectId');
  const entityId = c.req.param('entityId');
  const db = createDb(c.env.DATABASE_URL);
  const accessError = await projectAccessError(db, projectId, c.get('user'));
  if (accessError) return c.json(accessError.body, accessError.status);
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
  const projectId = c.req.param('projectId');
  const db = createDb(c.env.DATABASE_URL);
  const accessError = await projectAccessError(db, projectId, c.get('user'));
  if (accessError) return c.json(accessError.body, accessError.status);
  const entity = await getEntityInProject(db, projectId, c.req.param('entityId'));
  if (!entity) {
    return c.json({ error: 'entity does not belong to this project', entityId: c.req.param('entityId') }, 400);
  }
  const summary = await buildEntityCopilotSummary(db, entity.id, entity.canonicalName);
  return c.json({ summary });
});

/**
 * M2.4 "Copilot GA": a natural-language question -> a cited, drill-downable
 * answer. The whole answer is computed deterministically from the same
 * entity-first A1/A2/B1 join the summary route serves — the intent parse,
 * cited-answer assembly, and phrasing contract all live in `@engine/copilot`
 * and run without any model call, which is how the <3s budget is met and how
 * the path stays exercisable even with the OpenAI key present but out of
 * credits. When credits exist, `OPENAI_API_KEY` upgrades only the prose
 * fluency (behind a hard timeout), never the numbers or citations.
 *
 * Every answer carries `citations` naming the exact table each figure came
 * from, `drilldown` ids the UI links to, and — via the Finding -> Action
 * bridge — an optional `suggestedAction` pointing at the M2.3 propose route,
 * so the Copilot is a launch point for a fix, not just a read surface.
 */
app.post('/projects/:projectId/copilot/ask', async (c) => {
  const projectId = c.req.param('projectId');
  const db = createDb(c.env.DATABASE_URL);
  const accessError = await projectAccessError(db, projectId, c.get('user'));
  if (accessError) return c.json(accessError.body, accessError.status);

  const body = (await c.req.json<{ question?: unknown }>().catch(() => ({}))) as { question?: unknown };
  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if (!question) {
    return c.json({ error: 'question is required', field: 'question' }, 400);
  }

  const result = await answerQuestion(db, projectId, question, {
    openAiApiKey: c.env.OPENAI_API_KEY,
    openAiModel: c.env.OPENAI_MODEL,
  });

  // Best-effort analytics: never let a logging failure sink an answer.
  try {
    await logCopilotQuery(db, projectId, question, result.answer.intent, result.latencyMs, result.entityId);
  } catch {
    /* swallow: the log is telemetry, not the product */
  }

  return c.json({ answer: result.answer, latencyMs: result.latencyMs });
});

/**
 * B3 Entity & Knowledge Graph Audit — run the entity-graph checks over the
 * project's entities (Wikidata mapping, on-site entity schema, sameAs
 * consistency, cross-web corroboration) and persist both the `source:'entity'`
 * findings (into the same inventory B1/B2 write, so they propose through the
 * existing fix flow) and each entity's strength breakdown (migration 0010).
 * Deterministic: reads the graph facts already on each entity row, no live
 * external call, so re-running is idempotent and testable.
 */
app.post('/projects/:projectId/entity-audit', async (c) => {
  const projectId = c.req.param('projectId');
  const db = createDb(c.env.DATABASE_URL);
  const accessError = await projectAccessError(db, projectId, c.get('user'));
  if (accessError) return c.json(accessError.body, accessError.status);

  const result = await runProjectEntityAudit(db, projectId);
  if (result.findings.length > 0) await markFirstInsight(db, projectId);
  await recordDeterministicAuditRun(db, {
    projectId,
    entityId: null,
    kind: 'entity',
    trigger: 'manual',
    findingsCount: result.findings.length,
  });
  return c.json({
    entitiesAudited: result.entitiesAudited,
    findingsCount: result.findings.length,
    findings: result.findings,
    strengths: result.strengths,
  });
});

/**
 * The project's persisted entity strengths (B3 lead metric), weakest first —
 * the "do search + AI understand who I am?" view. Empty until an entity audit
 * has run; an empty array is a real answer, not sample data.
 */
app.get('/projects/:projectId/entity-audit', async (c) => {
  const projectId = c.req.param('projectId');
  const db = createDb(c.env.DATABASE_URL);
  const accessError = await projectAccessError(db, projectId, c.get('user'));
  if (accessError) return c.json(accessError.body, accessError.status);

  const strengths = await listEntityStrengths(db, projectId);
  return c.json({ strengths, lastRun: await latestDeterministicAuditRun(db, projectId, 'entity') });
});

/**
 * A5 Competitor Intelligence — manage the competitor set and run the gap
 * analysis of a self-entity against it. Both sides are entities in the
 * entity-first model, so the analysis is a deterministic set-difference over
 * the columns each entity already carries (keywords/prompts/citations/mentions)
 * plus B3 strength; every gap emits a Finding into the same inventory B1/B2/B3
 * write, so it proposes through the existing Fix Queue flow.
 */

/** List the competitor set for a self-entity. */
app.get('/projects/:projectId/entities/:selfEntityId/competitors', async (c) => {
  const projectId = c.req.param('projectId');
  const selfEntityId = c.req.param('selfEntityId');
  const db = createDb(c.env.DATABASE_URL);
  const accessError = await projectAccessError(db, projectId, c.get('user'));
  if (accessError) return c.json(accessError.body, accessError.status);
  const competitors = await listCompetitors(db, projectId, selfEntityId);
  return c.json({ competitors });
});

/** Add a competitor entity to a self-entity's set. */
app.post('/projects/:projectId/entities/:selfEntityId/competitors', async (c) => {
  const projectId = c.req.param('projectId');
  const selfEntityId = c.req.param('selfEntityId');
  const db = createDb(c.env.DATABASE_URL);
  const accessError = await projectAccessError(db, projectId, c.get('user'));
  if (accessError) return c.json(accessError.body, accessError.status);

  const body = await c.req
    .json<{ competitorEntityId?: string; domain?: string }>()
    .catch(() => ({}) as { competitorEntityId?: string; domain?: string });

  // A domain is the way a customer adds a competitor; `competitorEntityId` is
  // kept for a rival that is already an entity in the project.
  if (typeof body.domain === 'string' && body.domain.trim() !== '') {
    const res = await addCompetitorByDomain(db, projectId, selfEntityId, body.domain);
    if (!res.ok) {
      if (res.reason === 'self-not-found') return c.json({ error: 'self entity not found in project' }, 404);
      if (res.reason === 'own-domain') {
        return c.json({ error: 'That is this site’s own address, not a competitor’s.', field: 'domain' }, 400);
      }
      return c.json({ error: 'That does not look like a website address. Try “competitor.com”.', field: 'domain' }, 400);
    }
    return c.json({ id: res.id, entityId: res.entityId, canonicalName: res.canonicalName, domain: res.domain }, 201);
  }

  if (!body.competitorEntityId || typeof body.competitorEntityId !== 'string') {
    return c.json({ error: 'domain is required' }, 400);
  }
  const res = await addCompetitor(db, projectId, selfEntityId, body.competitorEntityId);
  if (!res.ok) {
    const status = res.reason === 'same-entity' ? 400 : 404;
    return c.json({ error: res.reason }, status);
  }
  return c.json({ id: res.id }, 201);
});

/** Remove a competitor link from a self-entity's set. */
app.delete('/projects/:projectId/entities/:selfEntityId/competitors/:competitorSetId', async (c) => {
  const projectId = c.req.param('projectId');
  const competitorSetId = c.req.param('competitorSetId');
  const db = createDb(c.env.DATABASE_URL);
  const accessError = await projectAccessError(db, projectId, c.get('user'));
  if (accessError) return c.json(accessError.body, accessError.status);
  const removed = await removeCompetitor(db, projectId, competitorSetId);
  if (!removed) return c.json({ error: 'competitor not found' }, 404);
  return c.json({ ok: true });
});

/**
 * Run + persist the competitor gap analysis for a self-entity. Emits findings
 * for the Fix Queue and persists the ranked gap list (migration 0011).
 */
app.post('/projects/:projectId/entities/:selfEntityId/competitor-audit', async (c) => {
  const projectId = c.req.param('projectId');
  const selfEntityId = c.req.param('selfEntityId');
  const db = createDb(c.env.DATABASE_URL);
  const accessError = await projectAccessError(db, projectId, c.get('user'));
  if (accessError) return c.json(accessError.body, accessError.status);

  const result = await runProjectCompetitorAudit(db, projectId, selfEntityId);
  if (!result) return c.json({ error: 'self entity not found in project' }, 404);
  if (result.findings.length > 0) await markFirstInsight(db, projectId);
  await recordDeterministicAuditRun(db, {
    projectId,
    entityId: selfEntityId,
    kind: 'competitor',
    trigger: 'manual',
    findingsCount: result.findings.length,
  });
  return c.json({
    selfEntityId: result.selfEntityId,
    competitorsAudited: result.competitorsAudited,
    findingsCount: result.findings.length,
    gaps: result.gaps,
    byType: result.byType,
    findings: result.findings,
  });
});

/**
 * The project's persisted competitor gaps for a self-entity, biggest first —
 * the "biggest gaps to close" view. Empty until an analysis has run.
 */
app.get('/projects/:projectId/entities/:selfEntityId/competitor-audit', async (c) => {
  const projectId = c.req.param('projectId');
  const selfEntityId = c.req.param('selfEntityId');
  const db = createDb(c.env.DATABASE_URL);
  const accessError = await projectAccessError(db, projectId, c.get('user'));
  if (accessError) return c.json(accessError.body, accessError.status);
  const gaps = await listCompetitorGaps(db, projectId, selfEntityId);
  return c.json({ gaps, lastRun: await latestDeterministicAuditRun(db, projectId, 'competitor') });
});

/**
 * A6 Backlink & Mention Index (v1.5) — mine the project's A2 citation archive
 * (citation_events.sources_cited) into citation-domain intelligence and the
 * "citation opportunities" for a self-entity (high-authority domains AI cites
 * in the category where the entity is absent), persist the off-site findings
 * (into the shared inventory) and the ranked opportunities (migration 0012).
 * Deterministic: reads data the system already holds, so re-running is
 * idempotent and testable.
 */
app.post('/projects/:projectId/entities/:selfEntityId/offsite-audit', async (c) => {
  const projectId = c.req.param('projectId');
  const selfEntityId = c.req.param('selfEntityId');
  const db = createDb(c.env.DATABASE_URL);
  const accessError = await projectAccessError(db, projectId, c.get('user'));
  if (accessError) return c.json(accessError.body, accessError.status);

  const result = await runProjectOffsiteAudit(db, projectId, selfEntityId);
  if (!result) return c.json({ error: 'self entity not found in project' }, 404);
  if (result.findings.length > 0) await markFirstInsight(db, projectId);
  await recordDeterministicAuditRun(db, {
    projectId,
    entityId: selfEntityId,
    kind: 'offsite',
    trigger: 'manual',
    findingsCount: result.findings.length,
  });
  return c.json({
    selfEntityId: result.selfEntityId,
    observationsAnalyzed: result.observationsAnalyzed,
    categorySize: result.categorySize,
    findingsCount: result.findings.length,
    opportunities: result.opportunities,
    domainIntel: result.domainIntel,
    findings: result.findings,
  });
});

/**
 * The project's persisted citation opportunities for a self-entity, biggest
 * first — the "citation opportunities" view. Empty until an off-site audit ran.
 */
app.get('/projects/:projectId/entities/:selfEntityId/offsite-audit', async (c) => {
  const projectId = c.req.param('projectId');
  const selfEntityId = c.req.param('selfEntityId');
  const db = createDb(c.env.DATABASE_URL);
  const accessError = await projectAccessError(db, projectId, c.get('user'));
  if (accessError) return c.json(accessError.body, accessError.status);
  const opportunities = await listCitationOpportunities(db, projectId, selfEntityId);
  return c.json({ opportunities, lastRun: await latestDeterministicAuditRun(db, projectId, 'offsite') });
});

/**
 * The prompt bank an entity's AI visibility is sampled against.
 *
 * `entities.prompts` has been a column since migration 0001 and no route ever
 * wrote to it, which is the direct reason `citation_events` was empty: the
 * scheduled poll drains this list, and on every row it was `{}`.
 */
app.get('/projects/:projectId/entities/:entityId/prompts', async (c) => {
  const projectId = c.req.param('projectId');
  const db = createDb(c.env.DATABASE_URL);
  const accessError = await projectAccessError(db, projectId, c.get('user'));
  if (accessError) return c.json(accessError.body, accessError.status);

  const entity = await getEntityInProject(db, projectId, c.req.param('entityId'));
  if (!entity) return c.json({ error: 'entity not found' }, 404);

  // Suggestions come from the keywords this brand already tracks, expanded by
  // A4.8's templates. That is the point of seeding from Rankings rather than
  // from a blank box: the prompts a brand should be measured on are the ones
  // its customers search for, and after step 2 the product already knows them.
  const tracked = await listKeywordConfigsByEntity(db, entity.id);
  const already = new Set(entity.prompts.map((p) => p.toLowerCase()));
  const suggestions: string[] = [];
  const seen = new Set<string>();
  for (const kc of tracked) {
    for (const seed of generatePromptSeeds(kc.keyword)) {
      const key = seed.toLowerCase();
      if (already.has(key) || seen.has(key)) continue;
      seen.add(key);
      suggestions.push(seed);
    }
  }

  return c.json({
    entityId: entity.id,
    prompts: entity.prompts,
    suggestions,
    keywordsTracked: tracked.length,
  });
});

/**
 * Replace the prompt bank.
 *
 * A whole-list PUT rather than add/remove routes: the editor sends the list it
 * is showing, so two open tabs cannot merge into a bank neither of them
 * displayed. The caps are here because every prompt costs three model calls
 * per engine on every scheduled pass — an unbounded list is a bill, not a
 * feature.
 */
app.put('/projects/:projectId/entities/:entityId/prompts', async (c) => {
  const raw = await readJson(c);
  if (raw === UNPARSEABLE) return c.json({ error: 'body is not valid JSON' }, 400);
  const body = raw as { prompts?: unknown };
  if (!Array.isArray(body.prompts) || body.prompts.some((p) => typeof p !== 'string')) {
    return c.json({ error: 'prompts must be an array of strings', field: 'prompts' }, 400);
  }

  // Trimmed, de-duplicated case-insensitively, blanks dropped. Two prompts
  // differing only in case would be two rows in `citation_events` and two
  // separate bands for one question.
  const seen = new Set<string>();
  const prompts: string[] = [];
  for (const p of body.prompts as string[]) {
    const clean = p.trim();
    if (!clean) continue;
    if (clean.length > MAX_PROMPT_LENGTH) {
      return c.json({ error: `a prompt cannot be longer than ${MAX_PROMPT_LENGTH} characters`, field: 'prompts' }, 400);
    }
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    prompts.push(clean);
  }
  if (prompts.length > MAX_PROMPTS_PER_ENTITY) {
    return c.json({ error: `up to ${MAX_PROMPTS_PER_ENTITY} prompts can be tracked per brand`, field: 'prompts' }, 400);
  }

  const projectId = c.req.param('projectId');
  const db = createDb(c.env.DATABASE_URL);
  const accessError = await projectAccessError(db, projectId, c.get('user'));
  if (accessError) return c.json(accessError.body, accessError.status);

  const entity = await setEntityPrompts(db, projectId, c.req.param('entityId'), prompts);
  if (!entity) return c.json({ error: 'entity not found' }, 404);
  return c.json({ entityId: entity.id, prompts: entity.prompts });
});

/**
 * Cited share by engine — the top half of the AI answers screen.
 *
 * `sourceCoverage` is reported alongside it because it is the honest limit of
 * this deployment: Sarvam does not browse, so almost no answer names a source,
 * and the citation-opportunity panel below is mined from exactly those
 * sources. Without this number an empty opportunity list reads as "your site
 * has no gaps to close", which is the opposite of what it means.
 */
app.get('/projects/:projectId/entities/:entityId/ai-visibility', async (c) => {
  const projectId = c.req.param('projectId');
  const db = createDb(c.env.DATABASE_URL);
  const accessError = await projectAccessError(db, projectId, c.get('user'));
  if (accessError) return c.json(accessError.body, accessError.status);

  const entity = await getEntityInProject(db, projectId, c.req.param('entityId'));
  if (!entity) return c.json({ error: 'entity not found' }, 404);

  const engines = await citedShareByEngine(db, entity.id, AI_VISIBILITY_LOOKBACK_DAYS);
  const samples = engines.reduce((n, e) => n + e.samples, 0);
  const withSources = engines.reduce((n, e) => n + e.samplesWithSources, 0);

  return c.json({
    entityId: entity.id,
    promptsTracked: entity.prompts.length,
    lookbackDays: AI_VISIBILITY_LOOKBACK_DAYS,
    engines,
    sourceCoverage: { samples, withSources },
  });
});

/**
 * B5 Local SEO Audit (v1.5) — a location is an entity. Until the GBP API
 * connector lands, its profile facts (NAP, GBP fields, directory listings,
 * reviews) are settable via PUT so the deterministic audit + the whole Fix
 * Queue loop can run against real data now (the same pattern deploy-target
 * used). The audit emits source:'local' findings into the shared inventory and
 * persists the local visibility breakdown (migration 0013).
 */

/** Read a location's stored profile facts. */
app.get('/projects/:projectId/entities/:entityId/local-profile', async (c) => {
  const projectId = c.req.param('projectId');
  const entityId = c.req.param('entityId');
  const db = createDb(c.env.DATABASE_URL);
  const accessError = await projectAccessError(db, projectId, c.get('user'));
  if (accessError) return c.json(accessError.body, accessError.status);
  const profile = await getLocalProfile(db, projectId, entityId);
  return c.json({ profile });
});

/** Set/replace a location's profile facts. */
app.put('/projects/:projectId/entities/:entityId/local-profile', async (c) => {
  const projectId = c.req.param('projectId');
  const entityId = c.req.param('entityId');
  const db = createDb(c.env.DATABASE_URL);
  const accessError = await projectAccessError(db, projectId, c.get('user'));
  if (accessError) return c.json(accessError.body, accessError.status);

  const body = await c.req.json<{ profile?: ProfileInput }>().catch(() => ({}) as { profile?: ProfileInput });
  if (!body.profile || typeof body.profile !== 'object') return c.json({ error: 'profile is required' }, 400);
  const ok = await setLocalProfile(db, projectId, entityId, body.profile);
  if (!ok) return c.json({ error: 'entity not found in project' }, 404);
  return c.json({ ok: true });
});

/** Run + persist a location's local audit. */
app.post('/projects/:projectId/entities/:entityId/local-audit', async (c) => {
  const projectId = c.req.param('projectId');
  const entityId = c.req.param('entityId');
  const db = createDb(c.env.DATABASE_URL);
  const accessError = await projectAccessError(db, projectId, c.get('user'));
  if (accessError) return c.json(accessError.body, accessError.status);

  const result = await runProjectLocalAudit(db, projectId, entityId);
  if (result === null) return c.json({ error: 'entity not found in project' }, 404);
  if (result === 'no-profile') return c.json({ error: 'no local profile set for this entity' }, 409);
  if (result.findings.length > 0) await markFirstInsight(db, projectId);
  await recordDeterministicAuditRun(db, {
    projectId,
    entityId,
    kind: 'local',
    trigger: 'manual',
    findingsCount: result.findings.length,
  });
  return c.json({
    entityId: result.entityId,
    findingsCount: result.findings.length,
    visibility: result.visibility,
    findings: result.findings,
  });
});

/** The project's persisted local visibility scores, weakest first. */
app.get('/projects/:projectId/local-audit', async (c) => {
  const projectId = c.req.param('projectId');
  const db = createDb(c.env.DATABASE_URL);
  const accessError = await projectAccessError(db, projectId, c.get('user'));
  if (accessError) return c.json(accessError.body, accessError.status);
  const visibility = await listLocalVisibility(db, projectId);
  return c.json({ visibility, lastRun: await latestDeterministicAuditRun(db, projectId, 'local') });
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
  const projectId = c.req.param('projectId');
  const db = createDb(c.env.DATABASE_URL);
  const accessError = await projectAccessError(db, projectId, c.get('user'));
  if (accessError) return c.json(accessError.body, accessError.status);
  const score = unifiedVisibilityScore(body.surfaces, body.mix ?? DEFAULT_CHANNEL_MIX);
  return c.json({ projectId, score });
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
  const accessError = await projectAccessError(db, projectId, c.get('user'));
  if (accessError) return c.json(accessError.body, accessError.status);
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
 * What the synced Google tables say about this site: Search Console clicks,
 * impressions, queries and pages; Analytics sessions, key events, channels and
 * visits from AI assistants. Each half is null until its provider has synced,
 * and `connections` says why — not connected, connected but no property
 * chosen, or chosen and waiting for the first sync — so Pulse can offer the
 * one next step instead of an empty panel.
 */
app.get('/projects/:projectId/search-traffic', async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  const projectId = c.req.param('projectId');
  const invalidId = checkUuidParam(projectId, 'projectId');
  if (invalidId) return c.json({ error: invalidId.message, field: invalidId.field }, 400);
  const accessError = await projectAccessError(db, projectId, c.get('user'));
  if (accessError) return c.json(accessError.body, accessError.status);

  const project = await getProject(db, projectId);
  if (!project) return c.json({ error: 'project not found', projectId }, 404);
  const [assignments, connections, entities] = await Promise.all([
    listAssignments(db, projectId),
    listConnections(db, project.accountId),
    listEntitiesByProject(db, projectId),
  ]);

  const stateFor = (provider: 'gsc' | 'ga4') => {
    const connection = connections.find((x) => x.provider === provider);
    const assignment = assignments.find((a) => a.provider === provider);
    const sync: SyncState = {
      resourceId: assignment?.resourceId ?? null,
      syncedAt: assignment?.lastSyncedAt ?? null,
      syncError: assignment?.lastSyncError ?? null,
    };
    return {
      sync,
      status: {
        connected: connection?.status === 'connected',
        needsReauth: connection?.status === 'needs_reauth',
        assigned: Boolean(assignment),
        resourceLabel: assignment?.resourceLabel ?? assignment?.resourceId ?? null,
        ...sync,
      },
    };
  };
  const gsc = stateFor('gsc');
  const ga4 = stateFor('ga4');
  const terms = brandTerms(
    project.domain,
    entities.map((e) => e.canonicalName),
  );
  const [search, traffic] = await Promise.all([
    searchSummary(db, projectId, terms, gsc.sync),
    trafficSummary(db, projectId, ga4.sync),
  ]);
  return c.json({ projectId, search, traffic, connections: { gsc: gsc.status, ga4: ga4.status } });
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
  const body = raw as { pages?: CrawledPage[]; target?: DeployTarget; coverage?: AuditRunCoverage };
  const pages = body.pages ?? [];
  const projectId = c.req.param('projectId');
  const db = createDb(c.env.DATABASE_URL);

  const accessError = await projectAccessError(db, projectId, c.get('user'));
  if (accessError) return c.json(accessError.body, accessError.status);

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
  // Persist the fix-relevant slice of each page (M2.3 #3): /audit used to
  // discard the pages after scoring, leaving a later "generate a fix" call
  // with no title/body to build a diff from. Storing them here is what lets
  // the dashboard propose a fix for any finding without re-crawling.
  await upsertCrawledPages(db, projectId, pages);
  // Record the run itself. The health score is normalized by pages audited, so
  // it belongs to this run and cannot be recomputed from the findings later —
  // without this row, GET /audit would have to invent one.
  const run = await recordAuditRun(db, {
    projectId,
    pagesAudited: result.pagesAudited,
    findingsCount: findings.length,
    healthScore: result.healthScore,
    // What the crawl could reach, from the crawler that just ran. Absent from
    // a caller that posts pages directly, and a null run says so rather than
    // claiming a site has no sitemap.
    coverage: body.coverage ?? null,
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
      // Without these the title generator has only the brand name to work
      // with, and proposes it as the title of every page on the site.
      headings: page?.headings,
      currentBodyText: page?.bodyText,
    };
    for (const action of generateActions(finding, ctx).actions) {
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
  const accessError = await projectAccessError(db, projectId, c.get('user'));
  if (accessError) return c.json(accessError.body, accessError.status);
  const [findings, run] = await Promise.all([
    listFindingsByProject(db, projectId),
    latestAuditRun(db, projectId),
  ]);
  return c.json({
    findings,
    healthScore: run?.healthScore ?? null,
    lastRunAt: run?.createdAt ?? null,
    pagesAudited: run?.pagesAudited ?? null,
    coverage: run?.coverage ?? null,
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

  const accessError = await projectAccessError(db, projectId, c.get('user'));
  if (accessError) return c.json(accessError.body, accessError.status);

  // `finding.id` becomes actions.finding_id, a uuid FK, and is caller-supplied —
  // exactly the situation the /audit entity check above exists for. Unchecked, a
  // finding that isn't this project's either trips the FK as a 500 (or, if it is
  // not a uuid at all, a `invalid input syntax` 500), or — worse — lets one
  // project hang an Action off another project's finding.
  if (!(await findingBelongsToProject(db, body.finding.id, projectId))) {
    return c.json({ error: 'finding does not belong to this project', findingId: body.finding.id }, 400);
  }

  const generated = generateActions(body.finding, body.context);
  const actions = await Promise.all(generated.actions.map((action) => createAction(db, action)));
  if (actions.length > 0) await markFirstFixProposed(db, projectId);
  return c.json({ projectId, actions, skipped: generated.skipped });
});

/**
 * C3.1 "AI-drafted extractability rewrites" — the executor for B2's content
 * findings. Deliberately a separate route from `/actions/generate`, not a
 * case inside its dispatch: every other template type there is a free,
 * instant, deterministic transform; this one is a real, costed LLM call, and
 * that difference belongs in the caller's explicit choice to spend it, not
 * folded into the same request that produces free fixes.
 */
app.post('/projects/:projectId/actions/generate-content', async (c) => {
  if (!c.env.OPENAI_API_KEY) {
    console.warn('Content rewrites are not configured: set OPENAI_API_KEY');
    return c.json({ error: 'Content rewrites are not configured on this deployment.' }, 503);
  }
  const raw = await readJson(c);
  if (raw === UNPARSEABLE) return c.json({ error: 'body is not valid JSON' }, 400);
  const invalid = checkGenerateBody(raw);
  if (invalid) {
    return c.json({ error: `invalid ${invalid.field}: ${invalid.message}`, field: invalid.field }, 400);
  }
  const body = raw as { finding: Finding; context: ActionContext };
  const projectId = c.req.param('projectId');
  const db = createDb(c.env.DATABASE_URL);

  const accessError = await projectAccessError(db, projectId, c.get('user'));
  if (accessError) return c.json(accessError.body, accessError.status);

  if (!(await findingBelongsToProject(db, body.finding.id, projectId))) {
    return c.json({ error: 'finding does not belong to this project', findingId: body.finding.id }, 400);
  }

  let action;
  try {
    action = await generateContentAction(
      body.finding,
      body.context,
      { apiKey: c.env.OPENAI_API_KEY, model: c.env.OPENAI_MODEL },
      defaultEnv(),
    );
  } catch (err) {
    return c.json({ error: `content rewrite failed: ${(err as Error).message}` }, 502);
  }
  if (!action) {
    return c.json({ error: 'nothing to rewrite: context.currentBodyText is missing or empty', field: 'context.currentBodyText' }, 400);
  }

  const saved = await createAction(db, action);
  await markFirstFixProposed(db, projectId);
  return c.json({ projectId, action: saved });
});

/**
 * The project's configured deploy target (M2.3 #3) — where every generated
 * Action lands. The dashboard reads this to know whether a project can propose
 * fixes yet, and writes it from Settings. `null` until configured.
 */
app.get('/projects/:projectId/deploy-target', async (c) => {
  const projectId = c.req.param('projectId');
  const db = createDb(c.env.DATABASE_URL);
  const accessError = await projectAccessError(db, projectId, c.get('user'));
  if (accessError) return c.json(accessError.body, accessError.status);
  const target = await getProjectDeployTarget(db, projectId);
  return c.json({ target });
});

app.put('/projects/:projectId/deploy-target', async (c) => {
  const raw = await readJson(c);
  if (raw === UNPARSEABLE) return c.json({ error: 'body is not valid JSON' }, 400);
  const invalid = checkDeployTargetBody(raw);
  if (invalid) return c.json({ error: `invalid ${invalid.field}: ${invalid.message}`, field: invalid.field }, 400);
  const { target } = raw as { target: DeployTarget };
  const projectId = c.req.param('projectId');
  const db = createDb(c.env.DATABASE_URL);
  const accessError = await projectAccessError(db, projectId, c.get('user'));
  if (accessError) return c.json(accessError.body, accessError.status);
  await setProjectDeployTarget(db, projectId, target);
  return c.json({ target });
});

/**
 * Propose the fix(es) for a stored Finding (M2.3 #3) — the server-side
 * generate the dashboard drives, so a user can turn any finding into a queued
 * Action (content rewrite, GitHub PR, internal links, …) without re-crawling
 * or hand-assembling context. Unlike `/actions/generate`, the caller sends no
 * finding or context: both are rebuilt here from what `/audit` persisted (the
 * finding, its page's stored title/body, its entity's facts, the project's
 * deploy target), which is the whole reason those are now stored.
 *
 * A `content`-template finding is a costed LLM rewrite, so it is only run when
 * OPENAI is configured; the free deterministic fixes (schema/meta/robots/
 * redirect/internal-link) always run. Internal-link suggestions default to the
 * project's other pages (entity-graph-derived), overridable in the body.
 */
app.post('/projects/:projectId/findings/:findingId/propose', async (c) => {
  const projectId = c.req.param('projectId');
  const findingId = c.req.param('findingId');
  const db = createDb(c.env.DATABASE_URL);
  const accessError = await projectAccessError(db, projectId, c.get('user'));
  if (accessError) return c.json(accessError.body, accessError.status);

  const body = (await c.req.json<{ target?: DeployTarget; internalLinkSuggestions?: { anchor: string; href: string }[] }>().catch(() => ({}))) as {
    target?: DeployTarget;
    internalLinkSuggestions?: { anchor: string; href: string }[];
  };

  const finding = await getFindingInProject(db, findingId, projectId);
  if (!finding) return c.json({ error: 'finding not found', findingId }, 404);

  const target = body.target ?? (await getProjectDeployTarget(db, projectId));
  if (!target) {
    return c.json({ error: 'no deploy target: configure one for the project or pass `target`', field: 'target' }, 400);
  }

  let result;
  try {
    result = await proposeForFinding(db, c.env, projectId, finding, {
      target,
      internalLinkSuggestions: body.internalLinkSuggestions,
      // One finding, one page, one explicit click: a paid rewrite is what the
      // customer asked for here. The batch route below says no for the same
      // reason — there, one click would mean forty of them.
      allowContent: true,
    });
  } catch (err) {
    return c.json({ error: `content rewrite failed: ${(err as Error).message}` }, 502);
  }
  if (result.actions.length > 0) await markFirstFixProposed(db, projectId);

  // Producing nothing is a real answer, not an error — a thin page, a brand
  // with no kind set, a rewrite that is switched off. `skipped` says which,
  // in words the customer can act on, instead of the one sentence this used to
  // return for every cause.
  return c.json({ projectId, findingId, actions: result.actions, skipped: result.skipped });
});

/**
 * Propose the fix for every page in one issue group.
 *
 * A crawl reports one finding per page per issue, so a 7-page site with 6
 * issues is 42 findings that differ only in URL — and the Audit screen offered
 * a button per row. The way to fix a missing <title> across a site was 42
 * clicks and 42 toasts, which is not a way anyone would use.
 *
 * Runs the same `proposeForFinding` as the single route, so the batch cannot
 * drift from it. Costed content rewrites are refused here and reported as
 * skipped: one click must not become one paid call per page without the
 * customer choosing that page by page.
 */
app.post('/projects/:projectId/findings/propose-batch', async (c) => {
  const projectId = c.req.param('projectId');

  // Body first, then access — the order `/audit` already uses. It saves a
  // database round trip on a malformed request, and the check that matters is
  // that a blank `issueType` never reaches the query: an empty string matching
  // every finding would queue a fix for every page on the site from one click.
  const raw = await readJson(c);
  if (raw === UNPARSEABLE) return c.json({ error: 'body is not valid JSON' }, 400);
  const body = raw as { issueType?: unknown; target?: DeployTarget };
  if (typeof body.issueType !== 'string' || body.issueType.trim() === '') {
    return c.json({ error: 'issueType is required', field: 'issueType' }, 400);
  }
  const issueType = body.issueType.trim();

  const db = createDb(c.env.DATABASE_URL);
  const accessError = await projectAccessError(db, projectId, c.get('user'));
  if (accessError) return c.json(accessError.body, accessError.status);

  const target = body.target ?? (await getProjectDeployTarget(db, projectId));
  if (!target) {
    return c.json({ error: 'no deploy target: configure one for the project or pass `target`', field: 'target' }, 400);
  }

  const all = await listFindingsByProject(db, projectId);
  const group = all.filter((f) => f.issueType === issueType);
  if (group.length === 0) {
    return c.json({ error: 'no findings of that type in this project', field: 'issueType', issueType }, 404);
  }

  const attempted = group.slice(0, PROPOSE_BATCH_CAP);
  const actions: Action[] = [];
  const skipped: ProposeSkip[] = [];
  for (const finding of attempted) {
    try {
      const result = await proposeForFinding(db, c.env, projectId, finding, { target, allowContent: false });
      actions.push(...result.actions);
      skipped.push(...result.skipped);
    } catch (err) {
      // One page's failure must not lose the fixes already queued for the
      // others, which is what letting this throw would do.
      skipped.push({
        type: issueType,
        findingId: finding.id,
        url: (finding.evidence as { url?: string }).url,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (actions.length > 0) await markFirstFixProposed(db, projectId);

  return c.json({
    projectId,
    issueType,
    /** How many findings of this type exist, so "50 of 214" is sayable. */
    findingsInGroup: group.length,
    findingsAttempted: attempted.length,
    actions,
    skipped,
  });
});

/**
 * The project's Fix Queue (C1 kanban). Reads the persisted queue rather than the
 * generate call's return value, so a reload shows real lifecycle state — this is
 * the read side the dashboard's board renders.
 */
app.get('/projects/:projectId/actions', async (c) => {
  const projectId = c.req.param('projectId');
  const db = createDb(c.env.DATABASE_URL);
  const accessError = await projectAccessError(db, projectId, c.get('user'));
  if (accessError) return c.json(accessError.body, accessError.status);
  const actions = await listActionsByProject(db, projectId);
  return c.json({ actions });
});

app.get('/projects/:projectId/actions/:actionId', async (c) => {
  const projectId = c.req.param('projectId');
  const db = createDb(c.env.DATABASE_URL);
  const accessError = await projectAccessError(db, projectId, c.get('user'));
  if (accessError) return c.json(accessError.body, accessError.status);
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
    const projectId = c.req.param('projectId') as string;
    const db = createDb(c.env.DATABASE_URL);
    const accessError = await projectAccessError(db, projectId, c.get('user'));
    if (accessError) return c.json(accessError.body, accessError.status);
    const action = await getAction(db, c.req.param('actionId') as string);
    if (!action) return c.json({ error: 'action not found' }, 404);

    // C4.5: a 'github-pr' target has no live-request path to apply a diff
    // through (unlike edge-worker/cms-plugin) — 'deployed' here means
    // "opened the PR", so the export happens synchronously as part of this
    // transition rather than a separate push step.
    let detail = body.detail;
    if (to === 'deployed' && action.target.kind === 'github-pr') {
      // The token comes from this account's own GitHub App installation.
      //
      // It used to be one platform-wide `GITHUB_TOKEN`: a single credential,
      // held by us, that cannot reach two customers' repositories and that no
      // customer would hand over in a form. An installation token is minted
      // per call from Engine's App key plus the installation the customer
      // created, and reaches only the repositories they ticked.
      //
      // `GITHUB_TOKEN` stays as a fallback so a deployment that has not
      // registered the App keeps working, and warns when it is used, because
      // relying on it is a state to leave rather than to settle in. Same
      // shape as the GBP path's legacy single-tenant secret below.
      let token: string;
      try {
        const accountId = await getProjectAccountId(db, projectId);
        if (!accountId) return c.json({ error: 'project not found', projectId }, 404);
        token = await getAccessToken(db, accountId, 'github', await keyringFrom(c.env), c.env);
      } catch (err) {
        if (!(err instanceof ConnectionUnavailableError)) {
          return c.json({ error: `GitHub deploy failed: ${(err as Error).message}` }, 502);
        }
        if (!c.env.GITHUB_TOKEN) {
          return c.json(
            {
              error:
                'GitHub is not connected for this client. Connect it on the Integrations screen and choose which repositories Engine may open pull requests in.',
              reason: err.reason,
            },
            503,
          );
        }
        console.warn(
          `github-pr deploy fell back to the deployment-wide GITHUB_TOKEN for project ${projectId}: ${err.message}`,
        );
        token = c.env.GITHUB_TOKEN;
      }
      try {
        const pr = await exportActionAsPr(token, action);
        detail = { ...detail, prUrl: pr.url, prNumber: pr.number };
      } catch (err) {
        return c.json({ error: `GitHub PR export failed: ${(err as Error).message}` }, 502);
      }
    }

    // C5: a 'gbp-api' target applies the fix by calling the Business Profile
    // API synchronously as part of the deploy transition (like github-pr), not
    // a separate push step.
    //
    // The token comes from the project's own account connection now, not the
    // deployment-wide `GBP_REFRESH_TOKEN` this route used to read. That secret
    // held one owner's consent for every customer, which was fine while nothing
    // was multi-tenant and is wrong the moment two customers have Business
    // Profiles: the second one's fix would be written to the first one's
    // listing. It stays as a fallback so an existing single-tenant deployment
    // keeps working until its secret is removed.
    if (to === 'deployed' && action.target.kind === 'gbp-api') {
      const { GBP_REFRESH_TOKEN, GBP_CLIENT_ID, GBP_CLIENT_SECRET } = c.env;
      let token: string;
      try {
        const accountId = await getProjectAccountId(db, projectId);
        if (!accountId) return c.json({ error: 'project not found', projectId }, 404);
        token = await getAccessToken(db, accountId, 'gbp', await keyringFrom(c.env), c.env);
      } catch (err) {
        if (!(err instanceof ConnectionUnavailableError)) {
          return c.json({ error: `GBP deploy failed: ${(err as Error).message}` }, 502);
        }
        // No per-account connection. Fall back to the legacy single-tenant
        // secret if one is set, otherwise say which of the two paths to wire.
        if (!GBP_REFRESH_TOKEN || !GBP_CLIENT_ID || !GBP_CLIENT_SECRET) {
          return c.json(
            {
              error:
                'GBP automation is not connected for this account. Connect Google Business Profile in Settings, or set GBP_REFRESH_TOKEN/GBP_CLIENT_ID/GBP_CLIENT_SECRET for a single-tenant deployment.',
              reason: err.reason,
            },
            503,
          );
        }
        try {
          token = await getGbpAccessToken(GBP_REFRESH_TOKEN, GBP_CLIENT_ID, GBP_CLIENT_SECRET);
        } catch (legacyErr) {
          return c.json({ error: `GBP deploy failed: ${(legacyErr as Error).message}` }, 502);
        }
      }
      try {
        const res = await deployGbpAction(token, action.target.locationId, action);
        detail = { ...detail, gbpOperation: res.operation, gbpTarget: res.target };
      } catch (err) {
        return c.json({ error: `GBP deploy failed: ${(err as Error).message}` }, 502);
      }
    }

    try {
      const next = transition(action, to, defaultEnv(), auditActor(c.get('user'), body.actor), detail);
      const saved = await saveActionTransition(db, next);
      if (to === 'deployed') {
        await markFirstFixDeployed(db, projectId);
        // Queue the check that the fix is actually on the live page. Never
        // throws: a deploy that succeeded must be recorded as deployed even if
        // the check behind it cannot be queued.
        await enqueueVerify(db, projectId, saved, 'service:internal').catch((err: unknown) => {
          console.warn(`verify not queued for action ${saved.id}: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
      return c.json({ action: saved });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 409);
    }
  };
}

/**
 * Queue a verification of one deployed action.
 *
 * The action's own url is what gets fetched; a robots fix is checked against
 * the site's robots.txt instead, which the runner derives from the same url.
 * The entity comes from the action's finding, because the queue row needs one
 * and inventing a different one would attribute the work to the wrong brand.
 */
async function enqueueVerify(
  db: Db,
  projectId: string,
  action: Action,
  requestedBy: string,
): Promise<void> {
  const finding = await getFindingInProject(db, action.findingId, projectId);
  if (!finding) return;
  // The page to fetch is the finding's, not the action's: an Action carries the
  // diff and where it deploys, never the URL it deploys to.
  const url = (finding.evidence as { url?: string }).url;
  if (!url) return;
  await createVerifyRequest(db, {
    projectId,
    entityId: finding.entityId,
    actionId: action.id,
    url,
    requestedBy,
  });
}

/**
 * "Check now" — the same check the deploy queues, on demand.
 *
 * The Verify button this replaces asked the *browser* for the deployed page's
 * HTML, which a browser does not have and cannot fetch cross-origin. It posted
 * an empty string every time, so the matcher failed every time: a control that
 * could not succeed, teaching the customer that deploys do not stick.
 */
app.post('/projects/:projectId/actions/:actionId/verify-request', async (c) => {
  const projectId = c.req.param('projectId');
  const actionId = c.req.param('actionId');
  const db = createDb(c.env.DATABASE_URL);
  const accessError = await projectAccessError(db, projectId, c.get('user'));
  if (accessError) return c.json(accessError.body, accessError.status);

  const action = await getAction(db, actionId);
  if (!action) return c.json({ error: 'action not found' }, 404);
  if (action.status !== 'deployed' && action.status !== 'verified') {
    return c.json({ error: 'this fix has not been deployed yet, so there is nothing to check for.' }, 409);
  }
  const finding = await getFindingInProject(db, action.findingId, projectId);
  const url = finding ? (finding.evidence as { url?: string }).url : undefined;
  if (!url) return c.json({ error: 'this fix is not tied to a page that can be fetched.' }, 409);

  await enqueueVerify(db, projectId, action, auditActor(c.get('user')));
  // Null means one is already queued or running, which is the same answer to
  // the customer: it is being checked.
  return c.json({ queued: true, request: await latestVerifyRequest(db, actionId) }, 202);
});

/** What the last check of this fix found, for the Deployed lane card. */
app.get('/projects/:projectId/actions/:actionId/verify-status', async (c) => {
  const projectId = c.req.param('projectId');
  const db = createDb(c.env.DATABASE_URL);
  const accessError = await projectAccessError(db, projectId, c.get('user'));
  if (accessError) return c.json(accessError.body, accessError.status);
  return c.json({ request: await latestVerifyRequest(db, c.req.param('actionId')) });
});

/**
 * Record that a person read a fix's wording before it can be approved.
 *
 * A content rewrite is model-written prose built from the page's own crawled
 * text, and approving one is publishing words to a customer's site. `approve`
 * refuses a content action that has no review (@engine/actions' `transition`),
 * and this is the only way to get one. The reviewer may send back an edited
 * `after`, which becomes the text that deploys — what lands must be what they
 * read.
 */
app.post('/projects/:projectId/actions/:actionId/review', async (c) => {
  const raw = await readJson(c);
  if (raw === UNPARSEABLE) return c.json({ error: 'body is not valid JSON' }, 400);
  const body = (raw ?? {}) as { after?: unknown };
  if (body.after !== undefined && (typeof body.after !== 'string' || body.after.trim() === '')) {
    return c.json({ error: 'invalid after: expected non-empty text', field: 'after' }, 400);
  }
  const projectId = c.req.param('projectId');
  const db = createDb(c.env.DATABASE_URL);
  const accessError = await projectAccessError(db, projectId, c.get('user'));
  if (accessError) return c.json(accessError.body, accessError.status);
  const action = await getAction(db, c.req.param('actionId'));
  if (!action) return c.json({ error: 'action not found' }, 404);

  // The reviewer is the signed-in person, never a caller-supplied name — a
  // review you can sign someone else's name to is not a review. A service
  // token cannot stand in for a human reading the words either.
  const user = c.get('user');
  if (user.isService) {
    return c.json({ error: 'a person has to read this fix; a service token cannot confirm it' }, 403);
  }
  try {
    const reviewed = reviewMarked(action, defaultEnv(), user.email ?? user.id, body.after as string | undefined);
    return c.json({ action: await saveActionReview(db, reviewed) });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 409);
  }
});

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
  const body = await c.req.json<{ actor?: string; renderedHtml?: string; robotsTxt?: string; gbpState?: string }>();
  const projectId = c.req.param('projectId');
  const db = createDb(c.env.DATABASE_URL);
  const accessError = await projectAccessError(db, projectId, c.get('user'));
  if (accessError) return c.json(accessError.body, accessError.status);
  const action = await getAction(db, c.req.param('actionId'));
  if (!action) return c.json({ error: 'action not found' }, 404);

  const matched =
    action.type === 'gbp'
      ? verifyGbpDeploy(body.gbpState ?? '', action)
      : action.type === 'robots'
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


/* ── Audit requests: "Run audit" and the crawl runner's queue ─────────────── */

/**
 * Non-service callers get 404, not 403: these routes exist for the runner, and
 * telling a signed-in person that a machine door exists helps nobody.
 */
function requireService(c: { get(key: 'user'): AuthUser }): boolean {
  return c.get('user').isService === true;
}

/**
 * The customer's "Run audit". Picks the project's brand (oldest entity) unless
 * one is named, caps pages at the default, and asks GitHub to start the crawl
 * workflow now rather than at the next scheduled pass. One live request per
 * project; a second is a 409 the dashboard turns into "already queued".
 */
app.post('/projects/:projectId/audit-requests', async (c) => {
  const projectId = c.req.param('projectId');
  const invalidId = checkUuidParam(projectId, 'projectId');
  if (invalidId) return c.json({ error: invalidId.message, field: invalidId.field }, 400);

  const raw = c.req.header('content-length') === '0' || !c.req.header('content-type') ? undefined : await readJson(c);
  if (raw === UNPARSEABLE) return c.json({ error: 'body is not valid JSON' }, 400);
  const invalid = checkAuditRequestBody(raw);
  if (invalid) return c.json({ error: `invalid ${invalid.field}: ${invalid.message}`, field: invalid.field }, 400);
  const body = (raw ?? {}) as { entityId?: string; maxPages?: number };

  const db = createDb(c.env.DATABASE_URL);
  const user = c.get('user');
  const accessError = await projectAccessError(db, projectId, user);
  if (accessError) return c.json(accessError.body, accessError.status);

  const project = await getProject(db, projectId);
  if (!project) return c.json({ error: 'project not found', projectId }, 404);

  let entityId = body.entityId;
  if (entityId) {
    if (!(await getEntityInProject(db, projectId, entityId))) {
      return c.json({ error: 'entity does not belong to this project', field: 'entityId' }, 400);
    }
  } else {
    // listEntitiesByProject is newest first; the brand created at setup is the oldest.
    // Self only: a crawl is of the customer's own site, never a rival's.
    const entities = await listEntitiesByProject(db, projectId, 'self');
    entityId = entities.at(-1)?.id;
    if (!entityId) return c.json({ error: 'Add a brand or business name for this site before running an audit.' }, 409);
  }

  const request = await createAuditRequest(db, {
    projectId,
    entityId,
    rootUrl: `https://${project.domain}`,
    maxPages: body.maxPages ?? AUDIT_REQUEST_MAX_PAGES_DEFAULT,
    requestedBy: user.id,
  });
  if (!request) return c.json({ error: 'An audit is already queued or running for this site.' }, 409);

  const dispatch = await dispatchCrawlWorkflow(c.env);
  if (!dispatch.dispatched) console.warn(`audit request ${request.id} queued without dispatch: ${dispatch.reason}`);
  return c.json({ request, dispatched: dispatch.dispatched }, 201);
});

app.get('/projects/:projectId/audit-requests/latest', async (c) => {
  const projectId = c.req.param('projectId');
  const invalidId = checkUuidParam(projectId, 'projectId');
  if (invalidId) return c.json({ error: invalidId.message, field: invalidId.field }, 400);
  const db = createDb(c.env.DATABASE_URL);
  const accessError = await projectAccessError(db, projectId, c.get('user'));
  if (accessError) return c.json(accessError.body, accessError.status);
  return c.json({ request: await latestAuditRequest(db, projectId) });
});

/** The runner's queue scan. Only `status=queued` exists today. */
app.get('/internal/audit-requests', async (c) => {
  if (!requireService(c)) return c.json({ error: 'not found' }, 404);
  const status = c.req.query('status') ?? 'queued';
  if (status !== 'queued') return c.json({ error: 'invalid status: expected "queued"', field: 'status' }, 400);
  const db = createDb(c.env.DATABASE_URL);
  return c.json({ requests: await listQueuedAuditRequests(db) });
});

app.post('/internal/audit-requests/:id/claim', async (c) => {
  if (!requireService(c)) return c.json({ error: 'not found' }, 404);
  const id = c.req.param('id');
  const invalidId = checkUuidParam(id, 'id');
  if (invalidId) return c.json({ error: invalidId.message, field: invalidId.field }, 400);
  const db = createDb(c.env.DATABASE_URL);
  const request = await claimAuditRequest(db, id);
  if (!request) return c.json({ error: 'request is not queued', id }, 409);
  return c.json({ request });
});

app.post('/internal/audit-requests/:id/finish', async (c) => {
  if (!requireService(c)) return c.json({ error: 'not found' }, 404);
  const id = c.req.param('id');
  const invalidId = checkUuidParam(id, 'id');
  if (invalidId) return c.json({ error: invalidId.message, field: invalidId.field }, 400);
  const raw = await readJson(c);
  if (raw === UNPARSEABLE) return c.json({ error: 'body is not valid JSON' }, 400);
  const invalid = checkAuditRequestFinishBody(raw);
  if (invalid) return c.json({ error: `invalid ${invalid.field}: ${invalid.message}`, field: invalid.field }, 400);
  const db = createDb(c.env.DATABASE_URL);
  const request = await finishAuditRequest(db, id, raw as AuditRequestOutcome);
  if (!request) return c.json({ error: 'request is not running', id }, 409);

  // A crawl is the moment the entity's facts changed, so it is the moment the
  // deterministic entity audit is worth running. Only after a success: a crawl
  // that failed re-audits the same stale facts and would put a fresh timestamp
  // on an answer nothing had refreshed. Never throws — the request is finished
  // either way.
  const outcome = raw as AuditRequestOutcome;
  if ('auditRunId' in outcome) await runEntityAuditAfterCrawl(db, request.projectId);

  return c.json({ request });
});

/**
 * The runner reports what it found on the live page.
 *
 * The matcher runs here, not in the runner: the Action and its diff live in
 * this database, and shipping them to a public GitHub Action so it could
 * compare them itself would be sending a customer's proposed content somewhere
 * it does not need to go. The runner fetches bytes and posts them; the API
 * decides what they mean.
 */
app.post('/internal/audit-requests/:id/verify-result', async (c) => {
  if (!requireService(c)) return c.json({ error: 'not found' }, 404);
  const id = c.req.param('id');
  const invalidId = checkUuidParam(id, 'id');
  if (invalidId) return c.json({ error: invalidId.message, field: invalidId.field }, 400);

  const raw = await readJson(c);
  if (raw === UNPARSEABLE) return c.json({ error: 'body is not valid JSON' }, 400);
  const body = raw as { renderedHtml?: string; robotsTxt?: string; error?: string };

  const db = createDb(c.env.DATABASE_URL);
  const request = await getAuditRequest(db, id);
  if (!request || request.kind !== 'verify' || !request.actionId) {
    return c.json({ error: 'verify request not found', id }, 404);
  }

  // The fetch itself failed. Recorded as "checked, not confirmed" with the
  // reason, rather than as a verification failure — an unreachable page and a
  // page missing the change are different things.
  if (typeof body.error === 'string' && body.error !== '') {
    const done = await finishVerifyRequest(db, id, false, body.error.slice(0, 500));
    return c.json({ request: done });
  }

  const action = await getAction(db, request.actionId);
  if (!action) return c.json({ error: 'action not found', id }, 404);

  const matched =
    action.type === 'robots'
      ? verifyRobotsDeploy(body.robotsTxt ?? '', action)
      : verifyHtmlDeploy(body.renderedHtml ?? '', action);

  const done = await finishVerifyRequest(db, id, matched, matched ? undefined : 'The change is not on the live page yet.');
  if (matched && action.status === 'deployed') {
    try {
      const next = transition(action, 'verified', defaultEnv(), 'service:crawl-runner');
      await saveActionTransition(db, next);
    } catch (err) {
      // A concurrent rollback can make 'verified' an illegal move. The check
      // result still stands and is already recorded.
      console.warn(`verified transition refused for ${action.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return c.json({ request: done, verified: matched });
});

/**
 * E onboarding activation (M1.6). `GET /onboarding` returns the checklist plus
 * the two roadmap KPIs: time to first insight (E2, target <10 min) and time
 * to first proposed fix (E3, target <48h), both measured from domain-connect.
 */
app.get('/projects/:projectId/onboarding', async (c) => {
  const projectId = c.req.param('projectId');
  const db = createDb(c.env.DATABASE_URL);
  const accessError = await projectAccessError(db, projectId, c.get('user'));
  if (accessError) return c.json(accessError.body, accessError.status);
  const progress = await getOnboardingProgress(db, projectId);
  return c.json({
    progress,
    kpis: {
      msToFirstInsight: durationMs(progress.domainConnectedAt, progress.firstInsightAt),
      msToFirstFixProposed: durationMs(progress.domainConnectedAt, progress.firstFixProposedAt),
    },
  });
});

app.post('/projects/:projectId/onboarding/domain-connected', async (c) => {
  const projectId = c.req.param('projectId');
  const db = createDb(c.env.DATABASE_URL);
  const accessError = await projectAccessError(db, projectId, c.get('user'));
  if (accessError) return c.json(accessError.body, accessError.status);
  const progress = await markDomainConnected(db, projectId);
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
    console.warn('Stripe checkout is not configured: set STRIPE_SECRET_KEY');
    return c.json({ error: 'Billing is not configured on this deployment.' }, 503);
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

/**
 * M2.5 agency white-label. Before this, `accounts`/`projects` existed only as
 * rows seeded straight into Postgres — no route created either, and nothing
 * linked a signed-in identity to an account. These routes are the first place
 * that link is established, so every one of them upserts the caller into
 * `users` first: an `account_members` row needs a real `users` row to FK
 * against, and there is no Neon Auth webhook wired to do that sync any other way.
 */
app.post('/accounts', async (c) => {
  const raw = await readJson(c);
  if (raw === UNPARSEABLE) return c.json({ error: 'body is not valid JSON' }, 400);
  const invalid = checkCreateAccountBody(raw);
  if (invalid) return c.json({ error: `invalid ${invalid.field}: ${invalid.message}`, field: invalid.field }, 400);
  const body = raw as { name: string };
  const db = createDb(c.env.DATABASE_URL);
  const user = c.get('user');
  await upsertUser(db, user);
  const account = await createAccount(db, body.name, user.id);
  return c.json({ account }, 201);
});

/**
 * The multi-client grid's data source: every account the caller belongs to,
 * each with its project list. Scoped entirely by the caller's own identity
 * (`listAccountsForUser`), not a caller-supplied id, so there is no
 * cross-tenant path to check here — unlike every route below, which takes an
 * `:accountId` from the URL and must verify membership explicitly.
 */
app.get('/accounts', async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  const user = c.get('user');
  await upsertUser(db, user);
  const accounts = await listAccountsForUser(db, user.id);
  // Which providers each client has connected, so the Integrations screen can
  // say "connected under <other client>" instead of reading as disconnected
  // when the selected client is not the one that signed in.
  const connected = await connectedProvidersByAccount(db, accounts.map((a) => a.id));
  return c.json({
    accounts: accounts.map((a) => ({ ...a, connectedProviders: connected.get(a.id) ?? [] })),
  });
});

app.post('/accounts/:accountId/projects', async (c) => {
  const accountId = c.req.param('accountId');
  const invalidId = checkUuidParam(accountId, 'accountId');
  if (invalidId) return c.json({ error: invalidId.message, field: invalidId.field }, 400);

  const raw = await readJson(c);
  if (raw === UNPARSEABLE) return c.json({ error: 'body is not valid JSON' }, 400);
  const invalid = checkCreateProjectBody(raw);
  if (invalid) return c.json({ error: `invalid ${invalid.field}: ${invalid.message}`, field: invalid.field }, 400);
  const body = raw as { name: string; domain: string };

  const db = createDb(c.env.DATABASE_URL);
  const user = c.get('user');
  await upsertUser(db, user);
  // accountId is caller-supplied via the URL — the one new route where that's
  // true, so it needs the explicit membership check the pre-existing
  // /projects/:projectId/* routes are still missing (flagged separately).
  if (!(await isAccountMember(db, accountId, user.id))) {
    return c.json({ error: 'you are not a member of this account', accountId }, 403);
  }
  const project = await createProject(db, accountId, body);
  return c.json({ project }, 201);
});

app.patch('/accounts/:accountId/branding', async (c) => {
  const accountId = c.req.param('accountId');
  const invalidId = checkUuidParam(accountId, 'accountId');
  if (invalidId) return c.json({ error: invalidId.message, field: invalidId.field }, 400);

  const raw = await readJson(c);
  if (raw === UNPARSEABLE) return c.json({ error: 'body is not valid JSON' }, 400);
  const invalid = checkBrandingBody(raw);
  if (invalid) return c.json({ error: `invalid ${invalid.field}: ${invalid.message}`, field: invalid.field }, 400);
  const body = raw as { companyName?: string; logoUrl?: string; primaryColor?: string };

  const db = createDb(c.env.DATABASE_URL);
  const user = c.get('user');
  await upsertUser(db, user);
  if (!(await isAccountMember(db, accountId, user.id))) {
    return c.json({ error: 'you are not a member of this account', accountId }, 403);
  }
  const account = await updateAccountBranding(db, accountId, body);
  return c.json({ account });
});

/**
 * The branded report (M2.5 "branded reports shipping"): one HTML document per
 * account, listing every client project's real A3 unified score (reusing
 * `assembleSurfaceScores`, the same rollup `/projects/:id/pulse` reads) and
 * technical health score (`latestAuditRun`, same as `/projects/:id/audit`).
 * `text/html` rather than a generated PDF — Workers have no headless-Chromium
 * runtime, and a browser's own Print-to-PDF already covers that need.
 */
app.get('/accounts/:accountId/report', async (c) => {
  const accountId = c.req.param('accountId');
  const invalidId = checkUuidParam(accountId, 'accountId');
  if (invalidId) return c.json({ error: invalidId.message, field: invalidId.field }, 400);

  const db = createDb(c.env.DATABASE_URL);
  const user = c.get('user');
  await upsertUser(db, user);
  if (!(await isAccountMember(db, accountId, user.id))) {
    return c.json({ error: 'you are not a member of this account', accountId }, 403);
  }

  const account = await getAccount(db, accountId);
  if (!account) return c.json({ error: 'account not found' }, 404);

  const projects = await listProjectsByAccount(db, accountId);
  const rows: ProjectReportRow[] = await Promise.all(
    projects.map(async (p): Promise<ProjectReportRow> => {
      const [{ surfaces, mix, keywordsTracked, citationSamples }, run] = await Promise.all([
        assembleSurfaceScores(db, p.id, DEFAULT_CHANNEL_MIX),
        latestAuditRun(db, p.id),
      ]);
      const hasData = keywordsTracked > 0 || citationSamples > 0;
      const unified = hasData ? unifiedVisibilityScore(surfaces, mix) : null;
      return {
        id: p.id,
        name: p.name,
        domain: p.domain,
        healthScore: run?.healthScore ?? null,
        unifiedScore: unified?.band.point ?? null,
        keywordsTracked,
        citationSamples,
      };
    }),
  );

  const html = renderAccountReportHtml(account, rows);
  return c.body(html, 200, { 'content-type': 'text/html; charset=utf-8' });
});

/**
 * Per-account Google integrations (GSC + GA4 + GBP). Mounted here rather than
 * written inline: these routes form one coherent unit — consent handshake,
 * resource picker, project assignment — and this file is already long enough.
 *
 * Mounted *after* the `app.use` gates above so `/accounts/*` and `/projects/*`
 * routes inside it inherit `requireAuth`, while `/oauth/google/callback` and
 * `/integrations/providers` stay open by virtue of their paths.
 */
app.route('/', integrationsRoutes);

/**
 * The nightly deterministic audits (off-site, competitor, local), folded into
 * the 03:15 pass behind the Google sync.
 *
 * No new cron, because these need no vendor key and no clock of their own —
 * they read data the system already holds. Running them after the sync means a
 * night's Google data is in place before anything scores against it.
 *
 * Never throws: the sync has already completed by this point, and losing its
 * result to a failure in the pass that follows it would be a worse outcome
 * than an unaudited night.
 */
async function scheduledDeterministicAudits(env: Env): Promise<void> {
  const db = createDb(env.DATABASE_URL);
  try {
    const summary = await runScheduledDeterministicAudits(db);
    if (summary.attempted === 0) {
      console.log('scheduled audits: nothing was due');
      return;
    }
    console.log(
      `scheduled audits: ${summary.ran}/${summary.attempted} run` +
        (summary.capped ? ' (stopped at the per-run cap; the rest follow tomorrow)' : '') +
        (summary.failed.length > 0
          ? `; failures: ${summary.failed.map((f) => `${f.projectId}/${f.kind}: ${f.error}`).join(' | ')}`
          : ''),
    );
  } catch (error) {
    console.error(`scheduled audits failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * The scheduled rank poll (cron, see `wrangler.toml` `[triggers]`).
 *
 * Split from the Google sync because the two have nothing in common but a
 * clock: this one needs a Serper key and no OAuth client, and it runs daily so
 * that a keyword tracked at 'daily' cadence can actually be polled daily.
 * `runScheduledRankPoll` decides which keywords are due.
 */
async function scheduledRankPoll(env: Env): Promise<void> {
  // The keyring is needed to open a client's own Serper key. Without it only
  // the platform key could ever be used, which would silently bill us for
  // lookups a client had paid to make themselves.
  if (!env.ENCRYPTION_KEY && !env.ENCRYPTION_KEYS) {
    console.log('scheduled rank poll skipped: no encryption key is configured');
    return;
  }
  const db = createDb(env.DATABASE_URL);
  const summary = await runScheduledRankPoll(db, env);
  if (summary.attempted === 0) {
    console.log('scheduled rank poll: no tracked keywords were due');
    return;
  }
  console.log(
    `scheduled rank poll: ${summary.polled}/${summary.attempted} polled` +
      (summary.capped ? ' (stopped at the per-run cap; the rest follow tomorrow)' : '') +
      (summary.failed.length > 0
        ? `; failures: ${summary.failed.map((f) => `${f.projectId}/${f.keyword}: ${f.error}`).join(' | ')}`
        : ''),
  );
}

/**
 * The weekly AI-answer poll (cron, see `wrangler.toml` `[triggers]`).
 *
 * Needs no encryption key and no OAuth client: the LLM engines are
 * platform-owned, so unlike the rank poll there is no customer credential to
 * open. `runScheduledAiPoll` decides which prompts are due and returns with an
 * empty summary when no engine is configured at all, so a deployment without
 * `SARVAM_API_KEY` logs a skip rather than failing a cron every night.
 */
async function scheduledAiPoll(env: Env): Promise<void> {
  const db = createDb(env.DATABASE_URL);
  const summary = await runScheduledAiPoll(db, env);
  if (summary.engines.length === 0) {
    console.log('scheduled AI poll skipped: no LLM engine is configured (set SARVAM_API_KEY)');
    return;
  }
  if (summary.attempted === 0) {
    console.log('scheduled AI poll: no prompts were due');
    return;
  }
  console.log(
    `scheduled AI poll: ${summary.polled}/${summary.attempted} prompts polled across ${summary.engines.join(', ')}, ` +
      `${summary.samplesStored} sample(s) stored` +
      (summary.capped ? ' (stopped at the per-run cap; the rest follow tomorrow)' : '') +
      (summary.failed.length > 0
        ? `; failures: ${summary.failed.map((f) => `${f.projectId}/${f.prompt}: ${f.error}`).join(' | ')}`
        : ''),
  );
}

/**
 * Nightly Google sync (cron, see `wrangler.toml` `[triggers]`).
 *
 * The first scheduled handler in this Worker — until now every ingestion path
 * needed someone to press a button or a runner to call in. GSC and GA4 are daily
 * series, so a product that only fetches when a user opens a tab has gaps
 * wherever nobody looked.
 *
 * Runs the same `syncGsc`/`syncGa4`/`syncGbp` functions the on-demand route
 * calls. `runScheduledSync` collects failures rather than throwing: one customer
 * whose token was revoked must not abort every other customer's sync, which is
 * exactly what an uncaught throw in a scheduled handler does.
 */
async function scheduledGoogleSync(env: Env): Promise<void> {
  // `ENCRYPTION_KEY` is the one hard requirement: a stored refresh token
  // cannot be opened without it, so there is genuinely nothing to sync.
  if (!env.ENCRYPTION_KEY && !env.ENCRYPTION_KEYS) {
    console.log('scheduled sync skipped: no encryption key is configured');
    return;
  }
  const db = createDb(env.DATABASE_URL);

  // Engine's OAuth client used to live only in the environment, and this gate
  // asked for `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` on that basis. Since
  // migration 0019 the client is normally configured *in the product* and
  // stored in `platform_credentials`, with the environment as a fallback — so
  // that check skipped the nightly sync on exactly the deployments where a
  // customer had successfully connected, and said "not configured" while the
  // connect flow worked. Ask the question the connect flow itself asks.
  //
  // The environment is checked first so a deployment configured that way needs
  // no query at all. A database error on the second check is left to
  // propagate: "Google is not wired" and "the database is unreachable" are
  // different answers, and reporting the second as the first would turn an
  // outage into a nightly skip nobody reads. A thrown scheduled handler is
  // recorded as a failed cron run, which is what an outage should look like.
  const configured =
    Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) ||
    (await getPlatformClientStatus(db, 'google')) !== null;
  if (!configured) {
    // A no-op beats a cron that logs a failure every night on a deployment
    // that has simply not wired Google yet.
    console.log('scheduled sync skipped: Google integrations are not configured');
    return;
  }

  const summary = await runScheduledSync(db, env);
  console.log(
    `scheduled sync: ${summary.succeeded}/${summary.attempted} succeeded` +
      (summary.failed.length > 0
        ? `; failures: ${summary.failed.map((f) => `${f.provider}/${f.projectId}: ${f.error}`).join(' | ')}`
        : ''),
  );
}

/**
 * One Worker, three schedules. Cloudflare passes the matched cron expression
 * on the event, which is the only thing that distinguishes them.
 *
 * Anything that is not the rank poll or the AI poll runs the Google sync —
 * that includes the nightly `15 3 * * *` and a local
 * `wrangler dev --test-scheduled` trigger, which passes no cron at all. The
 * fallback is deliberate so no cron can quietly do nothing; a fourth schedule
 * needs a case here, and `routes.keywords.test.ts` asserts every expression
 * still matches `wrangler.toml`.
 */
async function scheduled(event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
  if (event.cron === RANK_POLL_CRON) {
    await scheduledRankPoll(env);
    return;
  }
  if (event.cron === AI_POLL_CRON) {
    await scheduledAiPoll(env);
    return;
  }
  await scheduledGoogleSync(env);
  await scheduledDeterministicAudits(env);
}

// Only handlers may be named exports of a Worker's entry module: the runtime
// walks them and refuses anything that is not a function or an
// `ExportedHandler` ("Incorrect type for map entry"), which a string constant
// is not. That failure happens at startup, not at build time, so the Worker
// simply would not boot. `RANK_POLL_CRON` and `AI_POLL_CRON` therefore live
// in ./repositories/rankPoll.js and ./repositories/aiPoll.js.
export { app };

/**
 * Exported as an object rather than the Hono app directly, because a Worker's
 * `scheduled` handler has to live on the default export alongside `fetch`.
 * Tests import the named `app` and call `app.request(...)`.
 */
export default { fetch: app.fetch, scheduled };
