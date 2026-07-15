import { Hono } from 'hono';
import {
  unifiedVisibilityScore,
  DEFAULT_CHANNEL_MIX,
  type SurfaceScores,
  type ChannelMix,
} from '@engine/scoring';
import { runAudit, type CrawledPage } from '@engine/diagnosis';
import { generateActions, type ActionContext } from '@engine/actions';
import type { Finding } from '@engine/core';
import { createDb } from './db.js';
import { createEntity, listEntitiesByProject } from './repositories/entities.js';

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
 * needed to build a concrete before→after diff. Returned actions are `proposed`
 * and enter the Fix Queue for human approval before deploy.
 */
app.post('/projects/:projectId/actions/generate', async (c) => {
  const body = await c.req.json<{ finding: Finding; context: ActionContext }>();
  const actions = generateActions(body.finding, body.context);
  return c.json({ projectId: c.req.param('projectId'), actions });
});

export default app;
