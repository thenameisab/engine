/**
 * M1.4/M1.5 verification: confirm a `deployed` Action's diff actually landed on
 * the live surface before the Fix Queue transitions it to `verified`. Pure
 * comparison against caller-supplied post-deploy content (the fetch itself is a
 * transport detail, same pattern as the audit/pulse endpoints).
 */
import type { Action } from '@engine/core';
import { escapeHtml } from './html.js';

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
    return false;
  }
  return false;
}

/** True if a robots.txt action's `after` text landed verbatim (modulo surrounding whitespace). */
export function verifyRobotsDeploy(robotsTxt: string, action: Pick<Action, 'type' | 'diff'>): boolean {
  if (action.type !== 'robots') return false;
  return robotsTxt.trim() === action.diff.after.trim();
}
