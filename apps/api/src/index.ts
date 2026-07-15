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
import type { Finding } from '@engine/core';
import { createDb } from './db.js';
import { createEntity, listEntitiesByProject } from './repositories/entities.js';
import { createAction, getAction, saveActionTransition } from './repositories/actions.js';

interface Env {
  DATABASE_URL: string;
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
  return c.json({ projectId: c.req.param('projectId'), ...result });
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
  const db = createDb(c.env.DATABASE_URL);
  const generated = generateActions(body.finding, body.context);
  const actions = await Promise.all(generated.map((action) => createAction(db, action)));
  return c.json({ projectId: c.req.param('projectId'), actions });
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
    const body = await c.req.json<{ actor?: string }>().catch(() => ({}) as { actor?: string });
    const db = createDb(c.env.DATABASE_URL);
    const action = await getAction(db, c.req.param('actionId') as string);
    if (!action) return c.json({ error: 'action not found' }, 404);
    try {
      const next = transition(action, to, defaultEnv(), body.actor ?? 'system');
      const saved = await saveActionTransition(db, next);
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

export default app;
