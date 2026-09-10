/**
 * M2.5 "multi-client grid": every account (client) the signed-in caller
 * belongs to, with its real project list. Clicking into a project sets it as
 * the active project (same mechanism Settings already uses) and navigates to
 * Pulse — the existing single-project views render it as-is, no per-project
 * rework needed.
 */
import { el } from '../dom.js';
import { screenName } from '../format.js';
import { fetchAccounts, setAccountId, setProjectId } from '../api.js';
import { ONBOARDING_INTENT_KEY } from './onboarding.js';
import type { AppContext } from '../context.js';
import type { AccountCard, ApiProject } from '../types.js';

/**
 * `accountId` as well as `projectId`, and the pairing is the fix.
 *
 * Selecting a project used to set only the project id. Every project-scoped
 * screen worked, and every account-scoped one did not: Integrations reported
 * "Pick a client from the Clients grid first" to a customer who had just
 * picked one from the Clients grid. The two ids are set together here because
 * a project belongs to exactly one account, so there is no state in which
 * knowing the project and not the account is correct.
 */
function projectRow(p: ApiProject, accountId: string, ctx: AppContext): HTMLElement {
  return el('button', {
    class: 'client-project',
    onclick: () => {
      setAccountId(accountId);
      setProjectId(p.id);
      ctx.toast(`Switched to ${p.name}`);
      ctx.navigate('pulse');
    },
  }, [
    el('span', { class: 't' }, [p.name]),
    el('span', { class: 'm' }, [p.domain]),
  ]);
}

function accountCard(a: AccountCard, ctx: AppContext, onNewProject: (accountId: string) => void): HTMLElement {
  const color = a.branding.primaryColor ?? '#4f46e5';
  const initial = (a.branding.companyName ?? a.name).slice(0, 1).toUpperCase();
  const logo = a.branding.logoUrl
    ? el('img', { class: 'client-logo', src: a.branding.logoUrl, alt: a.name })
    : el('div', { class: 'client-logo-fallback', style: `background:${color}` }, [initial]);

  return el('section', { class: 'panel client-card' }, [
    el('header', { class: 'client-head' }, [
      logo,
      el('div', {}, [
        el('h3', {}, [a.branding.companyName ?? a.name]),
        el('span', { class: 'more' }, [a.projects.length === 1 ? '1 project' : `${a.projects.length} projects`]),
      ]),
      el('button', {
        class: 'btn',
        style: 'margin-left:auto',
        onclick: () => onNewProject(a.id),
      }, ['+ Project']),
    ]),
    a.projects.length === 0
      ? el('div', { class: 'fq-note' }, ['No projects yet for this client.'])
      : el('div', { class: 'client-projects' }, a.projects.map((p) => projectRow(p, a.id, ctx))),
    el('div', { class: 'client-actions' }, [
      el('button', {
        class: 'linklike',
        onclick: () => {
          setAccountId(a.id);
          ctx.navigate('report');
        },
      }, ['View branded report →']),
      el('button', {
        class: 'linklike',
        onclick: () => {
          setAccountId(a.id);
          ctx.navigate('settings');
        },
      }, ['Edit branding →']),
    ]),
  ]);
}

export async function accountsView(ctx: AppContext): Promise<HTMLElement> {
  let accounts: AccountCard[] = [];
  let loadError: string | null = null;
  try {
    accounts = await fetchAccounts();
  } catch (err) {
    loadError = (err as Error).message;
  }

  const grid = el('div', { class: 'client-grid' });

  const rerender = () => {
    grid.replaceChildren();
    if (loadError) {
      grid.append(el('div', { class: 'fq-note' }, [`Could not load your clients: ${loadError}`]));
      return;
    }
    if (accounts.length === 0) {
      grid.append(el('div', { class: 'fq-note' }, ['No clients yet. Create one to get started.']));
      return;
    }
    grid.append(...accounts.map((a) => accountCard(a, ctx, onNewProject)));
  };

  // Both creation paths go through Get started: one form instead of three
  // native prompt() dialogs, and the same form a first-time user lands on.
  function onNewProject(accountId: string): void {
    setAccountId(accountId);
    ctx.navigate('get-started');
  }

  function onNewClient(): void {
    try {
      sessionStorage.setItem(ONBOARDING_INTENT_KEY, 'new-client');
    } catch {
      /* storage unavailable: the form still opens, on the selected client */
    }
    ctx.navigate('get-started');
  }

  rerender();

  return el('div', {}, [
    el('div', { class: 'pagehead' }, [
      el('h1', {}, [screenName('clients')]),
      el('p', {}, ['Every client you manage, with its real projects and branded reporting.']),
      el('button', { class: 'btn primary', onclick: onNewClient }, ['+ New client']),
    ]),
    grid,
  ]);
}
