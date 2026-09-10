/**
 * The workspace rail: a permanent column of clients, and the drawer behind it.
 *
 * Switching client used to be a trip to the Clients grid that ended in a
 * toast — the screen you were on did not change, so the only evidence anything
 * had happened was a message that disappeared after two seconds. Which client
 * was open was never stated anywhere else, so on any other screen the answer
 * was "whichever one you picked last, probably".
 *
 * The rail states it permanently and makes changing it one click. The drawer
 * behind it lists every client with its sites, so picking a *site* — the thing
 * the product actually keys on — is one click too, rather than picking a
 * client and hoping the right site came with it.
 */
import { el } from './dom.js';
import { icon, ICONS } from './icons.js';
import { getUser, signOut, initials } from './auth/session.js';
import { signOutRemote } from './auth/neonAuth.js';
import { openDialog } from './dialog.js';
import { readableError } from './errors.js';
import { fetchAccounts, getAccountId, setAccountId, getProjectId, setProjectId } from './api.js';
import {
  clientInitials,
  filterWorkspace,
  needsWorkspaceSearch,
  openSiteLabel,
  type WorkspaceClient,
} from './format.js';
import type { AccountCard } from './types.js';
import type { AppContext } from './context.js';

function toWorkspaceClient(a: AccountCard): WorkspaceClient {
  return {
    id: a.id,
    name: a.name,
    sites: a.projects.map((p) => ({ id: p.id, name: p.name, domain: p.domain })),
    connectedProviders: a.connectedProviders,
  };
}

export interface WorkspaceHandle {
  /** The 56px column, mounted as the first child of `.app`. */
  element: HTMLElement;
  /** The rail header button that names the open site and opens the drawer. */
  header: HTMLElement;
  /**
   * A compact copy for the topbar, shown by CSS only when the rail header is
   * not: a collapsed rail, and every width under 860px. Without it a phone
   * never says which site is open and offers no way to change it, which is the
   * defect this whole rail exists to fix, reintroduced at a smaller size.
   */
  chip: HTMLElement;
  /** Re-read the client list from the API and repaint both. */
  refresh(): Promise<void>;
  openDrawer(): void;
}

/**
 * @param onSwitch Called after a site is chosen, so the shell can re-render the
 *   route in place. Without it the switch is invisible until the next
 *   navigation, which is the defect this replaces.
 */
export function createWorkspace(ctx: AppContext, onSwitch: () => void): WorkspaceHandle {
  let clients: WorkspaceClient[] = [];
  let loadError: string | null = null;

  const squares = el('div', { class: 'ws-squares' });
  const header = el('button', { class: 'ws-header', type: 'button' });
  const chip = el('button', { class: 'ws-chip', type: 'button' });

  const element = el('aside', { class: 'ws-rail', 'aria-label': 'Clients' }, [squares]);

  function select(clientId: string, siteId: string): void {
    setAccountId(clientId);
    setProjectId(siteId);
    paint();
    // Re-render where the user already is. A toast was the only feedback
    // before, on a screen still showing the previous client's numbers.
    onSwitch();
  }

  /* ── The drawer ─────────────────────────────────────────────────────────── */

  function drawerContent(): HTMLElement {
    const list = el('div', { class: 'ws-drawer-list' });
    const search = el('input', {
      class: 'field',
      type: 'search',
      placeholder: 'Search clients and sites',
      'aria-label': 'Search clients and sites',
    }) as HTMLInputElement;

    function renderList(query: string): void {
      const shown = filterWorkspace(clients, query);
      if (shown.length === 0) {
        list.replaceChildren(
          el('div', { class: 'fq-note' }, [
            query ? `Nothing matches “${query}”.` : 'No clients yet. Add one to get started.',
          ]),
        );
        return;
      }
      list.replaceChildren(
        ...shown.map((c) =>
          el('section', { class: 'ws-client' }, [
            el('header', {}, [
              el('span', { class: 'ws-sq sm' }, [clientInitials(c.name)]),
              el('b', {}, [c.name]),
              ...(c.connectedProviders.length > 0
                ? [el('span', { class: 'ws-conn' }, [`${c.connectedProviders.length} connected`])]
                : []),
            ]),
            ...(c.sites.length === 0
              ? [el('div', { class: 'fq-note' }, ['No sites yet.'])]
              : c.sites.map((s) => {
                  const open = s.id === getProjectId();
                  const row = el('button', {
                    class: `ws-site${open ? ' on' : ''}`,
                    type: 'button',
                    ...(open ? { 'aria-current': 'true' } : {}),
                  }, [
                    el('span', { class: 't' }, [s.name]),
                    el('span', { class: 'm' }, [s.domain]),
                  ]);
                  row.addEventListener('click', () => {
                    select(c.id, s.id);
                    handle?.close();
                  });
                  return row;
                })),
          ]),
        ),
      );
    }

    search.addEventListener('input', () => renderList(search.value));
    renderList('');

    return el('div', { class: 'ws-drawer' }, [
      ...(needsWorkspaceSearch(clients) ? [search] : []),
      list,
    ]);
  }

  // `openDialog` already closes on Escape and on a backdrop click, and restores
  // focus to whatever opened it — no reason for the drawer to reimplement it.
  let handle: { close(): void } | null = null;
  function openDrawer(): void {
    if (loadError) {
      ctx.toast(loadError);
      return;
    }
    handle = openDialog({ title: 'Switch client or site', content: drawerContent() });
  }

  /* ── The permanent column ───────────────────────────────────────────────── */

  function paint(): void {
    const activeId = getAccountId();
    const label = openSiteLabel(clients, activeId, getProjectId());

    header.replaceChildren(
      label
        ? el('span', { class: 'ws-header-in' }, [
            el('b', {}, [label.site]),
            el('small', {}, [`${label.client} · ${label.domain}`]),
          ])
        : el('span', { class: 'ws-header-in' }, [el('b', {}, ['Choose a site']), el('small', {}, ['No site open'])]),
      el('span', { class: 'ws-header-chev', html: icon(ICONS.chevron) }),
    );
    header.title = label ? `${label.client} · ${label.site}` : 'Choose a site';

    chip.replaceChildren(
      el('span', { class: 'ws-sq sm' }, [label ? clientInitials(label.client) : '?']),
      el('span', { class: 'ws-chip-t' }, [label ? label.site : 'Choose a site']),
      el('span', { class: 'ws-header-chev', html: icon(ICONS.chevron) }),
    );
    chip.title = header.title;
    chip.setAttribute('aria-label', label ? `${label.client} · ${label.site} — switch` : 'Choose a site');

    const tiles = clients.map((c) => {
      const on = c.id === activeId;
      const sq = el('button', {
        class: `ws-sq${on ? ' on' : ''}`,
        type: 'button',
        title: c.name,
        'aria-label': c.name,
        ...(on ? { 'aria-current': 'true' } : {}),
      }, [clientInitials(c.name)]);
      sq.addEventListener('click', () => {
        // One click goes to that client's only site; more than one is a choice,
        // so the drawer opens rather than guessing which was meant.
        if (c.sites.length === 1) select(c.id, c.sites[0].id);
        else openDrawer();
      });
      return sq;
    });

    const add = el('button', { class: 'ws-sq add', type: 'button', title: 'Add a client', 'aria-label': 'Add a client' }, ['+']);
    add.addEventListener('click', () => ctx.navigate('clients'));

    const user = getUser();
    const me = el('button', {
      class: 'ws-sq me',
      type: 'button',
      title: user ? `${user.name || user.email} — sign out` : 'Sign out',
      'aria-label': 'Sign out',
    }, [user ? initials(user) : 'AG']);
    me.addEventListener('click', () => {
      if (user?.provider === 'google') void signOutRemote();
      signOut();
    });

    squares.replaceChildren(
      ...tiles,
      add,
      el('div', { class: 'ws-spacer' }),
      me,
    );
  }

  header.addEventListener('click', openDrawer);
  chip.addEventListener('click', openDrawer);

  async function refresh(): Promise<void> {
    try {
      clients = (await fetchAccounts()).map(toWorkspaceClient);
      loadError = null;
    } catch (err) {
      // A failed load must not render as "you have no clients", which is the
      // one thing an empty column must never say.
      loadError = readableError(err);
    }
    paint();
  }

  paint();
  return { element, header, chip, refresh, openDrawer };
}
