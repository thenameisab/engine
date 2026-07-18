import {
  applyHtmlActions,
  applyRobotsActions,
  checkHtmlDeployHealth,
  checkRobotsDeployHealth,
  checkRedirectDeployHealth,
  type HealthCheck,
} from '@engine/deploy';
import type { Action } from '@engine/core';
import { createDb } from './db.js';
import { listLiveEdgeActions, type DeployedAction } from './repositories/deployedActions.js';

/**
 * The 'edge-worker' DeployTarget (C2/C3.2/C4.4, Architecture §1 Layer 4).
 * Reverse-proxies a customer origin and rewrites the response with every
 * `deployed`/`verified` Action for this site, read live from Postgres on
 * every request — deploy/rollback are pure DB status flips (apps/api), there
 * is no separate push to this worker.
 *
 * C1.7 automatic rollback: every transform is health-checked (@engine/deploy)
 * before being served. An unhealthy transform is never shown to a visitor —
 * the worker fails safe by serving the untransformed origin response and
 * fires a background rollback call to the API, so a bad fix self-heals
 * without waiting on a human.
 */
interface Env {
  DATABASE_URL: string;
  ORIGIN: string;
  PROJECT_ID: string;
  API_BASE_URL: string;
  /**
   * Service token for the API's auth gate. This worker has no user session, so
   * it authenticates its rollback call with a shared secret bound to both
   * Workers. Without it the API answers 401 and auto-rollback stops working.
   */
  INTERNAL_API_TOKEN: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const originUrl = new URL(url.pathname + url.search, env.ORIGIN);

    const db = createDb(env.DATABASE_URL);
    const actions = await listLiveEdgeActions(db, env.PROJECT_ID);

    // A redirect short-circuits before origin is ever fetched (C4.1/C4.2) —
    // unlike a schema/meta/robots fix, there's no origin content to health-
    // check the transform against, so this is a straight 301 or a rollback.
    const redirectAction = actions.find((a) => a.type === 'redirect' && a.diff.before === originUrl.toString());
    if (redirectAction) {
      const health = checkRedirectDeployHealth(redirectAction.diff.before, redirectAction.diff.after);
      if (!health.ok) {
        ctx.waitUntil(autoRollback(env, [redirectAction], health));
      } else {
        return new Response(null, { status: 301, headers: { location: redirectAction.diff.after } });
      }
    }

    const originResp = await fetch(originUrl.toString(), request);

    if (url.pathname === '/robots.txt') {
      return handleRobots(originResp, actions, env, ctx);
    }

    const contentType = originResp.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html')) return originResp;

    const pageActions = actions.filter(
      (a) => (a.type === 'schema' || a.type === 'meta') && a.pageUrl === originUrl.toString(),
    );
    if (pageActions.length === 0) return originResp;

    return handleHtml(originResp, pageActions, env, ctx);
  },
};

async function handleHtml(
  originResp: Response,
  pageActions: DeployedAction[],
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const html = await originResp.text();
  const transformed = applyHtmlActions(html, pageActions);
  const health = checkHtmlDeployHealth(originResp.status, html, transformed);

  if (!health.ok) {
    ctx.waitUntil(autoRollback(env, pageActions, health));
    return new Response(html, { status: originResp.status, headers: originResp.headers });
  }

  return new Response(transformed, { status: originResp.status, headers: originResp.headers });
}

async function handleRobots(
  originResp: Response,
  actions: DeployedAction[],
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const robotsActions = actions.filter((a) => a.type === 'robots');
  const rewritten = applyRobotsActions(robotsActions);
  if (rewritten === null) return originResp;

  const health = checkRobotsDeployHealth(originResp.status, rewritten);
  if (!health.ok) {
    ctx.waitUntil(autoRollback(env, robotsActions, health));
    return originResp;
  }

  return new Response(rewritten, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

/** Flip every action that just produced an unsafe transform back to `rolled_back`, with the reason on the audit log. */
async function autoRollback(env: Env, actions: Pick<Action, 'id'>[], health: HealthCheck): Promise<void> {
  await Promise.all(
    actions.map((action) =>
      fetch(`${env.API_BASE_URL}/projects/${env.PROJECT_ID}/actions/${action.id}/rollback`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${env.INTERNAL_API_TOKEN}`,
        },
        body: JSON.stringify({
          actor: 'system:edge-worker-health-check',
          detail: { reason: health.reason },
        }),
      })
        .then((res) => {
          // Never throws on a 4xx/5xx, so an auth or API failure here would
          // otherwise vanish — and a rollback that silently did not happen is
          // the worst outcome this path has. Serving is already safe (we
          // returned the origin response); this is the record that it stuck.
          if (!res.ok) {
            console.error(`auto-rollback failed for action ${action.id}: ${res.status}`);
          }
        })
        .catch((err: unknown) => {
          console.error(`auto-rollback request errored for action ${action.id}:`, err);
        }),
    ),
  );
}
