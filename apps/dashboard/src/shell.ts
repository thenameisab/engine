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
import { settingsView } from './views/settings.js';

interface Route {
  id: string;
  label: string;
  iconMarkup: string;
  view: View;
}

const ROUTES: Route[] = [
  { id: 'pulse', label: 'Pulse', iconMarkup: ICONS.pulse, view: pulseView },
  { id: 'serp', label: 'SERP Inspector', iconMarkup: ICONS.serp, view: serpView },
  { id: 'fix-queue', label: 'Fix Queue', iconMarkup: ICONS.kanban, view: fixQueueView },
  { id: 'audit', label: 'Audit', iconMarkup: ICONS.doc, view: auditView },
  { id: 'settings', label: 'Settings', iconMarkup: ICONS.gear, view: settingsView },
];

const RAIL_KEY = 'engine.railCollapsed';

function currentRouteId(): string {
  const id = location.hash.replace(/^#\/?/, '');
  return ROUTES.some((r) => r.id === id) ? id : 'pulse';
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
  const label = user?.name || 'Internal';
  const sub = user?.email || 'pre-alpha build';
  const signOutBtn = el('button', {
    class: 'signout',
    title: 'Sign out',
    onclick: () => {
      void signOutRemote();
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

  const rail = el('aside', { class: 'rail' }, [
    el('div', { class: 'brand' }, [
      el('span', { class: 'mark', html: `<svg viewBox="0 0 24 24" fill="none">${ICONS.logo}</svg>` }),
      el('b', { class: 'navlabel' }, ['Engine']),
    ]),
    ...navItems,
    el('div', { class: 'spacer' }),
    railFoot(),
  ]);

  // ---- collapsible rail ----
  const appEl = el('div', { class: 'app' }, [rail, el('div', { class: 'main' })]);
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
    el('div', { class: 'crumb', id: 'crumb' }, ['Pulse']),
    el('div', { class: 'grow' }),
    el('span', { class: 'kbdhint', title: 'Open the Copilot' }, ['⌘K']),
    themeBtn,
  ]);

  const main = appEl.querySelector('.main') as HTMLElement;
  main.append(topbar, content);
  root.append(appEl, toastHost);
  mountCopilot(root);

  let startCollapsed = false;
  try {
    startCollapsed = localStorage.getItem(RAIL_KEY) === '1';
  } catch {
    /* ignore */
  }
  applyRail(startCollapsed);

  async function renderRoute(): Promise<void> {
    const id = currentRouteId();
    const route = ROUTES.find((r) => r.id === id)!;
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

  addEventListener('hashchange', renderRoute);
  void renderRoute();
}
