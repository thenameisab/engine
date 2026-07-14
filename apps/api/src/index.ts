import { Hono } from 'hono';
import {
  unifiedVisibilityScore,
  DEFAULT_CHANNEL_MIX,
  type SurfaceScores,
  type ChannelMix,
} from '@engine/scoring';
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

export default app;
