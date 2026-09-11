import { el } from '../dom.js';
import { chooseAccountNote, screenName } from '../format.js';
import {
  currentAccountVocabulary,
  getProjectId,
  getAccountId,
  fetchEntities,
  setEntityKindApi,
  setPasswordApi,
  fetchAccountCadence,
  fetchPlatformAccess,
  fetchAccounts,
  fetchDeployTarget,
  setAccountKindApi,
  updateBrandingApi,
} from '../api.js';
import { ENTITY_KIND_OPTIONS, DEFAULT_ENTITY_KIND, ACCOUNT_TYPE_OPTIONS } from '../format.js';
import { deployTargetFields } from '../deployTargetForm.js';
import { readableError } from '../errors.js';
import type { AppContext } from '../context.js';
import type { AccountCard, AccountKind, DeployTarget, EffectiveCadence } from '../types.js';

/**
 * What kind of thing each brand on this site is. Engine writes it into the
 * structured data it proposes, so a brand left as the wrong kind produces
 * structured data that describes the wrong thing — and a brand Engine cannot
 * type at all produces no structured-data fix, by design.
 */
async function brandKindSection(ctx: AppContext): Promise<HTMLElement> {
  if (!getProjectId()) {
    return el('section', { class: 'panel' }, [
      el('header', {}, [el('h3', {}, ['Your brand'])]),
      el('div', { class: 'notebox' }, ['Choose a site from the switcher at the top of the rail first.']),
    ]);
  }
  let entities;
  try {
    entities = await fetchEntities();
  } catch (err) {
    return el('section', { class: 'panel' }, [
      el('header', {}, [el('h3', {}, ['Your brand'])]),
      el('div', { class: 'errbox' }, [`Could not load your brands: ${readableError(err)}`]),
    ]);
  }
  if (entities.length === 0) {
    return el('section', { class: 'panel' }, [
      el('header', {}, [el('h3', {}, ['Your brand'])]),
      el('div', { class: 'notebox' }, ['This site has no brand yet. Add one from Set up a site.']),
    ]);
  }

  const rows = entities.map((entity) => {
    const select = el('select', { class: 'field' }, ENTITY_KIND_OPTIONS.map((k) =>
      el('option', { value: k.value }, [k.label]),
    )) as HTMLSelectElement;
    select.value = entity.schemaType ?? DEFAULT_ENTITY_KIND;
    select.addEventListener('change', async () => {
      const chosen = select.value;
      select.setAttribute('disabled', 'true');
      try {
        await setEntityKindApi(entity.id, chosen);
        ctx.toast(`${entity.canonicalName} saved.`);
      } catch (err) {
        ctx.toast(`Could not save: ${readableError(err)}`);
        select.value = entity.schemaType ?? DEFAULT_ENTITY_KIND;
      }
      select.removeAttribute('disabled');
    });
    return el('div', { class: 'fstack' }, [
      el('label', { class: 'flabel' }, [entity.canonicalName]),
      select,
    ]);
  });

  return el('section', { class: 'panel' }, [
    el('header', {}, [el('h3', {}, ['Your brand'])]),
    el('div', { class: 'form' }, [
      el('div', { class: 'fhint' }, [
        'What Engine tells search engines and assistants this is. It sets the type on the structured data Engine proposes for your pages.',
      ]),
      ...rows,
    ]),
  ]);
}

/**
 * Set or replace the signed-in person's password. Also the reset path: someone
 * who forgot theirs signs in with an emailed code and lands here. Twelve
 * characters minimum, the same floor `pnpm db:user` applies; the API refuses
 * less, and the confirm field catches the typo before the API does.
 */
function passwordSection(ctx: AppContext): HTMLElement {
  const first = el('input', { class: 'field', type: 'password', autocomplete: 'new-password', placeholder: 'At least 12 characters' }) as HTMLInputElement;
  const again = el('input', { class: 'field', type: 'password', autocomplete: 'new-password', placeholder: 'Type it again' }) as HTMLInputElement;
  const save = el('button', {
    class: 'btn primary',
    onclick: async () => {
      if (first.value.length < 12) {
        ctx.toast('Use at least 12 characters.');
        first.focus();
        return;
      }
      if (first.value !== again.value) {
        ctx.toast('The two passwords do not match.');
        again.focus();
        return;
      }
      save.setAttribute('disabled', 'true');
      try {
        await setPasswordApi(first.value);
        first.value = '';
        again.value = '';
        ctx.toast('Password saved. You can sign in with it or with an emailed code.');
      } catch (err) {
        ctx.toast(`Could not save the password: ${(err as Error).message}`);
      } finally {
        save.removeAttribute('disabled');
      }
    },
  }, ['Save password']);

  return el('section', { class: 'panel' }, [
    el('header', {}, [el('h3', {}, ['Password'])]),
    el('div', { class: 'form' }, [
      el('div', { class: 'fhint' }, [
        'Optional. An emailed code always signs you in; a password lets you sign in without waiting for one. Setting a new one replaces the old.',
      ]),
      el('label', { class: 'flabel' }, ['New password']),
      first,
      el('label', { class: 'flabel' }, ['Confirm']),
      again,
      el('div', { class: 'form-actions' }, [save]),
    ]),
  ]);
}

export const CADENCE_LABELS: Record<string, string> = {
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
  on_demand: 'Only when you run it',
};

/**
 * How often this account is measured (issue 10). Read-only here: the values
 * follow the plan, and an administrator can override them from the platform
 * screen. Shown so a customer knows why a number is a week old.
 */
async function cadenceSection(): Promise<HTMLElement> {
  const accountId = getAccountId();
  if (!accountId) {
    return el('section', { class: 'panel' }, [
      el('header', {}, [el('h3', {}, ['Polling cadence'])]),
      el('div', { class: 'notebox' }, [chooseAccountNote(currentAccountVocabulary())]),
    ]);
  }
  let c: EffectiveCadence;
  try {
    c = await fetchAccountCadence(accountId);
  } catch (err) {
    return el('section', { class: 'panel' }, [
      el('header', {}, [el('h3', {}, ['Polling cadence'])]),
      el('div', { class: 'errbox' }, [`Could not load the cadence: ${readableError(err)}`]),
    ]);
  }
  const row = (label: string, value: string, source: string, why: string) =>
    el('div', { class: 'kw-row kw-2' }, [
      el('div', { class: 'kw-main' }, [el('div', { class: 't' }, [label]), el('div', { class: 'm num' }, [why])]),
      el('div', { class: 'num' }, [CADENCE_LABELS[value] ?? value, source === 'override' ? ' · set by Engine' : ` · ${c.tier} plan`]),
    ]);
  return el('section', { class: 'panel' }, [
    el('header', {}, [el('h3', {}, ['Polling cadence'])]),
    el('div', { class: 'kw-list' }, [
      row('Rank positions', c.policy.rankPoll, c.source.rankPoll, 'Positions move daily; each lookup is billed, so the rhythm follows the plan.'),
      row('AI answers', c.policy.aiPoll, c.source.aiPoll, 'A model\'s knowledge changes when the vendor ships a model, so more often only narrows the range.'),
      row('Site crawl', c.policy.crawl, c.source.crawl, 'Also runs whenever you press Run audit.'),
      row('Entity, off-site, competitor and local audits', 'nightly', 'plan-default', 'No vendor call, so these run every night for everyone.'),
    ]),
  ]);
}

/**
 * A link to the operator screen, or nothing.
 *
 * Nothing for a customer, who has no reason to learn that the screen exists.
 * The screen itself checks admin again, so this is presentation rather than
 * the guard.
 */
async function platformPointer(ctx: AppContext): Promise<HTMLElement | null> {
  let isAdmin = false;
  try {
    isAdmin = (await fetchPlatformAccess()).isAdmin;
  } catch {
    return null;
  }
  if (!isAdmin) return null;

  return el('div', {}, [
    el('div', { class: 'settings-sec' }, ['Platform']),
    el('section', { class: 'panel' }, [
      el('div', { class: 'form' }, [
        el('div', { class: 'fhint' }, [
          'Engine’s own OAuth clients, this deployment’s vendor keys, the user list and the setup checklist.',
        ]),
        el('div', { class: 'form-actions' }, [
          el('button', { class: 'btn', onclick: () => ctx.navigate('platform') }, ['Open Platform']),
        ]),
      ]),
    ]),
  ]);
}

/**
 * What kind of thing this account is, which is what unlocks the client layer.
 *
 * Owners and platform admins write it; a member sees the current value and
 * cannot change it. That split is the same one `getAccountRole` was added for
 * on the API: a shared setting that changes what the whole account can see is
 * an owner's call. The select is disabled rather than hidden, because a member
 * asking "are we set up as an agency?" deserves an answer.
 *
 * Leaving 'agency' is refused by the API while other clients exist. The reason
 * is shown from the API's own message rather than restated here, so the two
 * cannot drift.
 */
async function accountTypeSection(ctx: AppContext): Promise<HTMLElement | null> {
  const accountId = getAccountId();
  if (!accountId) return null;

  let account: AccountCard | undefined;
  let isAdmin = false;
  try {
    const [accounts, access] = await Promise.all([
      fetchAccounts(),
      fetchPlatformAccess().catch(() => ({ isAdmin: false })),
    ]);
    account = accounts.find((a) => a.id === accountId);
    isAdmin = access.isAdmin;
  } catch (err) {
    return el('section', { class: 'panel' }, [
      el('header', {}, [el('h3', {}, ['Account type'])]),
      el('div', { class: 'errbox' }, [`Could not read this account: ${readableError(err)}`]),
    ]);
  }
  if (!account) return null;

  const mayEdit = account.role === 'owner' || isAdmin;
  const select = el('select', { class: 'field' }, ACCOUNT_TYPE_OPTIONS.map((k) =>
    el('option', { value: k.value }, [k.label]),
  )) as HTMLSelectElement;
  select.value = account.kind;
  if (!mayEdit) select.setAttribute('disabled', 'true');

  const note = el('div', { class: 'fhint' }, [
    mayEdit
      ? 'An agency has clients, each with its own sites and its own connections. A company or one person has sites directly.'
      : 'Only an owner can change the account type.',
  ]);

  select.addEventListener('change', async () => {
    const chosen = select.value as AccountKind;
    const previous = account!.kind;
    select.setAttribute('disabled', 'true');
    try {
      await setAccountKindApi(accountId, chosen);
      ctx.toast('Account type saved.');
      // The rail, the workspace column and this page all branch on the kind,
      // so the whole screen is re-rendered rather than this panel alone.
      ctx.navigate('settings');
    } catch (err) {
      select.value = previous;
      ctx.toast(readableError(err));
    }
    if (mayEdit) select.removeAttribute('disabled');
  });

  return el('section', { class: 'panel' }, [
    el('header', {}, [
      el('h3', {}, ['Account type']),
      el('span', { class: 'more' }, [account.name]),
    ]),
    el('div', { class: 'form' }, [note, el('div', { class: 'fstack' }, [select])]),
  ]);
}

/**
 * Where an approved fix for this project lands (M2.3 #3). Every generated
 * Action needs a target, so this is what unlocks the Findings screen's
 * "Propose fix" button. One target per project; the kind selects which fields
 * matter.
 *
 * It briefly sat on Integrations, on the argument that a GitHub PR target needs
 * the GitHub connection granted there. That confused a library of third-party
 * connections with a setting about this account: the target is a choice about
 * where Engine writes, and it belongs with the account's other settings even
 * when one of its kinds happens to need a connection.
 */
async function deployTargetSection(ctx: AppContext): Promise<HTMLElement> {
  let current: DeployTarget | null = null;
  try {
    current = await fetchDeployTarget();
  } catch {
    // No API / not reachable — render the empty form rather than blocking the page.
  }

  const fields = deployTargetFields(ctx, {
    current,
    onSaved: () => ctx.toast('Deploy target saved. Auto-fixable findings can now be proposed.'),
  });

  return el('section', { class: 'panel' }, [
    el('header', {}, [
      el('h3', {}, ['Where fixes go']),
      el('span', { class: 'more' }, [current ? `current: ${current.kind}` : 'none set']),
    ]),
    fields,
  ]);
}

/**
 * M2.5 agency white-label: the name, logo and colour a branded report carries.
 *
 * Agency accounts only, which is what 0035's `kind` is for. A company or an
 * individual has no client to put someone else's name in front of, so the
 * panel was three fields they would never fill — and returning null rather
 * than a disabled panel means they are not told a feature exists that does not
 * apply to them.
 */
async function brandingSection(ctx: AppContext): Promise<HTMLElement | null> {
  const accountId = getAccountId();
  if (!accountId) return null;

  // One read serves both questions: whether to show the panel at all, and what
  // to prefill it with. Three blank inputs over saved values read as "nothing
  // is set", and saving one field then wiped the other two.
  let account: AccountCard | undefined;
  try {
    account = (await fetchAccounts()).find((a) => a.id === accountId);
  } catch {
    // Unreachable API. The panel is agency-only and cannot be shown without
    // knowing the kind, so it is left out rather than guessed at.
    return null;
  }
  if (!account || account.kind !== 'agency') return null;
  const current = account.branding;

  const nameInput = el('input', { class: 'field', type: 'text', placeholder: 'Acme Agency', value: current.companyName ?? '' }) as HTMLInputElement;
  const logoInput = el('input', { class: 'field', type: 'text', placeholder: 'https://…/logo.png', value: current.logoUrl ?? '' }) as HTMLInputElement;
  const colorInput = el('input', { class: 'field', type: 'text', placeholder: '#4f46e5', value: current.primaryColor ?? '' }) as HTMLInputElement;

  const save = el('button', {
    class: 'btn primary',
    onclick: async () => {
      try {
        // All three sent, empty string included: the inputs hold the whole
        // object, so a field the user emptied is a deletion the API applies.
        await updateBrandingApi(accountId, {
          companyName: nameInput.value.trim(),
          logoUrl: logoInput.value.trim(),
          primaryColor: colorInput.value.trim(),
        });
        ctx.toast('Branding saved.');
      } catch (err) {
        ctx.toast(`Could not save branding: ${readableError(err)}`);
      }
    },
  }, ['Save branding']);

  return el('section', { class: 'panel' }, [
    el('header', {}, [
      el('h3', {}, ['Report branding']),
      el('span', { class: 'more' }, [account.name]),
    ]),
    el('div', { class: 'form' }, [
      el('div', { class: 'fhint' }, ['What a branded report shows instead of Engine’s own name.']),
      el('label', { class: 'flabel' }, ['Company name']),
      nameInput,
      el('label', { class: 'flabel' }, ['Logo URL']),
      logoInput,
      el('label', { class: 'flabel' }, ['Primary color']),
      colorInput,
      el('div', { class: 'form-actions' }, [save]),
    ]),
  ]);
}

export async function settingsView(ctx: AppContext): Promise<HTMLElement> {
  const [accountType, deploy, branding] = await Promise.all([
    accountTypeSection(ctx),
    deployTargetSection(ctx),
    brandingSection(ctx),
  ]);

  return el('div', {}, [
    el('div', { class: 'pagehead' }, [
      el('h1', {}, [screenName('settings')]),
      el('p', {}, ['Your account, your brand, where fixes go, and your sign-in.']),
    ]),
    ...(accountType ? [el('div', { class: 'settings-sec' }, ['Account type']), accountType] : []),
    el('div', { class: 'settings-sec' }, ['Your brand']),
    await brandKindSection(ctx),
    el('div', { class: 'settings-sec' }, ['Where fixes go']),
    deploy,
    ...(branding ? [el('div', { class: 'settings-sec' }, ['Report branding']), branding] : []),
    el('div', { class: 'settings-sec' }, ['Polling cadence']),
    await cadenceSection(),
    el('div', { class: 'settings-sec' }, ['Sign-in']),
    passwordSection(ctx),
    el('div', { class: 'settings-sec' }, ['Connected accounts']),
    el('section', { class: 'panel' }, [
      el('div', { class: 'form' }, [
        el('div', { class: 'fhint' }, [
          'Search Console, Analytics, Business Profile, Bing and Cloudflare are connected from the Integrations page.',
        ]),
        el('div', { class: 'form-actions' }, [
          el('button', { class: 'btn', onclick: () => ctx.navigate('integrations') }, ['Open Integrations']),
        ]),
      ]),
    ]),
    // Operator-only, and a link rather than the panels themselves. The OAuth
    // client registration and the deployment's vendor keys used to render at
    // the bottom of this page, which put a deployment's configuration on the
    // same scroll as "change my password" and gave the operator's own work no
    // address to bookmark. It renders nothing for a customer.
    await platformPointer(ctx),
  ]);
}
