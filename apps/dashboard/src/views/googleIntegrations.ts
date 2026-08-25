import { el } from '../dom.js';
import {
  getAccountId,
  fetchProviderCatalog,
  fetchConnections,
  fetchConnectUrl,
  fetchProviderResources,
  disconnectProvider,
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
 * The screen where a customer connects their own Google accounts.
 *
 * The existing Integrations block (`views/integrations.ts`) reports whether
 * *we* have wired a vendor key — it reads `/health/integrations` and shows
 * "SERPER_API_KEY missing". That is an operator view, and it stays. This is a
 * different thing: the customer's own Google grant, which they create, assign,
 * and revoke themselves.
 *
 * Three states per provider, and they are genuinely distinct:
 *   - the deployment has no OAuth client, so nothing can be connected;
 *   - no Google account is connected yet;
 *   - connected, but Google revoked the grant, or the user unticked a scope.
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
    return 'Google revoked this grant. Reconnect to resume syncing.';
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

function providerCard(input: ProviderCardInput): HTMLElement {
  const { ctx, accountId, entry, connection, assignments, oauthConfigured, reload } = input;
  const live = connection?.status === 'connected';
  const problem = connection ? healthProblem(connection) : null;
  const state: IntegrationConnection['status'] | 'absent' = connection?.status ?? 'absent';

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
            const { revokedAtGoogle } = await disconnectProvider(accountId, entry.id);
            ctx.toast(
              revokedAtGoogle
                ? `${entry.name} disconnected and access revoked at Google.`
                : `${entry.name} disconnected. Google reported the grant was already gone.`,
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
      el('h3', {}, [entry.name]),
      el('span', { class: `intg-status ${state === 'connected' && connection?.scopesSufficient ? 'configured' : state === 'absent' ? 'missing' : 'partial'}` }, [
        connection ? STATUS_LABEL[connection.status] : 'Not connected',
      ]),
    ]),
    el('div', { class: 'intg-body' }, [
      el('p', { class: 'intg-purpose' }, [entry.purpose]),

      connection?.googleEmail
        ? el('div', { class: 'fhint num' }, [`Connected as ${connection.googleEmail} · ${relativeTime(connection.connectedAt)}`])
        : null,

      problem ? el('div', { class: 'fq-note warn' }, [problem]) : null,

      !oauthConfigured
        ? el('div', { class: 'fq-note' }, [
            'This deployment has no Google OAuth client configured, so nothing can be connected yet. An administrator needs to set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI.',
          ])
        : null,

      // Stated up front rather than discovered as a 403 later.
      entry.requiresAccessRequest
        ? el('div', { class: 'fq-note' }, [
            'Google grants this API zero quota until it approves an access request, which takes weeks. Connecting will succeed before that; reads will not.',
          ])
        : null,

      entry.writes
        ? el('div', { class: 'fhint num' }, [
            'Google offers no read-only scope here, so connecting grants write access. Nothing is written until you approve a fix in the Fix Queue.',
          ])
        : null,

      assignmentRows.length > 0
        ? el('div', { class: 'intg-assigns' }, assignmentRows)
        : live
          ? el('div', { class: 'fhint num' }, [`No ${entry.resourceNoun} assigned to this project yet.`])
          : null,

      pickerHost,

      el('div', { class: 'form-actions' }, [connectButton, pickButton, disconnectButton].filter(Boolean) as HTMLElement[]),
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
