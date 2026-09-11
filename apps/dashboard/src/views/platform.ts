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
  fetchIntegrations,
  fetchPlatformAccess,
  fetchPlatformClient,
  savePlatformClient,
  clearPlatformClient,
  fetchPlatformUsers,
  setUserRole,
  fetchPlatformCadences,
  setAccountCadence,
  fetchQueueHealth,
} from '../api.js';
import { operatorChecklist, screenName } from '../format.js';
import { readableError } from '../errors.js';
import { vendorKeysPanel } from './integrations.js';
import type { AppContext } from '../context.js';
import type { PlatformClientView, PlatformUser, AccountCadenceRow, CadenceOverride } from '../types.js';
import { CADENCE_LABELS } from './settings.js';

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

function statusLine(form: VendorForm, view: PlatformClientView): HTMLElement {
  if (view.client) {
    return el('div', { class: 'intg-alert ok' }, [
      `Configured · ${view.client.clientId}`,
      infoCard(`About this ${form.name} app`, {
        title: `Engine’s ${form.name} app`,
        body: [
          `Every customer uses this one registration. Replacing it does not disconnect anyone, but one that no longer exists at ${form.name} will fail for everybody.`,
          `Last changed ${new Date(view.client.updatedAt).toLocaleString()}.`,
        ],
      }),
    ]);
  }
  if (view.configuredByEnvironment && form.envNote) {
    return el('div', { class: 'intg-alert' }, [
      'Configured by environment variable',
      infoCard('Where this comes from', {
        title: 'Set outside the product',
        body: [
          form.envNote,
          'Saving here takes precedence over it, and means the values no longer have to live in Cloudflare.',
        ],
      }),
    ]);
  }
  return el('div', { class: 'intg-alert' }, [
    `Not configured — customers cannot connect ${form.name}`,
    infoCard('What this blocks', {
      title: 'Nothing can be connected yet',
      body: [form.blocks],
    }),
  ]);
}


/**
 * What differs between the identities Engine registers, as data.
 *
 * Google's is an OAuth client (an id and a short secret); GitHub's is an App
 * (a numeric id and a multi-line private key). The form, the status line and
 * the panel are otherwise identical, so they take one of these rather than
 * being written twice — the second copy is where the two drift.
 */
interface VendorForm {
  vendor: 'google' | 'github';
  /** Display name, and the noun in every sentence on the panel. */
  name: string;
  logoDomain: string;
  panelTitle: string;
  idLabel: string;
  idPlaceholder: string;
  secretLabel: string;
  secretPlaceholder: string;
  /** A PEM does not fit one line. */
  secretMultiline: boolean;
  redirectLabel: string;
  redirectHelp: { title: string; body: string[] };
  whoFor: { title: string; body: string[] };
  /** What is blocked while this is unset. */
  blocks: string;
  envNote?: string;
}

const GOOGLE_FORM: VendorForm = {
  vendor: 'google',
  name: 'Google',
  logoDomain: 'google.com',
  panelTitle: 'Google OAuth client',
  idLabel: 'Client ID',
  idPlaceholder: '1234567890-abcdefg.apps.googleusercontent.com',
  secretLabel: 'Client secret',
  secretPlaceholder: 'GOCSPX-…',
  secretMultiline: false,
  redirectLabel: 'Redirect URI',
  redirectHelp: {
    title: 'Register this with Google',
    body: [
      'Paste this into Authorised redirect URIs on the OAuth client in Google Cloud Console.',
      'Google compares it byte for byte. A mismatch is the most common setup failure and shows as redirect_uri_mismatch at consent time.',
    ],
  },
  whoFor: {
    title: 'Engine’s app, not a customer’s',
    body: [
      'This identifies Engine to Google. Customers consent to it; they never create one of their own.',
      'Set it once. Everything a customer connects — Search Console, Analytics, Business Profile — goes through it.',
    ],
  },
  blocks: 'Until this is set, every Connect button on the Integrations screen stays disabled for every customer.',
  envNote:
    'This deployment still supplies GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI as Worker configuration. That keeps working.',
};

const GITHUB_FORM: VendorForm = {
  vendor: 'github',
  name: 'GitHub',
  logoDomain: 'github.com',
  panelTitle: 'GitHub App',
  idLabel: 'App ID',
  idPlaceholder: '1234567',
  secretLabel: 'Private key',
  secretPlaceholder: '-----BEGIN RSA PRIVATE KEY-----\n…',
  // GitHub's download gives a multi-line PEM. Engine accepts it as downloaded,
  // in either PKCS#1 or PKCS#8 form, so nobody has to run openssl first.
  secretMultiline: true,
  redirectLabel: 'Setup callback URL',
  redirectHelp: {
    title: 'Register this with GitHub',
    body: [
      'Paste this into "Setup URL" on the App’s settings page, and tick "Redirect on update".',
      'It is where GitHub returns a customer after they choose which repositories Engine may open pull requests in.',
    ],
  },
  whoFor: {
    title: 'One App for every customer',
    body: [
      'This identifies Engine to GitHub. Each customer installs it on the repositories they choose; nobody hands over a personal token.',
      'The App needs two permissions: Contents (read and write) and Pull requests (read and write).',
    ],
  },
  blocks: 'Until this is set, no customer can connect GitHub, and approved fixes cannot be opened as pull requests.',
};

function clientForm(form: VendorForm, view: PlatformClientView, ctx: AppContext, reload: () => void): HTMLElement {
  const clientId = el('input', {
    class: 'field',
    type: 'text',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: form.idPlaceholder,
    value: view.client?.clientId ?? '',
  }) as HTMLInputElement;

  // Never prefilled, even when one is stored. The API cannot return it, and a
  // masked placeholder that submits blank is how a secret gets silently
  // cleared on an unrelated edit.
  const clientSecret = (
    form.secretMultiline
      ? el('textarea', {
          class: 'field platform-pem',
          rows: '6',
          autocomplete: 'off',
          spellcheck: 'false',
          placeholder: view.client ? 'Paste to replace the stored key' : form.secretPlaceholder,
        })
      : el('input', {
          class: 'field',
          type: 'password',
          autocomplete: 'off',
          spellcheck: 'false',
          placeholder: view.client ? 'Enter to replace the stored secret' : form.secretPlaceholder,
        })
  ) as HTMLInputElement | HTMLTextAreaElement;

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
      if (!id) return ctx.toast(`${form.idLabel} is required.`);
      if (!secret) return ctx.toast(`${form.secretLabel} is required.`);
      if (!/^https:\/\//.test(uri)) return ctx.toast(`${form.redirectLabel} must be an https URL.`);
      try {
        await savePlatformClient(form.vendor, { clientId: id, clientSecret: secret, redirectUri: uri });
        // Cleared on success: a secret left in a DOM node is still on the page.
        clientSecret.value = '';
        ctx.toast(`${form.name} saved. Customers can connect now.`);
        reload();
      } catch (err) {
        ctx.toast(`Could not save: ${readableError(err)}`);
      }
    },
  }, [view.client ? `Replace ${form.name === 'GitHub' ? 'App' : 'client'}` : `Save ${form.name === 'GitHub' ? 'App' : 'client'}`]);

  const remove = view.client
    ? el('button', {
        class: 'btn',
        onclick: async () => {
          if (!window.confirm(`Remove Engine’s ${form.name} credentials? No customer will be able to connect until they are set again.`)) return;
          try {
            await clearPlatformClient(form.vendor);
            ctx.toast(`${form.name} credentials removed.`);
            reload();
          } catch (err) {
            ctx.toast(`Could not remove: ${readableError(err)}`);
          }
        },
      }, ['Remove'])
    : null;

  return el('div', { class: 'intg-apikey' }, [
    el('div', { class: 'form-row' }, [
      el('label', { class: 'label' }, [form.idLabel]),
      clientId,
    ]),
    el('div', { class: 'form-row' }, [
      el('label', { class: 'label' }, [form.secretLabel, el('span', { class: 'tagband' }, ['secret'])]),
      clientSecret,
    ]),
    el('div', { class: 'form-row' }, [
      el('label', { class: 'label' }, [
        form.redirectLabel,
        infoCard('Where this value goes', form.redirectHelp),
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

/**
 * Per-account cadence overrides (issue 10). Each account shows its effective
 * rhythm; "Plan default" follows the tier, anything else pins it. Changing a
 * select saves at once and repaints from the API's answer.
 */
async function cadencePanel(ctx: AppContext): Promise<HTMLElement> {
  const host = el('div', {}, []);
  const FIELDS: { key: keyof CadenceOverride; label: string; options: string[] }[] = [
    { key: 'rankPoll', label: 'Rank poll', options: ['daily', 'weekly'] },
    { key: 'aiPoll', label: 'AI answer poll', options: ['weekly', 'monthly'] },
    { key: 'crawl', label: 'Site crawl', options: ['weekly', 'monthly', 'on_demand'] },
  ];

  const accountRow = (a: AccountCadenceRow, reload: () => void): HTMLElement => {
    const selects = FIELDS.map((f) => {
      const current = a.override?.[f.key] ?? '';
      const sel = el('select', { class: 'ci-select', title: f.label }, [
        el('option', { value: '' }, [`${f.label}: plan default (${CADENCE_LABELS[a.effective.policy[f.key]] ?? a.effective.policy[f.key]})`]),
        ...f.options.map((o) => el('option', { value: o }, [`${f.label}: ${CADENCE_LABELS[o] ?? o}`])),
      ]) as HTMLSelectElement;
      sel.value = current;
      sel.addEventListener('change', async () => {
        const next: CadenceOverride = {
          rankPoll: a.override?.rankPoll ?? null,
          aiPoll: a.override?.aiPoll ?? null,
          crawl: a.override?.crawl ?? null,
          [f.key]: sel.value === '' ? null : sel.value,
        } as CadenceOverride;
        try {
          await setAccountCadence(a.accountId, next);
          ctx.toast(`${a.name}: ${f.label} ${sel.value === '' ? 'follows the plan again' : `set to ${CADENCE_LABELS[sel.value] ?? sel.value}`}.`);
          reload();
        } catch (err) {
          ctx.toast(readableError(err));
        }
      });
      return sel;
    });
    return el('div', { class: 'intg-assign' }, [
      el('div', { class: 'intg-assign-main' }, [
        el('div', { class: 'intg-assign-label' }, [a.name]),
        el('div', { class: 'num' }, [`${a.effective.tier} plan`]),
      ]),
      el('div', { class: 'ci-controls' }, selects),
    ]);
  };

  const render = async () => {
    host.replaceChildren(el('div', { class: 'fhint num' }, ['Loading…']));
    let rows: AccountCadenceRow[];
    try {
      rows = await fetchPlatformCadences();
    } catch (err) {
      host.replaceChildren(el('div', { class: 'errbox' }, [readableError(err)]));
      return;
    }
    host.replaceChildren(
      el('section', { class: 'panel' }, [
        el('header', {}, [
          el('h3', {}, ['Cadence']),
          infoCard('What the defaults are', {
            title: 'Plan defaults',
            body: [
              'Free: rank weekly, AI answers monthly, crawl monthly.',
              'Paid plans: rank daily, AI answers weekly, crawl weekly.',
              'An override pins one value for one account; "plan default" follows the plan again, including after an upgrade.',
            ],
          }),
        ]),
        el('div', { class: 'intg-body' }, [
          el('div', { class: 'intg-assigns' }, rows.map((a) => accountRow(a, () => void render()))),
        ]),
      ]),
    );
  };
  await render();
  return host;
}

async function usersPanel(ctx: AppContext): Promise<HTMLElement> {
  const host = el('div', {}, []);
  const render = async () => {
    host.replaceChildren(el('div', { class: 'fhint num' }, ['Loading…']));
    let data: { users: PlatformUser[]; adminCount: number };
    try {
      data = await fetchPlatformUsers();
    } catch (err) {
      host.replaceChildren(el('div', { class: 'errbox' }, [readableError(err)]));
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
        ]),
      ]),
    );
  };
  await render();
  return host;
}

/**
 * The checklist, and what to do about each row.
 *
 * An operator's first question on a fresh deployment is "what is not set up
 * yet", and until now the only answer was to read four panels and infer it.
 * Every row is derived from state the deployment already reports, so it cannot
 * claim something is done after someone deletes the secret behind it.
 *
 * A failed read is a `todo` row naming the read that failed, not a thrown
 * error: nine rows where one cannot be determined is more useful than no
 * checklist at all.
 */
async function checklistPanel(): Promise<HTMLElement> {
  const [readiness, google, github, users, queue] = await Promise.all([
    fetchIntegrations().catch(() => null),
    fetchPlatformClient('google').catch(() => null),
    fetchPlatformClient('github').catch(() => null),
    fetchPlatformUsers().catch(() => null),
    fetchQueueHealth().catch(() => null),
  ]);

  const rows = operatorChecklist({ readiness, google, github, users, queue });
  const done = rows.filter((r) => r.state === 'done').length;

  return el('section', { class: 'panel' }, [
    el('header', {}, [
      el('h3', {}, ['Deployment checklist']),
      el('span', { class: 'more num' }, [`${done} of ${rows.length} done`]),
    ]),
    el('div', { class: 'oplist' }, rows.map((r) =>
      el('div', { class: `oprow ${r.state}` }, [
        // A glyph, not a coloured dot alone: colour is the fast read, and the
        // mark is what survives a screenshot in greyscale or a colour-blind
        // reader. `aria-hidden`, with the state named in the row's own text.
        el('span', { class: 'opmark', 'aria-hidden': 'true' }, [
          r.state === 'done' ? '✓' : r.state === 'partial' ? '!' : '•',
        ]),
        el('div', { class: 'opmain' }, [
          el('div', { class: 't' }, [r.label]),
          el('div', { class: 'm' }, [r.detail]),
          r.next ? el('div', { class: 'opnext num' }, [r.next]) : null,
        ].filter(Boolean) as HTMLElement[]),
        el('span', { class: `opstate ${r.state}` }, [
          r.state === 'done' ? 'done' : r.state === 'partial' ? 'partial' : 'to do',
        ]),
      ]),
    )),
  ]);
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

  /** One panel per identity Engine registers. */
  const vendorPanel = async (form: VendorForm, reload: () => void): Promise<HTMLElement> => {
    let view: PlatformClientView;
    try {
      view = await fetchPlatformClient(form.vendor);
    } catch (err) {
      return el('section', { class: 'panel' }, [
        el('header', {}, [logoTile(form.logoDomain, form.name), el('h3', {}, [form.panelTitle])]),
        el('div', { class: 'errbox' }, [readableError(err)]),
      ]);
    }
    return el('section', { class: 'panel' }, [
      el('header', {}, [
        logoTile(form.logoDomain, form.name),
        el('h3', {}, [form.panelTitle]),
        infoCard('Who this is for', form.whoFor),
      ]),
      el('div', { class: 'intg-body' }, [
        statusLine(form, view),
        clientForm(form, view, ctx, reload),
        view.events.length > 0
          ? el('div', { class: 'fhint num' }, [
              `Last change: ${view.events[0].type} by ${view.events[0].actor} · ${new Date(
                view.events[0].occurredAt,
              ).toLocaleString()}`,
            ])
          : null,
      ].filter(Boolean) as HTMLElement[]),
    ]);
  };

  const render = async () => {
    host.replaceChildren(el('div', { class: 'fhint num' }, ['Loading…']));
    const reload = () => void render();
    const [google, github, users, cadence] = await Promise.all([
      vendorPanel(GOOGLE_FORM, reload),
      vendorPanel(GITHUB_FORM, reload),
      usersPanel(ctx),
      cadencePanel(ctx),
    ]);
    // No section heading of its own any more. It carried one while it was a
    // block at the bottom of Settings; on a screen already titled Platform it
    // repeated the h1 two lines below it.
    host.replaceChildren(google, github, users, cadence);
  };

  await render();
  return host;
}

/** One panel's failure, named, so the rest of the screen still renders. */
function failedPanel(what: string, err: unknown): HTMLElement {
  return el('section', { class: 'panel' }, [
    el('div', { class: 'errbox' }, [`Could not load ${what}: ${readableError(err)}`]),
  ]);
}

/**
 * The Platform screen at `#/platform`, for an operator.
 *
 * It was a section at the bottom of Settings, under a customer's brand names
 * and sign-in. That put a deployment's OAuth client registration on the same
 * scroll as "change my password", and it meant the operator's own work had no
 * address to link to or bookmark.
 *
 * Not in the rail. An admin is a customer too on every other screen, and a
 * seventh rail item that is invisible to almost everyone is worse than a hash
 * an operator learns once. Reached from the Settings pointer below.
 *
 * A non-admin is sent to Home rather than shown a refusal: the API answers 404
 * to them, so there is nothing to render, and a customer has no reason to learn
 * that an operator screen exists.
 */
export async function platformView(ctx: AppContext): Promise<HTMLElement> {
  let isAdmin = false;
  try {
    isAdmin = (await fetchPlatformAccess()).isAdmin;
  } catch {
    isAdmin = false;
  }
  if (!isAdmin) {
    ctx.navigate('home');
    return el('div', {});
  }

  // Each part settles on its own. A panel that throws — `cadencePanel` reading
  // a field off a row an older API did not send, say — used to take the whole
  // screen to the shell's "Failed to render" box, and the checklist with it.
  // The checklist is what an operator opens this screen for when something is
  // broken, so it must not share a failure with the panels below it.
  const [checklist, panels, vendorKeys] = await Promise.all([
    checklistPanel(),
    platformSection(ctx).catch((err: unknown) => failedPanel('the platform panels', err)),
    vendorKeysPanel().catch((err: unknown) => failedPanel('the vendor keys', err)),
  ]);

  return el('div', {}, [
    el('div', { class: 'pagehead' }, [
      el('h1', {}, [screenName('platform')]),
      el('p', {}, ['What this deployment needs in order to work. Not visible to customers.']),
    ]),
    checklist,
    panels,
    ...(vendorKeys ? [vendorKeys] : []),
  ]);
}
