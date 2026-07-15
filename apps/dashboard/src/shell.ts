import { el } from './dom.js';
import { icon, ICONS } from './icons.js';
import type { AppContext, View } from './context.js';
import type { DataSource } from './types.js';
import { pulseView } from './views/pulse.js';
import { fixQueueView } from './views/fixQueue.js';
import { auditView } from './views/audit.js';
import { integrationsView } from './views/integrations.js';
import { settingsView } from './views/settings.js';

interface Route {
  id: string;
  label: string;
  iconMarkup: string;
  view: View;
}

const ROUTES: Route[] = [
  { id: 'pulse', label: 'Pulse', iconMarkup: ICONS.pulse, view: pulseView },
  { id: 'fix-queue', label: 'Fix Queue', iconMarkup: ICONS.kanban, view: fixQueueView },
  { id: 'audit', label: 'Audit', iconMarkup: ICONS.doc, view: auditView },
  { id: 'integrations', label: 'Integrations', iconMarkup: ICONS.plug, view: integrationsView },
  { id: 'settings', label: 'Settings', iconMarkup: ICONS.gear, view: settingsView },
];

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

export function mountShell(root: HTMLElement): void {
  const badge = el('span', { class: 'srcbadge', title: 'Data source for this view' }, ['sample']);
  const content = el('main', { class: 'content', id: 'content' });
  const toastHost = el('div', { class: 'toast-host' });

  const ctx: AppContext = {
    setBadge(source: DataSource) {
      badge.textContent = source === 'live' ? 'live' : 'sample';
      badge.className = `srcbadge ${source}`;
    },
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
      html: icon(r.iconMarkup) + r.label,
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
      el('b', {}, ['Engine']),
    ]),
    ...navItems,
    el('div', { class: 'spacer' }),
    el('div', { class: 'rail-foot' }, [
      el('span', { class: 'avatar' }, ['AG']),
      el('div', {}, [el('span', {}, ['Internal']), el('small', {}, ['pre-alpha build'])]),
    ]),
  ]);

  const topbar = el('div', { class: 'topbar' }, [
    el('div', { class: 'crumb', id: 'crumb' }, ['Pulse']),
    badge,
    el('div', { class: 'grow' }),
    themeBtn,
  ]);

  root.append(
    el('div', { class: 'app' }, [rail, el('div', { class: 'main' }, [topbar, content])]),
    toastHost,
  );

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
