import { el } from '../dom.js';
import { screenName } from '../format.js';
import { serpView } from './serp.js';
import { entityGraphView } from './entityGraph.js';
import { competitorsView } from './competitors.js';
import { offsiteView } from './offsite.js';
import { localView } from './local.js';
import { readableError } from '../errors.js';
import { fetchLocalAvailability } from '../api.js';
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

/**
 * The tab named in `#/visibility/<tab>`, or the first one.
 *
 * Deliberately knows nothing about the Local gate below. This is the name of
 * the tab a hash refers to, used by the breadcrumb as well as by the view, and
 * it is synchronous — a crumb must not wait on a fetch, and a hash that names
 * a gated tab still names it.
 */
export function visibilityTabId(hash: string): string {
  const part = hash.replace(/^#\/?/, '').split('/')[1] ?? '';
  return VISIBILITY_TABS.some((t) => t.id === part) ? part : DEFAULT_TAB;
}

/**
 * The tabs this project actually has.
 *
 * Local is the only conditional one. A business with no location — most SaaS,
 * most publishers — had a fifth tab that could never say anything but "no
 * location scored yet", which teaches that the product is guessing about them.
 * It appears once there is a Business Profile connection, or once someone has
 * typed the location facts in on Integrations.
 *
 * `null` means the answer is not known — the request failed. Unknown shows the
 * tab: a transient API failure must not move a customer off the screen they
 * were on, and an empty tab is a smaller error than a missing one.
 */
export function visibleVisibilityTabs(localAvailable: boolean | null): VisibilityTab[] {
  if (localAvailable === false) return VISIBILITY_TABS.filter((t) => t.id !== 'local');
  return VISIBILITY_TABS;
}

export async function visibilityView(ctx: AppContext): Promise<HTMLElement> {
  // Asked before the strip is built, not after, so the four-or-five decision
  // happens in the same frame as the rest of the screen. The shell already
  // awaits this view, so the gate costs one request and no flash of a tab
  // that is about to disappear.
  const localAvailable = await fetchLocalAvailability().catch(() => null);
  const tabs = visibleVisibilityTabs(localAvailable);

  let active = visibilityTabId(location.hash);
  // A bookmark, or the old `#/local` alias, pointing at a tab this project
  // does not have. Same shape as the shell's `clients` redirect: the
  // destination stays in the table and is simply not this project's.
  if (!tabs.some((t) => t.id === active)) {
    active = DEFAULT_TAB;
    location.hash = `#/visibility/${DEFAULT_TAB}`;
    return el('div', {});
  }

  const body = el('div', { class: 'tabbody' });

  const strip = el(
    'div',
    { class: 'tabstrip', role: 'tablist', 'aria-label': screenName('visibility') },
    tabs.map((t) =>
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

  const tab = tabs.find((t) => t.id === active)!;
  try {
    body.replaceChildren(await tab.view(ctx));
  } catch (err) {
    body.replaceChildren(el('div', { class: 'errbox' }, [`Failed to render: ${readableError(err)}`]));
  }

  return el('div', {}, [strip, body]);
}
