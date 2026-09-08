import { el } from '../dom.js';
import { logoTile } from '../logo.js';
import { infoCard, type HoverCardContent } from '../hovercard.js';
import { openDialog, type DialogHandle } from '../dialog.js';
import { readableError } from '../errors.js';
import { integrationTileState } from '../format.js';
import {
  getAccountId,
  fetchProviderCatalog,
  fetchConnections,
  fetchConnectUrl,
  fetchProviderResources,
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

function relativeTime(iso: string | undefined): string {
  if (!iso) return 'never';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'never';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 90) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
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
  oauthConfigured: boolean;
  isAdmin: boolean;
  reload: () => void;
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
function providerPanel(input: ProviderPanelInput): HTMLElement {
  const { ctx, accountId, entry, connection, assignments, oauthConfigured, isAdmin, reload } = input;
  const live = connection?.status === 'connected';
  const problem = connection ? healthProblem(connection) : null;
  const isApiKey = entry.authKind === 'api_key';
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

  if (!isApiKey && !oauthConfigured && !live) {
    return el('div', { class: 'intg-panel' }, [
      purpose,
      el('div', { class: 'intg-note warn' }, [
        isAdmin
          ? `Sign-in with ${vendor} is not set up for this workspace yet. Register Engine's ${vendor} app once under Settings, and every client can connect from here.`
          : `Sign-in with ${vendor} is not set up for this workspace yet. Ask your administrator to finish the setup.`,
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
  }, [live || connection?.status === 'needs_reauth' ? `Reconnect ${vendor}` : `Sign in with ${vendor}`]);

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
    // field. Asking for a uuid is not a finished experience, but inventing a
    // location entity on the user's behalf would be worse — it would create rows
    // in their graph as a side effect of connecting an integration.
    const entityInput = el('input', {
      class: 'field',
      type: 'text',
      placeholder: 'location entity id (uuid)',
    }) as HTMLInputElement;

    const assign = el('button', {
      class: 'btn primary',
      onclick: async () => {
        const chosen = resources.find((r) => r.id === select.value);
        if (!chosen) return;
        try {
          await assignProviderResource(entry.id, {
            resourceId: chosen.id,
            resourceLabel: chosen.label,
            entityId: entry.id === 'gbp' ? entityInput.value.trim() : undefined,
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
          ? [
              el('label', { class: 'flabel' }, ['Location entity']),
              entityInput,
              infoCard('What an entity id is', {
                title: 'A location is an entity in Engine',
                body: ['Paste the id of the entity this listing maps to. Entities are managed on the Entities screen.'],
              }),
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
        el('span', { class: 'num' }, [
          a.lastSyncError
            ? `sync failed: ${a.lastSyncError}`
            : `synced ${relativeTime(a.lastSyncedAt)}${a.lastSyncRows !== undefined && a.lastSyncRows !== null ? ` · ${a.lastSyncRows} rows` : ''}`,
        ]),
      ]),
      el('button', {
        class: 'btn',
        onclick: async () => {
          try {
            await syncProvider(entry.id);
            ctx.toast(`${entry.name} sync finished.`);
            reload();
          } catch (err) {
            ctx.toast(`Sync failed: ${readableError(err)}`);
          }
        },
      }, ['Sync now']),
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
  const accountId = getAccountId();
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
    let oauthConfigured: boolean;
    let assignments: IntegrationAssignment[];
    let isAdmin: boolean;
    try {
      const [cat, connectionState, projectState, access] = await Promise.all([
        fetchProviderCatalog(true),
        fetchConnections(accountId),
        // A project may not be selected or reachable; assignments are then
        // simply unknown, which must not blank out the tiles.
        fetchProjectIntegrations().catch(() => ({ assignments: [] as IntegrationAssignment[], connections: [] })),
        fetchPlatformAccess().catch(() => ({ isAdmin: false })),
      ]);
      catalog = cat;
      connections = connectionState.connections;
      oauthConfigured = connectionState.oauthConfigured;
      assignments = projectState.assignments;
      isAdmin = access.isAdmin;
    } catch (err) {
      host.replaceChildren(el('div', { class: 'fq-note' }, [readableError(err)]));
      return;
    }

    const byProvider = new Map<ProviderId, IntegrationConnection>(connections.map((c) => [c.provider, c]));
    const panelFor = (entry: ProviderCatalogEntry) =>
      providerPanel({
        ctx,
        accountId,
        entry,
        connection: byProvider.get(entry.id),
        assignments: assignments.filter((a) => a.provider === entry.id),
        oauthConfigured,
        isAdmin,
        reload: () => void render(),
      });

    const tiles = catalog
      .map((entry) => ({ entry, state: integrationTileState(entry, byProvider.get(entry.id), { oauthConfigured, isAdmin }) }))
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
    host.replaceChildren(...tiles);

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
