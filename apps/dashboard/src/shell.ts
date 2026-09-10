import { el } from './dom.js';
import { icon, ICONS } from './icons.js';
import { getUser, signOut, initials } from './auth/session.js';
import { signOutRemote } from './auth/neonAuth.js';
import { mountCopilot } from './copilot.js';
import type { AppContext, View } from './context.js';
import { pulseView } from './views/pulse.js';
import { serpView } from './views/serp.js';
import { fixQueueView } from './views/fixQueue.js';
import { auditView } from './views/audit.js';
import { entityGraphView } from './views/entityGraph.js';
import { competitorsView } from './views/competitors.js';
import { offsiteView } from './views/offsite.js';
import { localView } from './views/local.js';
import { integrationsView } from './views/integrations.js';
import { settingsView } from './views/settings.js';
import { accountsView } from './views/accounts.js';
import { reportView } from './views/report.js';
import { onboardingView } from './views/onboarding.js';
import { getProjectId } from './api.js';
import { createWorkspace } from './workspace.js';

interface Route {
  id: string;
  label: string;
  iconMarkup: string;
  view: View;
}

const ROUTES: Route[] = [
  { id: 'pulse', label: 'Pulse', iconMarkup: ICONS.pulse, view: pulseView },
  { id: 'serp', label: 'Rankings', iconMarkup: ICONS.serp, view: serpView },
  { id: 'fix-queue', label: 'Fix Queue', iconMarkup: ICONS.kanban, view: fixQueueView },
  { id: 'audit', label: 'Audit', iconMarkup: ICONS.doc, view: auditView },
  { id: 'entity-graph', label: 'Entity Graph', iconMarkup: ICONS.entity, view: entityGraphView },
  { id: 'competitors', label: 'Competitors', iconMarkup: ICONS.versus, view: competitorsView },
  { id: 'offsite', label: 'AI answers', iconMarkup: ICONS.link, view: offsiteView },
  { id: 'local', label: 'Local SEO', iconMarkup: ICONS.pin, view: localView },
  { id: 'integrations', label: 'Integrations', iconMarkup: ICONS.plug, view: integrationsView },
  { id: 'clients', label: 'Clients', iconMarkup: ICONS.clients, view: accountsView },
  { id: 'settings', label: 'Settings', iconMarkup: ICONS.gear, view: settingsView },
];

/**
 * M2.5's report view is reached from a Clients-grid card, not the primary
 * nav rail — dispatchable, but not one of the rail's `navItems`. Kept out of
 * `ROUTES` so the rail doesn't grow a link nobody navigates to directly.
 */
const HIDDEN_ROUTES: Route[] = [
  { id: 'report', label: 'Branded report', iconMarkup: ICONS.doc, view: reportView },
  { id: 'get-started', label: 'Get started', iconMarkup: ICONS.check, view: onboardingView },
];

/**
 * Routes that read the selected project. With none selected each of them
 * used to render its own error banner ("No project selected…"); the shell
 * now sends the user to Get started instead, which offers existing sites or
 * creates one.
 */
const PROJECT_ROUTES = new Set(['pulse', 'serp', 'fix-queue', 'audit', 'entity-graph', 'competitors', 'offsite', 'local']);

const ALL_ROUTES = [...ROUTES, ...HIDDEN_ROUTES];

const RAIL_KEY = 'engine.railCollapsed';

/** The live `hashchange` handler, so re-mounting the shell replaces it rather than adding another. */
let hashListener: (() => void) | null = null;

function currentRouteId(): string {
  const id = location.hash.replace(/^#\/?/, '');
  return ALL_ROUTES.some((r) => r.id === id) ? id : 'pulse';
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
  const content = el('main', { class: 'content', id: 'content' });
  const toastHost = el('div', { class: 'toast-host' });

  const ctx: AppContext = {
    toast(message: string) {
      const t = el('div', { class: 'toast' }, [message]);
      toastHost.append(t);
      setTimeout(() => t.classList.add('in'), 10);
      setTimeout(() => {
        t.classList.remove('in');
        setTimeout(() => t.remove(), 200);
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
      title: r.label,
      html: icon(r.iconMarkup) + `<span class="navlabel">${r.label}</span>`,
    }),
  );

  const themeBtn = el('button', { class: 'iconbtn', title: 'Toggle theme' });
  applyThemeIcon(themeBtn);
  themeBtn.addEventListener('click', () => {
    document.documentElement.setAttribute('data-theme', isDark() ? 'light' : 'dark');
    applyThemeIcon(themeBtn);
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
    el('div', { class: 'crumb', id: 'crumb' }, ['Pulse']),
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
    const id = currentRouteId();
    if (PROJECT_ROUTES.has(id) && !getProjectId()) {
      location.hash = '#/get-started';
      return;
    }
    const route = ALL_ROUTES.find((r) => r.id === id)!;
    navItems.forEach((n) => n.classList.toggle('on', n.getAttribute('data-route') === id));
    (document.getElementById('crumb') as HTMLElement).textContent = route.label;
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
