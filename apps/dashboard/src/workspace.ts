/**
 * The workspace rail: a permanent column of accounts, and the drawer behind it.
 *
 * The column and the word "client" are an agency's, not everyone's. A company
 * with one site has one account, which is itself, so a column holding one
 * square that does nothing is the client layer a non-agency was told it would
 * never see. `showsClients()` decides whether the column exists; the drawer
 * behind the header lists sites flat when there is no client layer to group
 * them under.
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
import {
  currentAccountVocabulary,
  fetchAccounts,
  getAccountId,
  setAccountId,
  getProjectId,
  setProjectId,
  showsClients,
} from './api.js';
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
  /** The open site's name, or null when none is chosen. Used by the breadcrumb. */
  siteName(): string | null;
  /**
   * Whether the column of account squares is rendered. The shell reads it to
   * drop the 56 px track from the page grid, because an `aside` that is hidden
   * still holds its column.
   */
  showsColumn(): boolean;
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

  const element = el('aside', { class: 'ws-rail' }, [squares]);

  function select(clientId: string, siteId: string): void {
    setAccountId(clientId);
    setProjectId(siteId);
    paint();
    // Re-render where the user already is. A toast was the only feedback
    // before, on a screen still showing the previous client's numbers.
    onSwitch();
  }

  /* ── The drawer ─────────────────────────────────────────────────────────── */

  function siteRow(client: WorkspaceClient, s: { id: string; name: string; domain: string }): HTMLElement {
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
      select(client.id, s.id);
      handle?.close();
    });
    return row;
  }

  function drawerContent(): HTMLElement {
    const v = currentAccountVocabulary();
    const list = el('div', { class: 'ws-drawer-list' });
    // Without a client layer there is nothing to group by, so the drawer is a
    // list of sites and the field searches sites. Saying "clients and sites"
    // to a company names a thing that is not in the list.
    const searchLabel = v.agency ? 'Search clients and sites' : 'Search sites';
    const search = el('input', {
      class: 'field',
      type: 'search',
      placeholder: searchLabel,
      'aria-label': searchLabel,
    }) as HTMLInputElement;

    function renderList(query: string): void {
      const shown = filterWorkspace(clients, query);
      if (shown.length === 0) {
        list.replaceChildren(
          el('div', { class: 'emptybox' }, [
            query ? `Nothing matches “${query}”.`
            : v.agency ? 'No clients yet. Add one to get started.'
            : 'No sites yet. Add one to get started.',
          ]),
        );
        return;
      }
      if (!v.agency) {
        const sites = shown.flatMap((c) => c.sites.map((site) => siteRow(c, site)));
        list.replaceChildren(
          ...(sites.length > 0 ? sites : [el('div', { class: 'emptybox' }, ['No sites yet.'])]),
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
              ? [el('div', { class: 'emptybox' }, ['No sites yet.'])]
              : c.sites.map((s) => siteRow(c, s))),
          ]),
        ),
      );
    }

    search.addEventListener('input', () => renderList(search.value));
    renderList('');

    // The threshold counts the rows the drawer actually shows: clients when
    // they group the list, sites when they are the list.
    const rows = v.agency ? clients.length : clients.reduce((n, c) => n + c.sites.length, 0);

    return el('div', { class: 'ws-drawer' }, [
      ...(needsWorkspaceSearch(rows) ? [search] : []),
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
    handle = openDialog({
      title: currentAccountVocabulary().agency ? 'Switch client or site' : 'Switch site',
      content: drawerContent(),
    });
  }

  /* ── The permanent column ───────────────────────────────────────────────── */

  function paint(): void {
    const v = currentAccountVocabulary();
    const column = showsClients();
    const activeId = getAccountId();
    const label = openSiteLabel(clients, activeId, getProjectId());

    // Without a client layer the client name is the account's own, derived
    // from the same domain printed beside it, so naming it is the word
    // "client" and a repetition in one line.
    const sub = label ? (v.agency ? `${label.client} · ${label.domain}` : label.domain) : 'No site open';
    const full = label ? (v.agency ? `${label.client} · ${label.site}` : `${label.site} · ${label.domain}`) : 'Choose a site';

    header.replaceChildren(
      label
        ? el('span', { class: 'ws-header-in' }, [el('b', {}, [label.site]), el('small', {}, [sub])])
        : el('span', { class: 'ws-header-in' }, [el('b', {}, ['Choose a site']), el('small', {}, [sub])]),
      el('span', { class: 'ws-header-chev', html: icon(ICONS.chevron) }),
    );
    header.title = full;

    chip.replaceChildren(
      el('span', { class: 'ws-sq sm' }, [label ? clientInitials(v.agency ? label.client : label.site) : '?']),
      el('span', { class: 'ws-chip-t' }, [label ? label.site : 'Choose a site']),
      el('span', { class: 'ws-header-chev', html: icon(ICONS.chevron) }),
    );
    chip.title = full;
    chip.setAttribute('aria-label', label ? `${full} — switch` : 'Choose a site');

    // The column is an agency's, or anyone's who has more than one account to
    // switch between. Hidden rather than emptied, so it does not sit as a
    // 56 px band of background beside the rail.
    element.hidden = !column;
    element.setAttribute('aria-label', v.Many);
    if (!column) {
      squares.replaceChildren();
      return;
    }

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

    // Only an agency adds a client: the Clients grid is where that happens and
    // it redirects to Home for everyone else, so a "+" would lead nowhere.
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
      ...(v.agency ? [add] : []),
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
  return {
    element,
    header,
    chip,
    siteName: () => openSiteLabel(clients, getAccountId(), getProjectId())?.site ?? null,
    showsColumn: showsClients,
    refresh,
    openDrawer,
  };
}
