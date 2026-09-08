import { el } from '../dom.js';
import { logoTile } from '../logo.js';
import {
  getAccountId,
  fetchProviderCatalog,
  fetchConnections,
  fetchConnectUrl,
  fetchProviderResources,
  disconnectProvider,
  connectApiKey,
  fetchProjectIntegrations,
  assignProviderResource,
  unassignProviderResource,
  syncProvider,
} from '../api.js';
import type { AppContext } from '../context.js';
import type {
  GoogleProviderId,
  ProviderCatalogEntry,
  IntegrationConnection,
  IntegrationAssignment,
  ProviderResource,
} from '../types.js';

/**
 * The screen where a customer connects their own accounts.
 *
 * The existing Integrations block (`views/integrations.ts`) reports whether
 * *we* have wired a vendor key — it reads `/health/integrations` and shows
 * "SERPER_API_KEY missing". That is an operator view, and it stays. This is a
 * different thing: the customer's own grant, which they create, assign, and
 * revoke themselves.
 *
 * Two ways in, because the registry now has both. An OAuth provider opens a
 * consent popup; an API-key provider shows a form. They share the card, the
 * status vocabulary and the resource picker — only the connect control differs,
 * which is the whole point of the registry carrying `authKind`.
 *
 * Three states per provider, and they are genuinely distinct:
 *   - the deployment has no OAuth client, so nothing can be connected;
 *   - no account is connected yet;
 *   - connected, but the vendor revoked the grant, or the user unticked a scope.
 * Collapsing any pair of them produces a screen that says "not connected" when
 * the real answer is "reconnect" or "ask your administrator".
 */

const STATUS_LABEL: Record<IntegrationConnection['status'], string> = {
  connected: 'Connected',
  needs_reauth: 'Reconnect needed',
  revoked: 'Disconnected',
};

/** A short, plain description of what is wrong, or null when nothing is. */
function healthProblem(connection: IntegrationConnection): string | null {
  if (connection.status === 'needs_reauth') {
    return 'The provider revoked this grant. Reconnect to resume syncing.';
  }
  if (connection.status === 'connected' && !connection.scopesSufficient) {
    return 'Connected without the permission this needs — reconnect and accept all requested access.';
  }
  return null;
}

/**
 * A message worth showing a person.
 *
 * `request` throws `"<status> <raw body>"`, so an unhandled error renders the
 * API's JSON straight into the page — which is both ugly and leaks internals.
 * This pulls out the `error` field the API always sends, and names the two
 * statuses that mean something specific here rather than repeating a number.
 */
function readableError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const match = /^(\d{3})\s+([\s\S]*)$/.exec(raw);
  if (!match) return raw;
  const [, status, body] = match;
  let detail = body.trim();
  try {
    const parsed = JSON.parse(detail) as { error?: string };
    if (parsed.error) detail = parsed.error;
  } catch {
    /* not JSON — show the body as-is */
  }
  if (status === '403') return `${detail}. Pick the right client from the Clients grid.`;
  if (status === '404') return `${detail}.`;
  if (status === '503') return detail;
  return detail || `Request failed (${status}).`;
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

interface ProviderCardInput {
  ctx: AppContext;
  accountId: string;
  entry: ProviderCatalogEntry;
  connection: IntegrationConnection | undefined;
  assignments: IntegrationAssignment[];
  oauthConfigured: boolean;
  reload: () => void;
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
        try {
          await connectApiKey(accountId, entry.id, values);
          // Cleared on success as well as being unstored: a key left in a DOM
          // node is still a key on the page.
          for (const control of inputs.values()) control.value = '';
          ctx.toast(`${entry.name} connected.`);
          reload();
        } catch (err) {
          ctx.toast(`Could not connect: ${readableError(err)}`);
        }
      },
    },
    [connected ? `Replace ${entry.name} key` : `Connect ${entry.name}`],
  );

  return el('div', { class: 'intg-apikey' }, [
    ...rows,
    el('div', { class: 'form-actions' }, [submit]),
  ]);
}

function providerCard(input: ProviderCardInput): HTMLElement {
  const { ctx, accountId, entry, connection, assignments, oauthConfigured, reload } = input;
  const live = connection?.status === 'connected';
  const problem = connection ? healthProblem(connection) : null;
  const state: IntegrationConnection['status'] | 'absent' = connection?.status ?? 'absent';

  // An API-key provider has no consent screen, so the OAuth button would be
  // both useless and misleading. `authKind` from the registry is what decides.
  const isApiKey = entry.authKind === 'api_key';

  const connectButton = el('button', {
    class: live ? 'btn' : 'btn primary',
    // Spread rather than `disabled: undefined` — the `el` helper writes every
    // attribute it is given, so an undefined value would render disabled="".
    ...(oauthConfigured ? {} : { disabled: 'true' }),
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
  }, [live || state === 'needs_reauth' ? 'Reconnect' : `Connect ${entry.name}`]);

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
          `This Google account can see no ${entry.resourceNoun}s. Check you connected the account that owns them.`,
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
              el('div', { class: 'fhint num' }, ['A location is an entity in Engine. Paste the entity id this listing maps to.']),
            ]
          : []),
        el('div', { class: 'form-actions' }, [assign]),
      ]),
    );
  };

  const pickButton = live
    ? el('button', { class: 'btn', onclick: () => void loadPicker() }, [`Choose ${entry.resourceNoun}`])
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

  return el('section', { class: `panel intg-provider ${state}` }, [
    el('header', {}, [
      logoTile(entry.logoDomain, entry.name),
      el('h3', {}, [entry.name]),
      el('span', { class: `intg-status ${state === 'connected' && connection?.scopesSufficient ? 'configured' : state === 'absent' ? 'missing' : 'partial'}` }, [
        connection ? STATUS_LABEL[connection.status] : 'Not connected',
      ]),
    ]),
    el('div', { class: 'intg-body' }, [
      el('p', { class: 'intg-purpose' }, [entry.purpose]),

      connection && connectedAsLabel(connection)
        ? el('div', { class: 'fhint num' }, [
            `Connected as ${connectedAsLabel(connection)} · ${relativeTime(connection.connectedAt)}`,
          ])
        : null,

      problem ? el('div', { class: 'fq-note warn' }, [problem]) : null,

      // Only an OAuth provider is blocked by a missing OAuth client. Showing
      // this on an API-key card would tell a customer to go and ask an
      // administrator for something that has no bearing on what they are doing.
      !oauthConfigured && !isApiKey
        ? el('div', { class: 'fq-note' }, [
            'This deployment has no Google OAuth client configured, so nothing can be connected yet. An administrator needs to set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI.',
          ])
        : null,

      entry.availability === 'planned'
        ? el('div', { class: 'fq-note' }, ['Coming soon. This provider cannot be connected yet.'])
        : null,

      // Stated up front rather than discovered as a 403 later.
      entry.requiresAccessRequest
        ? el('div', { class: 'fq-note' }, [
            'The provider grants this API zero quota until it approves an access request, which takes weeks. Connecting will succeed before that; reads will not.',
          ])
        : null,

      entry.writes
        ? el('div', { class: 'fhint num' }, [
            'Connecting grants write access — the provider offers no read-only equivalent. Nothing is written until you approve a fix in the Fix Queue.',
          ])
        : null,

      // Setup the customer must do at the vendor first. Each one otherwise
      // arrives as a 403 that does not explain itself.
      (entry.setupSteps ?? entry.requiredApis ?? []).length > 0
        ? el('ul', { class: 'intg-setup' }, (entry.setupSteps ?? entry.requiredApis).map((step) =>
            el('li', {}, [step]),
          ))
        : null,

      assignmentRows.length > 0
        ? el('div', { class: 'intg-assigns' }, assignmentRows)
        : live
          ? el('div', { class: 'fhint num' }, [`No ${entry.resourceNoun} assigned to this project yet.`])
          : null,

      pickerHost,

      isApiKey && entry.availability !== 'planned'
        ? apiKeyForm({ ctx, accountId, entry, connected: Boolean(live), reload })
        : null,

      el(
        'div',
        { class: 'form-actions' },
        [isApiKey ? null : connectButton, pickButton, disconnectButton].filter(Boolean) as HTMLElement[],
      ),
    ].filter(Boolean) as HTMLElement[]),
  ]);
}

/**
 * The whole Google-integrations block, embedded in Settings.
 *
 * Needs an account (the credential is account-scoped) and a project (the
 * assignment is project-scoped), so it says which one is missing rather than
 * rendering an empty shell.
 */
export async function googleIntegrationsSection(ctx: AppContext): Promise<HTMLElement> {
  const accountId = getAccountId();
  const host = el('div', { class: 'intg-providers' }, []);

  if (!accountId) {
    return el('section', { class: 'panel' }, [
      el('header', {}, [el('h3', {}, ['Google integrations'])]),
      el('div', { class: 'fq-note' }, [
        'Pick a client from the Clients grid first — a Google connection belongs to an account.',
      ]),
    ]);
  }

  const render = async () => {
    host.replaceChildren(el('div', { class: 'fhint num' }, ['Loading…']));
    try {
      const [catalog, connectionState, projectState] = await Promise.all([
        fetchProviderCatalog(),
        fetchConnections(accountId),
        // A project may not be selected or reachable; assignments are then
        // simply unknown, which must not blank out the connect buttons.
        fetchProjectIntegrations().catch(() => ({ assignments: [] as IntegrationAssignment[], connections: [] })),
      ]);

      const byProvider = new Map<GoogleProviderId, IntegrationConnection>(
        connectionState.connections.map((c) => [c.provider, c]),
      );

      host.replaceChildren(
        ...catalog.map((entry) =>
          providerCard({
            ctx,
            accountId,
            entry,
            connection: byProvider.get(entry.id),
            assignments: projectState.assignments.filter((a) => a.provider === entry.id),
            oauthConfigured: connectionState.oauthConfigured,
            reload: () => void render(),
          }),
        ),
      );
    } catch (err) {
      host.replaceChildren(
        el('div', { class: 'fq-note' }, [readableError(err)]),
      );
    }
  };

  await render();
  return host;
}
