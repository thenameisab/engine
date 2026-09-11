/**
 * M2.5 "multi-client grid": every account (client) the signed-in caller
 * belongs to, with its real project list. Clicking into a project sets it as
 * the active project (same mechanism Settings already uses) and navigates to
 * Pulse — the existing single-project views render it as-is, no per-project
 * rework needed.
 */
import { el } from '../dom.js';
import { screenName } from '../format.js';
import { fetchAccounts, fetchInvitations, inviteToAccount, withdrawInvitation, setAccountId, setProjectId, type ApiInvitation } from '../api.js';
import { ONBOARDING_INTENT_KEY } from './onboarding.js';
import type { AppContext } from '../context.js';
import type { AccountCard, ApiProject } from '../types.js';
import { readableError } from '../errors.js';

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

/**
 * Invite a teammate to this client, and see who has not yet accepted.
 *
 * An invitation carries no link to click: the invitee signs in with a code
 * sent to the invited address, and the sign-in accepts it. So the list here
 * is "sent, not yet signed in", and it empties as people arrive. Owners can
 * invite; the API refuses anyone else, and the message says so.
 */
function invitePanel(a: AccountCard, ctx: AppContext): HTMLElement {
  const list = el('div', { class: 'client-invites' });
  const input = el('input', { class: 'field', type: 'email', placeholder: 'teammate@company.com', autocomplete: 'off' }) as HTMLInputElement;

  const renderList = (invitations: ApiInvitation[]) => {
    list.replaceChildren(
      ...invitations.map((inv) =>
        el('div', { class: 'client-invite' }, [
          el('span', { class: 't' }, [inv.email]),
          el('span', { class: 'm' }, [`invited · ${inv.role}`]),
          el('button', {
            class: 'linklike',
            onclick: async () => {
              try {
                await withdrawInvitation(a.id, inv.id);
                ctx.toast(`Invitation to ${inv.email} withdrawn.`);
                void load();
              } catch (err) {
                ctx.toast(`Could not withdraw: ${readableError(err)}`);
              }
            },
          }, ['Withdraw']),
        ]),
      ),
    );
  };

  const load = async () => {
    try {
      renderList(await fetchInvitations(a.id));
    } catch {
      // A member who cannot list invitations still sees the client card.
      list.replaceChildren();
    }
  };

  const send = el('button', { class: 'btn', type: 'submit' }, ['Invite']);
  // A <form>, so Enter in the field sends the invitation — the same reason the
  // sign-in card is one.
  const form = el('form', {
    class: 'client-invite-form',
    novalidate: true,
    onsubmit: async (e: Event) => {
      e.preventDefault();
      const address = input.value.trim();
      if (!address || !address.includes('@')) {
        ctx.toast('Enter an email address to invite.');
        input.focus();
        return;
      }
      send.setAttribute('disabled', 'true');
      try {
        await inviteToAccount(a.id, address);
        input.value = '';
        ctx.toast(`Invitation sent to ${address}. They sign in with a code to accept.`);
      } catch (err) {
        ctx.toast(`Could not invite: ${readableError(err)}`);
      } finally {
        send.removeAttribute('disabled');
        // Reload either way: a 502 means the invitation was saved and only the
        // email failed, and the pending row is how the owner sees that.
        void load();
      }
    },
  }, [input, send]);

  void load();
  return el('div', { class: 'client-invite-panel' }, [form, list]);
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
      ? el('div', { class: 'emptybox' }, ['No projects yet for this client.'])
      : el('div', { class: 'client-projects' }, a.projects.map((p) => projectRow(p, a.id, ctx))),
    invitePanel(a, ctx),
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
      grid.append(el('div', { class: 'errbox' }, [`Could not load your clients: ${loadError}`]));
      return;
    }
    if (accounts.length === 0) {
      grid.append(el('div', { class: 'emptybox' }, ['No clients yet. Create one to get started.']));
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
