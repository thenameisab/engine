/**
 * M1.4/M1.5 verification: confirm a `deployed` Action's diff actually landed on
 * the live surface before the Fix Queue transitions it to `verified`. Pure
 * comparison against caller-supplied post-deploy content (the fetch itself is a
 * transport detail, same pattern as the audit/pulse endpoints).
 */
import type { Action, DeployTarget } from '@engine/core';
import { escapeHtml } from './html.js';

/**
 * Whether reaching `deployed` on this target kind means the live page changed,
 * and so whether fetching it can verify anything.
 *
 * `edge-worker` and `cms-plugin` apply the diff during the deploy transition,
 * so the page is different the moment it returns. `github-pr` only opens a pull
 * request — nothing on the customer's site changes until someone merges it, and
 * the verify enqueue used to fire for it too, checking an unchanged page and
 * reporting "not found on the page yet" about a fix nobody had rejected.
 * `gbp-api` writes to a Business Profile listing, which is not a page a crawl
 * can fetch at all.
 *
 * A merged PR is checked by the API's scheduled merge pass, which enqueues the
 * same verify request once the merge is real.
 */
export function deployChangesTheLivePage(kind: DeployTarget['kind']): boolean {
  return kind === 'edge-worker' || kind === 'cms-plugin';
}

/** True if the live HTML already reflects this schema/meta action's `after` value. */
export function verifyHtmlDeploy(html: string, action: Pick<Action, 'type' | 'diff'>): boolean {
  if (action.type === 'schema') return html.includes(action.diff.after);
  if (action.type === 'meta') {
    if (action.diff.field === 'title') {
      return html.includes(`<title>${escapeHtml(action.diff.after)}</title>`);
    }
    if (action.diff.field === 'description') {
      return html.includes(escapeHtml(action.diff.after));
    }
    if (action.diff.field === 'hreflang') {
      return html.includes(action.diff.after);
    }
    return false;
  }
  return false;
}

/** True if a robots.txt action's `after` text landed verbatim (modulo surrounding whitespace). */
export function verifyRobotsDeploy(robotsTxt: string, action: Pick<Action, 'type' | 'diff'>): boolean {
  if (action.type !== 'robots') return false;
  return robotsTxt.trim() === action.diff.after.trim();
}

/** True if the observed response is the redirect this action's diff describes. */
export function verifyRedirectDeploy(
  observed: { status: number; location: string },
  action: Pick<Action, 'type' | 'diff'>,
): boolean {
  if (action.type !== 'redirect') return false;
  return observed.status === 301 && observed.location === action.diff.after;
}
