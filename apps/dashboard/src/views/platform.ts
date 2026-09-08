/**
 * Engine's own OAuth client, configured in the product.
 *
 * Not a customer screen. Registering Engine's Google app is a one-time
 * operator task — every customer consents to that same app, exactly as they
 * would with Zapier or HubSpot — and until now it lived in five `wrangler
 * secret put` commands. That made the Integrations screen impossible to use
 * for anyone without Cloudflare access, and it made the product look broken
 * rather than unconfigured.
 *
 * The section renders only for an account on `PLATFORM_ADMIN_EMAILS`. The API
 * answers 404 to everyone else, so hiding it here is presentation, not
 * security.
 */
import { el } from '../dom.js';
import { infoCard } from '../hovercard.js';
import { logoTile } from '../logo.js';
import {
  fetchPlatformAccess,
  fetchPlatformClient,
  savePlatformClient,
  clearPlatformClient,
  fetchPlatformUsers,
  setUserRole,
} from '../api.js';
import { readableError } from '../errors.js';
import type { AppContext } from '../context.js';
import type { PlatformClientView, PlatformUser } from '../types.js';

/** Copy-to-clipboard for the one value a vendor compares byte for byte. */
function copyableUri(uri: string, ctx: AppContext): HTMLElement {
  return el('div', { class: 'copyfield' }, [
    el('code', {}, [uri]),
    el('button', {
      class: 'btn',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(uri);
          ctx.toast('Redirect URI copied.');
        } catch {
          // Clipboard access can be refused outright. The value is on screen
          // and selectable, so this is a convenience failing, not the task.
          ctx.toast('Could not copy — select the text instead.');
        }
      },
    }, ['Copy']),
  ]);
}

function statusLine(view: PlatformClientView): HTMLElement {
  if (view.client) {
    return el('div', { class: 'intg-alert ok' }, [
      `Configured · ${view.client.clientId}`,
      infoCard('About this OAuth client', {
        title: 'Engine’s Google app',
        body: [
          'Every customer consents to this one client. Replacing it does not disconnect anyone, but a client that no longer exists at Google will fail every refresh.',
          `Last changed ${new Date(view.client.updatedAt).toLocaleString()}.`,
        ],
      }),
    ]);
  }
  if (view.configuredByEnvironment) {
    return el('div', { class: 'intg-alert' }, [
      'Configured by environment variable',
      infoCard('Where this client comes from', {
        title: 'Set outside the product',
        body: [
          'This deployment still supplies GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI as Worker configuration. That keeps working.',
          'Saving a client here takes precedence over it, and means the values no longer have to live in Cloudflare.',
        ],
      }),
    ]);
  }
  return el('div', { class: 'intg-alert' }, [
    'Not configured — customers cannot connect Google',
    infoCard('What this blocks', {
      title: 'Nothing can be connected yet',
      body: ['Until this is set, every Connect button on the Integrations screen stays disabled for every customer.'],
    }),
  ]);
}

function clientForm(view: PlatformClientView, ctx: AppContext, reload: () => void): HTMLElement {
  const clientId = el('input', {
    class: 'field',
    type: 'text',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: '1234567890-abcdefg.apps.googleusercontent.com',
    value: view.client?.clientId ?? '',
  }) as HTMLInputElement;

  // Never prefilled, even when one is stored. The API cannot return it, and a
  // masked placeholder that submits blank is how a secret gets silently
  // cleared on an unrelated edit.
  const clientSecret = el('input', {
    class: 'field',
    type: 'password',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: view.client ? 'Enter to replace the stored secret' : 'GOCSPX-…',
  }) as HTMLInputElement;

  const redirectUri = el('input', {
    class: 'field',
    type: 'text',
    autocomplete: 'off',
    spellcheck: 'false',
    value: view.client?.redirectUri ?? view.suggestedRedirectUri,
  }) as HTMLInputElement;

  const save = el('button', {
    class: 'btn primary',
    onclick: async () => {
      const id = clientId.value.trim();
      const secret = clientSecret.value.trim();
      const uri = redirectUri.value.trim();
      if (!id) return ctx.toast('Client ID is required.');
      if (!secret) return ctx.toast('Client secret is required.');
      if (!/^https:\/\//.test(uri)) return ctx.toast('Redirect URI must be an https URL.');
      try {
        await savePlatformClient('google', { clientId: id, clientSecret: secret, redirectUri: uri });
        // Cleared on success: a secret left in a DOM node is still on the page.
        clientSecret.value = '';
        ctx.toast('Google client saved. Customers can connect now.');
        reload();
      } catch (err) {
        ctx.toast(`Could not save: ${readableError(err)}`);
      }
    },
  }, [view.client ? 'Replace client' : 'Save client']);

  const remove = view.client
    ? el('button', {
        class: 'btn',
        onclick: async () => {
          if (!window.confirm('Remove Engine’s Google client? No customer will be able to connect or refresh until it is set again.')) return;
          try {
            await clearPlatformClient('google');
            ctx.toast('Google client removed.');
            reload();
          } catch (err) {
            ctx.toast(`Could not remove: ${readableError(err)}`);
          }
        },
      }, ['Remove'])
    : null;

  return el('div', { class: 'intg-apikey' }, [
    el('div', { class: 'form-row' }, [
      el('label', { class: 'label' }, ['Client ID']),
      clientId,
    ]),
    el('div', { class: 'form-row' }, [
      el('label', { class: 'label' }, ['Client secret', el('span', { class: 'tagband' }, ['secret'])]),
      clientSecret,
    ]),
    el('div', { class: 'form-row' }, [
      el('label', { class: 'label' }, [
        'Redirect URI',
        infoCard('Where this value goes', {
          title: 'Register this with Google',
          body: [
            'Paste this into Authorised redirect URIs on the OAuth client in Google Cloud Console.',
            'Google compares it byte for byte. A mismatch is the most common setup failure and shows as redirect_uri_mismatch at consent time.',
          ],
        }),
      ]),
      redirectUri,
      copyableUri(view.client?.redirectUri ?? view.suggestedRedirectUri, ctx),
    ]),
    el('div', { class: 'form-actions' }, [save, remove].filter(Boolean) as HTMLElement[]),
  ]);
}


/* ── Users ───────────────────────────────────────────────────────────────── */

/**
 * Who can sign in, and which of them work on Engine.
 *
 * Two roles, and the split is narrower than it sounds. A **user** is a
 * customer: their own accounts and projects, nothing else. An **admin** works
 * on Engine and additionally sees this screen, the OAuth client above, and the
 * platform readiness report.
 *
 * What an admin deliberately does *not* get is other customers' data. Every
 * project screen still goes through account membership, for admins and users
 * alike. Support access is a separate decision that needs a recorded reason
 * per access, not a role flag.
 */
function userRow(u: PlatformUser, selfIsOnly: boolean, ctx: AppContext, reload: () => void): HTMLElement {
  const isAdmin = u.platformRole === 'admin';
  const toggle = el('button', {
    class: 'btn',
    onclick: async () => {
      const next = isAdmin ? 'user' : 'admin';
      if (
        next === 'admin' &&
        !window.confirm(`Make ${u.email ?? u.id} a platform admin? They will be able to replace Engine’s OAuth client and create further admins.`)
      ) {
        return;
      }
      try {
        await setUserRole(u.id, next);
        ctx.toast(`${u.email ?? u.id} is now a platform ${next}.`);
        reload();
      } catch (err) {
        ctx.toast(readableError(err));
      }
    },
  }, [isAdmin ? 'Make user' : 'Make admin']);

  return el('div', { class: 'intg-assign' }, [
    el('div', { class: 'intg-assign-main' }, [
      el('div', { class: 'intg-assign-label' }, [u.email ?? u.id]),
      el('div', { class: 'num' }, [
        u.name ? `${u.name} · ` : '',
        isAdmin ? 'admin' : 'user',
        u.hasCredential ? '' : ' · no password set',
      ]),
    ]),
    // The last admin cannot be demoted and neither can you demote yourself;
    // the API refuses both. Hiding the control on the only-admin row saves a
    // click that can only fail.
    isAdmin && selfIsOnly ? el('span', { class: 'num' }, ['only admin']) : toggle,
  ]);
}

async function usersPanel(ctx: AppContext): Promise<HTMLElement> {
  const host = el('div', {}, []);
  const render = async () => {
    host.replaceChildren(el('div', { class: 'fhint num' }, ['Loading…']));
    let data: { users: PlatformUser[]; adminCount: number };
    try {
      data = await fetchPlatformUsers();
    } catch (err) {
      host.replaceChildren(el('div', { class: 'fq-note' }, [readableError(err)]));
      return;
    }
    host.replaceChildren(
      el('section', { class: 'panel' }, [
        el('header', {}, [
          el('h3', {}, ['Users']),
          infoCard('What the two roles mean', {
            title: 'Admin and user',
            body: [
              'A user is a customer: their own accounts and projects, nothing else.',
              'An admin also sees this screen, Engine’s OAuth client, and the platform readiness report.',
              'An admin does not get access to other customers’ data. Every project screen still checks account membership.',
            ],
          }),
          el('span', { class: 'more' }, [`${data.adminCount} admin${data.adminCount === 1 ? '' : 's'}`]),
        ]),
        el('div', { class: 'intg-body' }, [
          el('div', { class: 'intg-assigns' }, data.users.map((u) =>
            userRow(u, data.adminCount <= 1, ctx, () => void render()),
          )),
          el('div', { class: 'fhint num' }, [
            'New sign-in accounts are created with `pnpm db:user --email <address> --role admin|user`.',
          ]),
        ]),
      ]),
    );
  };
  await render();
  return host;
}

/**
 * The Platform section, or nothing.
 *
 * Returns an empty node for a non-admin rather than a "you do not have access"
 * panel: a customer has no reason to learn that an operator screen exists.
 */
export async function platformSection(ctx: AppContext): Promise<HTMLElement> {
  const host = el('div', {}, []);

  let isAdmin = false;
  try {
    isAdmin = (await fetchPlatformAccess()).isAdmin;
  } catch {
    // An unreachable API is reported by the screens that need data. This one
    // simply does not render.
    return host;
  }
  if (!isAdmin) return host;

  const render = async () => {
    host.replaceChildren(el('div', { class: 'fhint num' }, ['Loading…']));
    let view: PlatformClientView;
    try {
      view = await fetchPlatformClient('google');
    } catch (err) {
      host.replaceChildren(el('div', { class: 'fq-note' }, [readableError(err)]));
      return;
    }
    host.replaceChildren(
      el('div', { class: 'settings-sec' }, ['Platform']),
      el('section', { class: 'panel' }, [
        el('header', {}, [
          logoTile('google.com', 'Google'),
          el('h3', {}, ['Google OAuth client']),
          infoCard('Who this is for', {
            title: 'Engine’s app, not a customer’s',
            body: [
              'This identifies Engine to Google. Customers consent to it; they never create one of their own.',
              'Set it once. Everything a customer connects — Search Console, Analytics, Business Profile — goes through it.',
            ],
          }),
        ]),
        el('div', { class: 'intg-body' }, [
          statusLine(view),
          clientForm(view, ctx, () => void render()),
          view.events.length > 0
            ? el('div', { class: 'fhint num' }, [
                `Last change: ${view.events[0].type} by ${view.events[0].actor} · ${new Date(
                  view.events[0].occurredAt,
                ).toLocaleString()}`,
              ])
            : null,
        ].filter(Boolean) as HTMLElement[]),
      ]),
      await usersPanel(ctx),
    );
  };

  await render();
  return host;
}
