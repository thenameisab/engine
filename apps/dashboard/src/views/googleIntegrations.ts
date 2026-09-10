import { el } from '../dom.js';
import { logoTile } from '../logo.js';
import { infoCard, type HoverCardContent } from '../hovercard.js';
import { openDialog, type DialogHandle } from '../dialog.js';
import { readableError } from '../errors.js';
import { integrationTileState, relativeTime, syncStatusLine } from '../format.js';
import {
  getAccountId,
  setAccountId,
  fetchAccounts,
  fetchProviderCatalog,
  fetchConnections,
  fetchConnectUrl,
  fetchProviderResources,
  fetchEntities,
  disconnectProvider,
  connectApiKey,
  fetchProjectIntegrations,
  fetchPlatformAccess,
  assignProviderResource,
  unassignProviderResource,
  syncProvider,
} from '../api.js';
import type { AppContext } from '../context.js';
import type {
  ProviderId,
  ProviderCatalogEntry,
  IntegrationConnection,
  IntegrationAssignment,
  ProviderResource,
} from '../types.js';

/**
 * The screen where a customer connects their own accounts.
 *
 * A gallery of every provider, each a tile with one status word. Clicking a
 * tile opens one panel that does the one thing that provider needs: a sign-in
 * button for a consent flow, a key form for a pasted key, a "coming soon" note
 * for a planned one. Once connected, the same panel is where the property or
 * site is chosen, synced, and disconnected.
 *
 * Nothing operator-facing renders here. Engine's own OAuth client and the
 * deployment's vendor keys live under Settings. When the OAuth client is
 * missing, an administrator's tile says "Needs setup" and the panel links
 * there; a customer's tile says "Not available yet" and the panel says who to
 * ask. Neither is a disabled button with the reason hidden behind a hover.
 *
 * Copy rule: a sentence stays on screen only if it is needed to make the next
 * decision. Vendor caveats (an access request, write access, APIs to enable)
 * are short chips with the sentence one hover away.
 */

/**
 * What is wrong, as a short line plus the explanation behind it.
 *
 * Split because the two have different jobs: the line has to be readable at a
 * glance from across the card, and the explanation only matters once someone
 * has decided to care about it.
 */
function healthProblem(
  connection: IntegrationConnection,
): { line: string; detail: string[] } | null {
  if (connection.status === 'needs_reauth') {
    return {
      line: 'Reconnect needed',
      detail: [
        'The provider rejected the stored credential. That usually means access was revoked from the provider’s own account settings, or the password on that account changed.',
        'Syncing has stopped and will not resume until this is reconnected.',
      ],
    };
  }
  if (connection.status === 'connected' && !connection.scopesSufficient) {
    return {
      line: 'Missing a permission',
      detail: [
        'This connected successfully but without one of the permissions it needs — a box was left unticked on the consent screen.',
        'Reconnect and accept everything requested. Reads will keep failing until you do.',
      ],
    };
  }
  return null;
}

/**
 * Open Google's consent screen in a popup and resolve when the callback page
 * reports back.
 *
 * A popup rather than a full-page redirect so the user keeps the screen they
 * were on. The callback page posts a message and closes itself; the polling
 * fallback covers the case where the user closes the popup by hand, which would
 * otherwise leave this promise pending forever.
 */
function openConsentPopup(url: string): Promise<'connected' | 'cancelled' | 'closed'> {
  return new Promise((resolve) => {
    const popup = window.open(url, 'engine-google-oauth', 'width=520,height=680');
    if (!popup) {
      // Popup blocked. Falling back to the current tab is better than silently
      // doing nothing; the callback page offers a link back.
      window.location.href = url;
      resolve('closed');
      return;
    }

    let settled = false;
    const finish = (outcome: 'connected' | 'cancelled' | 'closed') => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      clearInterval(poll);
      resolve(outcome);
    };

    function onMessage(event: MessageEvent) {
      const data = event.data as { source?: string; status?: string } | null;
      if (!data || data.source !== 'engine-oauth') return;
      finish(data.status === 'connected' ? 'connected' : 'cancelled');
    }

    window.addEventListener('message', onMessage);
    const poll = setInterval(() => {
      if (popup.closed) finish('closed');
    }, 500);
  });
}

/**
 * Which vendor account this is, for the "Connected as" line.
 *
 * `externalLabel` is the current field; `googleEmail` was its name before the
 * registry went vendor-neutral. Both are read because a Pages build and a
 * Worker deploy never land in the same instant, and for an API-key provider
 * neither exists — the first non-secret field (a site URL, an account id) is
 * what distinguishes two connections of the same vendor.
 */
function connectedAsLabel(connection: IntegrationConnection | undefined): string | null {
  if (!connection) return null;
  const named = connection.externalLabel ?? connection.googleEmail;
  if (named) return named;
  const publicValues = Object.values(connection.publicFields ?? {});
  return publicValues[0] ?? null;
}

/**
 * A short chip with its explanation one hover away.
 *
 * The alternative — which this replaces — was a paragraph per fact stacked
 * down the card. Two or three words carry the same signal at a glance, and the
 * sentence is still there for anyone who wants it.
 */
function badge(text: string, tone: 'warn' | '', label: string, content: HoverCardContent): HTMLElement {
  return el('span', { class: `intg-badge ${tone}`.trim() }, [text, infoCard(label, content)]);
}

/**
 * The connect form for a provider that takes a pasted key.
 *
 * Rendered from the registry's field descriptors, so a new API-key provider
 * needs no code here. Three deliberate properties:
 *
 *   - secret fields are `type="password"` and `autocomplete="off"`, so a
 *     browser does not offer to save a customer's vendor credential into a
 *     password manager keyed to *our* domain;
 *   - the value is read at submit and never held anywhere that outlives it —
 *     no localStorage, no module-level variable;
 *   - the declared pattern is applied client-side as well as server-side. The
 *     server's check is the real one; this one just turns a round trip into an
 *     immediate answer.
 */
function apiKeyForm(input: {
  ctx: AppContext;
  accountId: string;
  entry: ProviderCatalogEntry;
  connected: boolean;
  reload: () => void;
}): HTMLElement {
  const { ctx, accountId, entry, connected, reload } = input;
  const fields = entry.fields ?? [];
  const inputs = new Map<string, HTMLInputElement>();

  const rows = fields.map((field) => {
    const control = el('input', {
      class: 'field',
      type: field.secret ? 'password' : 'text',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: field.help ?? '',
    }) as HTMLInputElement;
    inputs.set(field.name, control);
    return el('div', { class: 'form-row' }, [
      el('label', { class: 'label' }, [field.label, field.secret ? el('span', { class: 'tagband' }, ['secret']) : null]),
      control,
      field.help ? el('div', { class: 'fhint' }, [field.help]) : null,
    ]);
  });

  const label = connected ? `Replace ${entry.name} key` : `Connect ${entry.name}`;
  const submit = el(
    'button',
    {
      class: 'btn primary',
      onclick: async () => {
        const values: Record<string, string> = {};
        for (const field of fields) {
          const raw = (inputs.get(field.name)?.value ?? '').trim();
          if (!raw) {
            ctx.toast(`${field.label} is required.`);
            return;
          }
          if (field.pattern && !new RegExp(`^(?:${field.pattern})$`).test(raw)) {
            // Never echoes the value — it is the secret, and a toast is read
            // over someone's shoulder as easily as anything else on screen.
            ctx.toast(`${field.label} does not look right. Check you copied the whole value.`);
            return;
          }
          values[field.name] = raw;
        }
        // The API checks the key with the vendor before storing it, which can
        // take a few seconds; say so, and refuse a second click meanwhile.
        submit.setAttribute('disabled', 'true');
        submit.textContent = 'Checking the key…';
        try {
          await connectApiKey(accountId, entry.id, values);
          // Cleared on success as well as being unstored: a key left in a DOM
          // node is still a key on the page.
          for (const control of inputs.values()) control.value = '';
          ctx.toast(`${entry.name} connected.`);
          reload();
        } catch (err) {
          ctx.toast(`Could not connect: ${readableError(err)}`);
          submit.removeAttribute('disabled');
          submit.textContent = label;
        }
      },
    },
    [label],
  );

  return el('div', { class: 'intg-apikey' }, [
    ...rows,
    el('div', { class: 'form-actions' }, [submit]),
  ]);
}

interface ProviderPanelInput {
  ctx: AppContext;
  accountId: string;
  entry: ProviderCatalogEntry;
  connection: IntegrationConnection | undefined;
  assignments: IntegrationAssignment[];
  platformReady: boolean;
  isAdmin: boolean;
  reload: () => void;
  /** The client these connections belong to, by name. */
  clientName: string | null;
  /** Other clients of this user under which the provider is connected. */
  elsewhere: string[];
}

/** The status pill shared by the tile and the panel header. */
function statusPill(text: string, tone: 'good' | 'watch' | 'muted' | null): HTMLElement {
  return el('span', { class: `intg-pill${tone ? ` ${tone}` : ''}` }, [text]);
}

/**
 * Facts about a provider worth flagging but not worth a paragraph. Each is a
 * short chip; the sentence is its hover card.
 */
function providerBadges(entry: ProviderCatalogEntry): HTMLElement[] {
  const badges: HTMLElement[] = [];
  if (entry.requiresAccessRequest) {
    // Stated up front rather than discovered as a 403 weeks later.
    badges.push(
      badge('Needs vendor approval', 'warn', `${entry.name} access request`, {
        title: 'Zero quota until approved',
        body: [
          'The provider gates this API behind an access request, not just an enable toggle, and approval takes weeks.',
          'Connecting will succeed before that. Reads will not.',
        ],
      }),
    );
  }
  if (entry.writes) {
    badges.push(
      badge('Grants write access', '', `What ${entry.name} can change`, {
        title: 'This connection can write',
        body: [
          'The provider offers no read-only equivalent, so connecting grants write access.',
          'Nothing is written until you approve a fix in the Fix Queue.',
        ],
      }),
    );
  }
  const setup = entry.setupSteps ?? entry.requiredApis ?? [];
  if (setup.length > 0) {
    badges.push(
      badge('Setup required', '', `${entry.name} setup steps`, {
        title: 'Do these at the provider first',
        body: ['Each one otherwise arrives as a 403 that does not explain itself.'],
        list: setup,
        link: entry.docsUrl ? { href: entry.docsUrl, label: 'Provider documentation' } : undefined,
      }),
    );
  }
  return badges;
}

/**
 * The connect panel for one provider. What it shows depends on one question:
 * can this person connect it right now? If yes, the primary action is the
 * first thing in the panel. If no, the reason is, in words, with the one thing
 * that would change it.
 */
/**
 * "Sync now". A 28-day Search Console window is thousands of rows and takes
 * real seconds, so the button says so and cannot be pressed twice — every
 * other action in this screen already does that, and this one did not.
 */
function syncButton(
  entry: { id: ProviderId; name: string },
  ctx: AppContext,
  reload: () => void,
): HTMLElement {
  const btn = el('button', {
    class: 'btn',
    onclick: async () => {
      btn.setAttribute('disabled', 'true');
      btn.textContent = 'Syncing…';
      try {
        await syncProvider(entry.id);
        ctx.toast(`${entry.name} sync finished. Pulse shows the new data.`);
        reload();
      } catch (err) {
        ctx.toast(`Sync failed: ${readableError(err)}`);
        btn.removeAttribute('disabled');
        btn.textContent = 'Sync now';
      }
    },
  }, ['Sync now']);
  return btn;
}

function providerPanel(input: ProviderPanelInput): HTMLElement {
  const { ctx, accountId, entry, connection, assignments, platformReady, isAdmin, reload, clientName, elsewhere } = input;
  const live = connection?.status === 'connected';
  const problem = connection ? healthProblem(connection) : null;
  const isApiKey = entry.authKind === 'api_key';
  // A GitHub App is installed on repositories, not signed in to. The verbs on
  // this panel are the customer's only clue about what is about to happen.
  const isApp = entry.authKind === 'github_app';
  const vendor = entry.vendor ?? 'the provider';

  const purpose = el('p', { class: 'intg-purpose' }, [entry.purpose]);
  const docs = entry.docsUrl
    ? el('a', { class: 'linklike', href: entry.docsUrl, target: '_blank', rel: 'noopener' }, [`${entry.name} documentation ↗`])
    : null;

  /* ── Blocked cases: say why, and what changes it ─────────────────────── */

  if (entry.availability === 'planned') {
    return el('div', { class: 'intg-panel' }, [
      purpose,
      el('div', { class: 'intg-note' }, ['Coming soon. This integration is on the roadmap and cannot be connected yet.']),
      docs,
    ]);
  }

  // A connection under another of this user's clients is not a failure
  // here. Say where it is connected, and that connections do not carry over.
  const elsewhereNote =
    !live && elsewhere.length > 0
      ? el('div', { class: 'fhint num' }, [
          `Connected under ${elsewhere.join(' and ')}, not under ${clientName ?? 'this client'}. ` +
            'Connections belong to one client, so sign in here to use it for this one.',
        ])
      : null;

  if (!isApiKey && !platformReady && !live) {
    return el('div', { class: 'intg-panel' }, [
      purpose,
      elsewhereNote,
      el('div', { class: 'intg-note warn' }, [
        isAdmin
          ? `Engine's ${vendor} app is not registered for this workspace yet. Register it once under Settings, and every client can connect from here.`
          : `${vendor} is not set up for this workspace yet. Ask your administrator to finish the setup.`,
      ]),
      isAdmin
        ? el('div', { class: 'form-actions' }, [
            el('button', { class: 'btn primary', onclick: () => ctx.navigate('settings') }, [`Finish ${vendor} setup`]),
          ])
        : null,
    ]);
  }

  /* ── Connect / reconnect ───────────────────────────────────────────────── */

  const signIn = el('button', {
    class: live ? 'btn' : 'btn primary intg-signin',
    onclick: async () => {
      try {
        const url = await fetchConnectUrl(accountId, entry.id, window.location.hash || '/');
        const outcome = await openConsentPopup(url);
        if (outcome === 'connected') {
          ctx.toast(`${entry.name} connected.`);
          reload();
        } else if (outcome === 'cancelled') {
          ctx.toast('Nothing was connected.');
        } else {
          // The popup closed without reporting. It may still have succeeded, so
          // reload rather than asserting either way.
          reload();
        }
      } catch (err) {
        ctx.toast(`Could not start the connection: ${readableError(err)}`);
      }
    },
  }, [
    isApp
      ? live
        ? 'Change which repositories'
        : connection?.status === 'needs_reauth'
          ? `Install on ${vendor} again`
          : `Install on ${vendor}`
      : live || connection?.status === 'needs_reauth'
        ? `Reconnect ${vendor}`
        : `Sign in with ${vendor}`,
  ]);

  const disconnectButton = connection && connection.status !== 'revoked'
    ? el('button', {
        class: 'btn',
        onclick: async () => {
          if (!window.confirm(`Disconnect ${entry.name}? Syncing stops for every project using it.`)) return;
          try {
            const { revokedAtVendor, revocationSupported } = await disconnectProvider(accountId, entry.id);
            // Three outcomes, not two. A vendor with no revocation endpoint
            // (an API key) has not "refused" — there was nothing to call, and
            // saying access was revoked there would be a false promise.
            ctx.toast(
              !revocationSupported
                ? `${entry.name} disconnected. Revoke the key at ${entry.name} to fully sever access.`
                : revokedAtVendor
                  ? `${entry.name} disconnected and access revoked at the provider.`
                  : `${entry.name} disconnected. The provider reported the grant was already gone.`,
            );
            reload();
          } catch (err) {
            ctx.toast(`Could not disconnect: ${readableError(err)}`);
          }
        },
      }, ['Disconnect'])
    : null;

  /* ── The resource picker ──────────────────────────────────────────────── */

  const pickerHost = el('div', { class: 'intg-picker' }, []);

  const loadPicker = async () => {
    pickerHost.replaceChildren(el('div', { class: 'fhint num' }, [`Loading ${entry.resourceNoun}s…`]));
    let resources: ProviderResource[] = [];
    try {
      const result = await fetchProviderResources(accountId, entry.id);
      resources = result.resources;
      if (result.truncated) {
        ctx.toast(`Showing the first page of ${entry.resourceNoun}s — there are more than we listed.`);
      }
    } catch (err) {
      pickerHost.replaceChildren(
        el('div', { class: 'fq-note' }, [`Could not list ${entry.resourceNoun}s: ${readableError(err)}`]),
      );
      return;
    }

    if (resources.length === 0) {
      pickerHost.replaceChildren(
        el('div', { class: 'fq-note' }, [
          `This ${vendor} account can see no ${entry.resourceNoun}s. Check you connected the account that owns them.`,
        ]),
      );
      return;
    }

    const select = el(
      'select',
      { class: 'field' },
      resources.map((r) =>
        el(
          'option',
          { value: r.id, ...(r.selectable ? {} : { disabled: 'true' }) },
          [r.selectable ? `${r.label}${r.detail ? ` — ${r.detail}` : ''}` : `${r.label} (no access)`],
        ),
      ),
    ) as HTMLSelectElement;

    // GBP assigns to an entity (a location *is* an entity), so it needs one more
    // field. It used to ask for a uuid typed by hand, which no customer has and
    // which fails silently as a 400 if mistyped. The entities are already known,
    // so the field is a list of them. Still not invented on the customer's
    // behalf — connecting an integration must not create rows in their graph as
    // a side effect — so an account with no entity yet is told to add one.
    // `GET /entities` returns the customer's own brands only, so a competitor
    // added by domain can never be offered as a location.
    const entityOptions = entry.id === 'gbp' ? await fetchEntities().catch(() => []) : [];
    const entitySelect = el(
      'select',
      { class: 'field' },
      entityOptions.map((e) => el('option', { value: e.id }, [e.canonicalName])),
    ) as HTMLSelectElement;

    const assign = el('button', {
      class: 'btn primary',
      onclick: async () => {
        const chosen = resources.find((r) => r.id === select.value);
        if (!chosen) return;
        if (entry.id === 'gbp' && !entitySelect.value) {
          ctx.toast('Add a brand for this site before assigning a listing.');
          return;
        }
        try {
          await assignProviderResource(entry.id, {
            resourceId: chosen.id,
            resourceLabel: chosen.label,
            entityId: entry.id === 'gbp' ? entitySelect.value : undefined,
          });
          ctx.toast(`${chosen.label} assigned to this project.`);
          reload();
        } catch (err) {
          ctx.toast(`Could not assign: ${readableError(err)}`);
        }
      },
    }, [`Use this ${entry.resourceNoun}`]);

    pickerHost.replaceChildren(
      el('div', { class: 'form' }, [
        el('label', { class: 'flabel' }, [`${entry.resourceNoun[0].toUpperCase()}${entry.resourceNoun.slice(1)}`]),
        select,
        ...(entry.id === 'gbp'
          ? entityOptions.length > 0
            ? [el('label', { class: 'flabel' }, ['Which brand is this listing?']), entitySelect]
            : [
                el('div', { class: 'fq-note' }, [
                  'Add a brand for this site before assigning a listing — a location is a brand in Engine.',
                ]),
              ]
          : []),
        el('div', { class: 'form-actions' }, [assign]),
      ]),
    );
  };

  const pickButton = live
    ? el('button', { class: assignments.length === 0 ? 'btn primary' : 'btn', onclick: () => void loadPicker() }, [
        assignments.length === 0 ? `Choose a ${entry.resourceNoun}` : `Choose another ${entry.resourceNoun}`,
      ])
    : null;

  /* ── What is already assigned ─────────────────────────────────────────── */

  const assignmentRows = assignments.map((a) =>
    el('div', { class: 'intg-assign' }, [
      el('div', { class: 'intg-assign-main' }, [
        el('span', { class: 'intg-assign-label' }, [a.resourceLabel || a.resourceId]),
        el('span', { class: `num intg-status-line ${syncStatusLine(a).tone}` }, [syncStatusLine(a).text]),
      ]),
      syncButton(entry, ctx, reload),
      el('button', {
        class: 'btn',
        onclick: async () => {
          try {
            await unassignProviderResource(a.id);
            ctx.toast('Removed from this project.');
            reload();
          } catch (err) {
            ctx.toast(`Could not remove: ${readableError(err)}`);
          }
        },
      }, ['Remove']),
    ]),
  );

  const badges = providerBadges(entry);
  const connectedAs = connectedAsLabel(connection);

  return el('div', { class: 'intg-panel' }, [
    purpose,
    badges.length > 0 ? el('div', { class: 'intg-badges' }, badges) : null,

    elsewhereNote,
    // The primary action first, once, and only when it is the next step.
    !live && !isApiKey ? el('div', { class: 'intg-primary' }, [signIn]) : null,
    !live && isApiKey ? apiKeyForm({ ctx, accountId, entry, connected: false, reload }) : null,

    live && connectedAs
      ? el('div', { class: 'fhint num' }, [`Connected as ${connectedAs} · ${relativeTime(connection?.connectedAt)}`])
      : null,
    problem
      ? el('div', { class: 'intg-alert' }, [
          problem.line,
          infoCard(`Why ${entry.name} needs attention`, { title: problem.line, body: problem.detail }),
        ])
      : null,

    live
      ? el('div', { class: 'intg-section' }, [
          el('div', { class: 'flabel' }, ['This project reads from']),
          assignmentRows.length > 0
            ? el('div', { class: 'intg-assigns' }, assignmentRows)
            : el('div', { class: 'fhint num' }, [`No ${entry.resourceNoun} chosen for this project yet.`]),
          pickerHost,
        ])
      : null,

    live || connection?.status === 'needs_reauth'
      ? el('div', { class: 'form-actions' }, [
          pickButton,
          isApiKey ? null : signIn,
          disconnectButton,
        ].filter(Boolean) as HTMLElement[])
      : null,
    live && isApiKey
      ? el('details', { class: 'intg-replace' }, [
          el('summary', {}, [`Replace the ${entry.name} key`]),
          apiKeyForm({ ctx, accountId, entry, connected: true, reload }),
        ])
      : null,
    docs,
  ].filter(Boolean) as HTMLElement[]);
}

/** One tile in the gallery. The whole tile is the button that opens the panel. */
function providerTile(entry: ProviderCatalogEntry, state: { label: string; tone: 'good' | 'watch' | 'muted' | null }, onOpen: () => void): HTMLElement {
  return el('button', { class: `intg-tile${state.tone ? ` ${state.tone}` : ''}`, 'aria-haspopup': 'dialog', onclick: onOpen }, [
    el('div', { class: 'intg-tile-top' }, [
      logoTile(entry.logoDomain, entry.name),
      el('span', { class: 'intg-tile-name' }, [entry.name]),
      statusPill(state.label, state.tone),
    ]),
    el('div', { class: 'intg-tile-purpose' }, [entry.purpose]),
  ]);
}

/**
 * The gallery, plus the one open panel. Every action inside the panel calls
 * `reload`, which refetches and re-renders both the tiles and the panel's
 * content in place, so the dialog stays open across connect, choose, sync and
 * disconnect.
 */
export async function integrationsGallery(ctx: AppContext): Promise<HTMLElement> {
  // The client is the selected project's client, when a project is selected.
  // The stored client id can drift from the project (the branded report and
  // branding links set only the client), and a screen reading connections for
  // one client while showing another's project made a connected provider read
  // as disconnected. The project's client wins, and the stored id is healed.
  const projectState = await fetchProjectIntegrations().catch(() => null);
  const projectAccount = projectState?.account ?? null;
  if (projectAccount && projectAccount.id !== getAccountId()) setAccountId(projectAccount.id);
  const accountId = projectAccount?.id ?? getAccountId();
  const host = el('div', { class: 'intg-gallery' }, []);

  if (!accountId) {
    return el('section', { class: 'panel' }, [
      el('div', { class: 'fq-note' }, [
        'Choose a client first. Connections belong to a client, and every site of that client can use them.',
      ]),
      el('div', { class: 'intg-center' }, [
        el('button', { class: 'btn primary', onclick: () => ctx.navigate('clients') }, ['Go to Clients']),
      ]),
    ]);
  }

  let openId: ProviderId | null = null;
  let dialog: DialogHandle | null = null;

  const render = async () => {
    let catalog: ProviderCatalogEntry[];
    let connections: IntegrationConnection[];
    let vendorsConfigured: Record<string, boolean>;
    let assignments: IntegrationAssignment[];
    let isAdmin: boolean;
    let clientName: string | null = projectAccount?.name ?? null;
    let otherClients: { name: string; connectedProviders: ProviderId[] }[] = [];
    try {
      const [cat, connectionState, fresh, access, accounts] = await Promise.all([
        fetchProviderCatalog(true),
        fetchConnections(accountId),
        // A project may not be selected or reachable; assignments are then
        // simply unknown, which must not blank out the tiles.
        fetchProjectIntegrations().catch(() => ({ assignments: [] as IntegrationAssignment[], connections: [] })),
        fetchPlatformAccess().catch(() => ({ isAdmin: false })),
        // Every client this user belongs to, with what each has connected, so
        // a provider connected under another client is named as such.
        fetchAccounts().catch(() => []),
      ]);
      catalog = cat;
      connections = connectionState.connections;
      vendorsConfigured = connectionState.vendorsConfigured;
      assignments = fresh.assignments;
      isAdmin = access.isAdmin;
      clientName = clientName ?? accounts.find((a) => a.id === accountId)?.name ?? null;
      otherClients = accounts
        .filter((a) => a.id !== accountId)
        .map((a) => ({ name: a.name, connectedProviders: a.connectedProviders }));
    } catch (err) {
      host.replaceChildren(el('div', { class: 'fq-note' }, [readableError(err)]));
      return;
    }

    const byProvider = new Map<ProviderId, IntegrationConnection>(connections.map((c) => [c.provider, c]));

    /**
     * Whether Engine's own identity with this provider's vendor is
     * registered. Per vendor, so an unregistered GitHub App cannot make the
     * Google tiles read "not available yet", or the reverse.
     */
    const platformReadyFor = (entry: ProviderCatalogEntry): boolean =>
      vendorsConfigured[(entry.vendor ?? '').toLowerCase()] ?? false;

    const panelFor = (entry: ProviderCatalogEntry) =>
      providerPanel({
        ctx,
        accountId,
        entry,
        connection: byProvider.get(entry.id),
        assignments: assignments.filter((a) => a.provider === entry.id),
        platformReady: platformReadyFor(entry),
        isAdmin,
        reload: () => void render(),
        clientName,
        elsewhere: otherClients.filter((a) => a.connectedProviders.includes(entry.id)).map((a) => a.name),
      });

    const tiles = catalog
      .map((entry) => ({
        entry,
        state: integrationTileState(entry, byProvider.get(entry.id), {
          platformReady: platformReadyFor(entry),
          isAdmin,
        }),
      }))
      .sort((a, b) => a.state.sort - b.state.sort)
      .map(({ entry, state }) =>
        providerTile(entry, state, () => {
          openId = entry.id;
          dialog = openDialog({
            title: el('div', { class: 'intg-dialog-title' }, [
              logoTile(entry.logoDomain, entry.name),
              el('h2', { class: 'dialog-title' }, [entry.name]),
              statusPill(state.label, state.tone),
            ]),
            label: entry.name,
            content: panelFor(entry),
            onClose: () => {
              openId = null;
              dialog = null;
            },
          });
        }),
      );
    host.replaceChildren(
      el('div', { class: 'intg-scope' }, [
        'Connections for ',
        el('b', {}, [clientName ?? 'the selected client']),
        '. Every site of this client shares them; another client’s connections do not carry over.',
      ]),
      ...tiles,
    );

    // The panel that is open re-renders with the fresh state, so the customer
    // sees "Connected" and the property picker without closing and reopening.
    if (openId && dialog?.isOpen) {
      const entry = catalog.find((e) => e.id === openId);
      if (entry) dialog.setContent(panelFor(entry));
    }
  };

  host.replaceChildren(el('div', { class: 'fhint num' }, ['Loading…']));
  await render();
  return host;
}
