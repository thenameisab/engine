import { el } from '../dom.js';
import { screenName } from '../format.js';
import { serpView } from './serp.js';
import { entityGraphView } from './entityGraph.js';
import { competitorsView } from './competitors.js';
import { offsiteView } from './offsite.js';
import { localView } from './local.js';
import { readableError } from '../errors.js';
import type { AppContext, View } from '../context.js';

/**
 * Visibility: the five screens that answer "who is finding us, and where".
 *
 * They were five of eleven items in the nav rail, which made the rail a list
 * of the product's internals rather than of the questions a customer has. Four
 * of the five are also empty for a new site — a rail where most destinations
 * say "nothing here yet" teaches the customer that the product is not for
 * them. Grouped under one destination, an empty tab is a tab, not a dead end
 * at the top level.
 *
 * The five views are mounted unchanged, each keeping its own `.pagehead` as
 * the heading for its tab. This container adds the tab strip and nothing else;
 * merging their content properly is the data-screen work in
 * `docs/reviews/2026-09-09-redesign-build-plan.md` §5.
 */

export interface VisibilityTab {
  id: string;
  view: View;
}

/** Order is the order a customer asks the questions: where do we rank, who are we, who else, who is cited, and where locally. */
export const VISIBILITY_TABS: VisibilityTab[] = [
  { id: 'rankings', view: serpView },
  { id: 'brand', view: entityGraphView },
  { id: 'competitors', view: competitorsView },
  { id: 'ai-answers', view: offsiteView },
  { id: 'local', view: localView },
];

const DEFAULT_TAB = VISIBILITY_TABS[0].id;

/** The tab named in `#/visibility/<tab>`, or the first one. */
export function visibilityTabId(hash: string): string {
  const part = hash.replace(/^#\/?/, '').split('/')[1] ?? '';
  return VISIBILITY_TABS.some((t) => t.id === part) ? part : DEFAULT_TAB;
}

export async function visibilityView(ctx: AppContext): Promise<HTMLElement> {
  const active = visibilityTabId(location.hash);
  const body = el('div', { class: 'tabbody' });

  const strip = el(
    'div',
    { class: 'tabstrip', role: 'tablist', 'aria-label': screenName('visibility') },
    VISIBILITY_TABS.map((t) =>
      el('a', {
        class: `tab${t.id === active ? ' on' : ''}`,
        href: `#/visibility/${t.id}`,
        role: 'tab',
        'aria-selected': t.id === active ? 'true' : 'false',
      }, [screenName(t.id)]),
    ),
  );

  // On a phone the strip scrolls, and the tab the user is on can be past the
  // right edge — the screen then shows a heading with no visible tab marked.
  // `nearest` so a tab already in view is not yanked to the middle.
  // On a phone the strip scrolls, and the tab the user is on can be past the
  // right edge — the screen then shows a heading with no visible tab marked.
  //
  // `scrollLeft` on the strip, not `scrollIntoView` on the tab, which walks
  // every scrollable ancestor and can move more than the strip. A frame, not
  // a microtask, because the shell appends this element after the view
  // resolves and an element out of the document has no offsets.
  requestAnimationFrame(() => {
    const on = strip.querySelector<HTMLElement>('.tab.on');
    if (!on) return;
    const overflowRight = on.offsetLeft + on.offsetWidth - (strip.scrollLeft + strip.clientWidth);
    if (overflowRight > 0) strip.scrollLeft += overflowRight;
    else if (on.offsetLeft < strip.scrollLeft) strip.scrollLeft = on.offsetLeft;
  });

  const tab = VISIBILITY_TABS.find((t) => t.id === active)!;
  try {
    body.replaceChildren(await tab.view(ctx));
  } catch (err) {
    body.replaceChildren(el('div', { class: 'errbox' }, [`Failed to render: ${readableError(err)}`]));
  }

  return el('div', {}, [strip, body]);
}
