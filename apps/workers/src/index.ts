import { applyHtmlActions, applyRobotsActions } from '@engine/deploy';
import { createDb } from './db.js';
import { listLiveEdgeActions } from './repositories/deployedActions.js';

/**
 * The 'edge-worker' DeployTarget (C2/C3.2/C4.4, Architecture §1 Layer 4).
 * Reverse-proxies a customer origin and rewrites the response with every
 * `deployed`/`verified` Action for this site, read live from Postgres on
 * every request — deploy/rollback are pure DB status flips (apps/api), there
 * is no separate push to this worker.
 */
interface Env {
  DATABASE_URL: string;
  ORIGIN: string;
  PROJECT_ID: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const originUrl = new URL(url.pathname + url.search, env.ORIGIN);
    const originResp = await fetch(originUrl.toString(), request);

    const db = createDb(env.DATABASE_URL);
    const actions = await listLiveEdgeActions(db, env.PROJECT_ID);

    if (url.pathname === '/robots.txt') {
      const rewritten = applyRobotsActions(actions);
      if (rewritten === null) return originResp;
      return new Response(rewritten, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }

    const contentType = originResp.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html')) return originResp;

    const pageActions = actions.filter(
      (a) => (a.type === 'schema' || a.type === 'meta') && a.pageUrl === originUrl.toString(),
    );
    if (pageActions.length === 0) return originResp;

    const html = await originResp.text();
    const transformed = applyHtmlActions(html, pageActions);
    return new Response(transformed, { status: originResp.status, headers: originResp.headers });
  },
};
