/**
 * Edge-worker deploy target for the C4.4 robots.txt fix. Each 'robots' Action's
 * `diff.after` is already the complete, self-contained new robots.txt (computed
 * by @engine/actions' `unblockCrawlers`), so applying it is a straight replace —
 * the most recently deployed robots action for a project wins.
 */
import type { Action } from '@engine/core';

export function applyRobotsActions(actions: readonly Pick<Action, 'type' | 'diff'>[]): string | null {
  const robotsActions = actions.filter((a) => a.type === 'robots');
  if (robotsActions.length === 0) return null;
  return robotsActions[robotsActions.length - 1].diff.after;
}
