import { el } from './dom.js';
import { icon, ICONS } from './icons.js';
import { getUser, signOut, initials } from './auth/session.js';
import { signOutRemote } from './auth/neonAuth.js';
import { mountCopilot } from './copilot.js';
import type { AppContext, View } from './context.js';
import { pulseView } from './views/pulse.js';
import { fixQueueView } from './views/fixQueue.js';
import { auditView } from './views/audit.js';
import { visibilityView, visibilityTabId } from './views/visibility.js';
import { integrationsView } from './views/integrations.js';
import { settingsView } from './views/settings.js';
import { accountsView } from './views/accounts.js';
import { reportView } from './views/report.js';
import { onboardingView } from './views/onboarding.js';
import { getProjectId } from './api.js';
import { screenName, breadcrumb } from './format.js';
import { createWorkspace } from './workspace.js';

interface Route {
  id: string;
  iconMarkup: string;
  view: View;
}

/**
 * Six destinations, from eleven.
 *
 * The old rail listed the product's screens: Pulse, Rankings, Fix Queue,
 * Findings, Entity Graph, Competitors, AI answers, Local SEO, Integrations,
 * Clients, Settings. Eleven nouns, of which a new customer's site had data for
 * two, and of which "Clients" meant nothing at all to a customer who is not an
 * agency. Reading the rail told you how Engine is built, not what you can do.
 *
 * These six are the questions instead: what is wrong, what is being fixed, who
 * is finding us, what is connected, and how it is set up. The five that went
 * are tabs inside Visibility; Clients is reached from the workspace column,
 * which is where a client is switched anyway.
 *
 * Labels come from `SCREEN_NAMES`, so the rail, the breadcrumb and the page's
 * h1 cannot drift apart.
 */
const ROUTES: Route[] = [
  { id: 'home', iconMarkup: ICONS.pulse, view: pulseView },
  { id: 'findings', iconMarkup: ICONS.doc, view: auditView },
  { id: 'fixes', iconMarkup: ICONS.kanban, view: fixQueueView },
  { id: 'visibility', iconMarkup: ICONS.serp, view: visibilityView },
  { id: 'integrations', iconMarkup: ICONS.plug, view: integrationsView },
  { id: 'settings', iconMarkup: ICONS.gear, view: settingsView },
];

/**
 * Reachable, but not from the rail. `report` opens from a Clients card,
 * `get-started` from the redirect below, `clients` from the workspace column's
 * "+".
 */
const HIDDEN_ROUTES: Route[] = [
  { id: 'report', iconMarkup: ICONS.doc, view: reportView },
  { id: 'get-started', iconMarkup: ICONS.check, view: onboardingView },
  { id: 'clients', iconMarkup: ICONS.clients, view: accountsView },
];

/**
 * Where the old hashes go. A customer who bookmarked `#/pulse` or `#/serp`, or
 * who follows a link from a report written before this change, lands on the
 * screen they meant rather than silently on Home.
 */
const ROUTE_ALIASES: Record<string, string> = {
  pulse: 'home',
  audit: 'findings',
  'fix-queue': 'fixes',
  serp: 'visibility/rankings',
  'entity-graph': 'visibility/brand',
  competitors: 'visibility/competitors',
  offsite: 'visibility/ai-answers',
  local: 'visibility/local',
};

/**
 * Routes that read the selected project. With none selected each of them
 * used to render its own error banner ("No project selected…"); the shell
 * sends the user to Set up instead, which offers existing sites or creates
 * one.
 */
const PROJECT_ROUTES = new Set(['home', 'findings', 'fixes', 'visibility']);

const ALL_ROUTES = [...ROUTES, ...HIDDEN_ROUTES];

const RAIL_KEY = 'engine.railCollapsed';
const THEME_KEY = 'engine.theme';

/** The live `hashchange` handler, so re-mounting the shell replaces it rather than adding another. */
let hashListener: (() => void) | null = null;

/**
 * The route the hash names. Only the first segment is the route — Visibility
 * carries its tab in the second (`#/visibility/rankings`), so a tab change is
 * a `hashchange` on the same route rather than a route the shell cannot find.
 */
function currentRouteId(): string {
  const id = location.hash.replace(/^#\/?/, '').split('/')[0];
  return ALL_ROUTES.some((r) => r.id === id) ? id : 'home';
}

/** The route an old hash means, or null if the hash is already current. */
function aliasFor(hash: string): string | null {
  const first = hash.replace(/^#\/?/, '').split('/')[0];
  return ROUTE_ALIASES[first] ?? null;
}

// ---- theme ----
function isDark(): boolean {
  const t = document.documentElement.getAttribute('data-theme');
  if (t) return t === 'dark';
  return matchMedia('(prefers-color-scheme: dark)').matches;
}
function applyThemeIcon(btn: HTMLElement): void {
  btn.innerHTML = icon(isDark() ? ICONS.sun : ICONS.moon);
}
/**
 * The choice outlived the tab it was made in, next to the rail's collapsed
 * state. Reloading used to drop it back to the system setting, so a user on a
 * light system who works in dark had to press the button on every visit.
 * No stored value means no choice was made, and the system setting stands.
 */
function restoreTheme(): void {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'dark' || saved === 'light') document.documentElement.setAttribute('data-theme', saved);
  } catch {
    /* storage unavailable — the system setting stands */
  }
}

function railFoot(): HTMLElement {
  const user = getUser();
  const label = user?.name || 'Your account';
  const sub = user?.email || 'Signed in';
  const signOutBtn = el('button', {
    class: 'signout',
    title: 'Sign out',
    onclick: () => {
      // Only a Google session has anything to sign out of remotely; a password
      // session's token is ours and is dropped by `signOut`. Calling Neon Auth
      // for it would be a request that can only fail.
      if (user?.provider === 'google') void signOutRemote();
      signOut();
    },
    html: icon(ICONS.signout),
  });
  return el('div', { class: 'rail-foot' }, [
    el('span', { class: 'avatar' }, [user ? initials(user) : 'AG']),
    el('div', { class: 'navlabel rail-user' }, [el('span', {}, [label]), el('small', {}, [sub])]),
    el('span', { class: 'navlabel', style: 'margin-left:auto' }, [signOutBtn]),
  ]);
}

export function mountShell(root: HTMLElement): void {
  restoreTheme();
  const content = el('main', { class: 'content', id: 'content' });
  const toastHost = el('div', { class: 'toast-host' });

  const ctx: AppContext = {
    toast(message: string) {
      const t = el('div', { class: 'toast', role: 'status', 'aria-live': 'polite' }, [message]);
      toastHost.append(t);
      // Two chained timers used to stand in for "after the first paint" and
      // "once the exit finished". The first raced a slow frame and showed the
      // toast already in place; the second guessed 200ms at a duration the
      // stylesheet owns. The frame callback and the transition's own end event
      // are the real signals.
      requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('in')));
      setTimeout(() => {
        t.addEventListener('transitionend', () => t.remove(), { once: true });
        t.classList.remove('in');
      }, 2600);
    },
    navigate(route: string) {
      location.hash = `#/${route}`;
    },
  };

  const navItems = ROUTES.map((r) =>
    el('a', {
      class: 'navitem',
      href: `#/${r.id}`,
      'data-route': r.id,
      title: screenName(r.id),
      html: icon(r.iconMarkup) + `<span class="navlabel">${screenName(r.id)}</span>`,
    }),
  );

  const themeBtn = el('button', { class: 'iconbtn', title: 'Toggle theme' });
  applyThemeIcon(themeBtn);
  themeBtn.addEventListener('click', () => {
    const next = isDark() ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    applyThemeIcon(themeBtn);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* storage unavailable — the choice still holds for this tab */
    }
  });

  // The workspace column and the rail header are one unit: the column says
  // which client is open, the header says which of that client's sites. Both
  // open the same drawer. `renderRoute` is re-run on a switch so the screen the
  // user is already looking at changes — a toast used to be the only sign.
  const workspace = createWorkspace(ctx, () => void renderRoute());

  const rail = el('aside', { class: 'rail' }, [
    el('div', { class: 'brand' }, [
      el('span', { class: 'mark', html: `<svg viewBox="0 0 24 24" fill="none">${ICONS.logo}</svg>` }),
      el('b', { class: 'navlabel' }, ['Engine']),
    ]),
    el('div', { class: 'navlabel' }, [workspace.header]),
    ...navItems,
    el('div', { class: 'spacer' }),
    railFoot(),
  ]);

  // ---- collapsible rail ----
  const appEl = el('div', { class: 'app' }, [workspace.element, rail, el('div', { class: 'main' })]);
  function applyRail(collapsed: boolean): void {
    appEl.classList.toggle('rail-collapsed', collapsed);
    collapseBtn.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  }
  const collapseBtn = el('button', { class: 'iconbtn', title: 'Collapse sidebar', html: icon(ICONS.sidebar) });
  collapseBtn.addEventListener('click', () => {
    const next = !appEl.classList.contains('rail-collapsed');
    applyRail(next);
    try {
      localStorage.setItem(RAIL_KEY, next ? '1' : '0');
    } catch {
      /* storage unavailable (e.g. sandboxed preview) — collapse still works for the session */
    }
  });

  const topbar = el('div', { class: 'topbar' }, [
    collapseBtn,
    workspace.chip,
    el('div', { class: 'crumb', id: 'crumb' }, [screenName('home')]),
    el('div', { class: 'grow' }),
    el('span', { class: 'kbdhint', title: 'Open the Copilot' }, ['⌘K']),
    themeBtn,
  ]);

  const main = appEl.querySelector('.main') as HTMLElement;
  main.append(topbar, content);
  // `replaceChildren`, not `append`. Signing in re-boots the app with the auth
  // screen still in the root: appending left the shell mounted *underneath* a
  // full-viewport `.auth-screen`, so the user appeared stuck on the sign-in
  // page and only a reload fixed it — on reload the session already exists, so
  // the auth screen is never mounted and the root is empty. Symmetric with
  // `mountAuthScreen`, which has always cleared the root.
  root.replaceChildren(appEl, toastHost);
  mountCopilot(root);

  let startCollapsed = false;
  try {
    startCollapsed = localStorage.getItem(RAIL_KEY) === '1';
  } catch {
    /* ignore */
  }
  applyRail(startCollapsed);
  // After the first paint: the column renders from what is already selected, so
  // the shell is never blank waiting on the network, and fills in when the
  // client list arrives.
  void workspace.refresh();

  async function renderRoute(): Promise<void> {
    const alias = aliasFor(location.hash);
    if (alias) {
      location.hash = `#/${alias}`;
      return;
    }
    const id = currentRouteId();
    if (PROJECT_ROUTES.has(id) && !getProjectId()) {
      location.hash = '#/get-started';
      return;
    }
    const route = ALL_ROUTES.find((r) => r.id === id)!;
    navItems.forEach((n) => {
      const on = n.getAttribute('data-route') === id;
      n.classList.toggle('on', on);
      // A class is a colour; `aria-current` is the fact. A screen reader had
      // no way to tell which of the six the user was on.
      if (on) n.setAttribute('aria-current', 'page');
      else n.removeAttribute('aria-current');
    });
    const tab = id === 'visibility' ? screenName(visibilityTabId(location.hash)) : undefined;
    (document.getElementById('crumb') as HTMLElement).textContent = breadcrumb(
      workspace.siteName(),
      screenName(id),
      tab,
    );
    content.replaceChildren(el('div', { class: 'loading num' }, ['loading…']));
    try {
      const view = await route.view(ctx);
      content.replaceChildren(view);
    } catch (err) {
      content.replaceChildren(el('div', { class: 'errbox' }, [`Failed to render: ${(err as Error).message}`]));
    }
    content.scrollTop = 0;
  }

  // Registered on `window`, which outlives the shell, so a re-mount (sign out,
  // sign back in) would otherwise stack a second listener and render every
  // route twice. Dropping the previous one keeps exactly one live.
  if (hashListener) removeEventListener('hashchange', hashListener);
  hashListener = renderRoute;
  addEventListener('hashchange', hashListener);
  void renderRoute();
}
