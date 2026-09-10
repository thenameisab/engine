import { el } from '../dom.js';
import { screenName } from '../format.js';
import { deployTargetFields } from '../deployTargetForm.js';
import {
  getProjectId,
  getAccountId,
  updateBrandingApi,
  fetchAccounts,
  fetchDeployTarget,
  saveDeployTarget,
  fetchEntities,
  setEntityKindApi,
  setPasswordApi,
  fetchAccountCadence,
} from '../api.js';
import { ENTITY_KIND_OPTIONS, DEFAULT_ENTITY_KIND } from '../format.js';
import { readableError } from '../errors.js';
import { platformSection } from './platform.js';
import { vendorKeysPanel } from './integrations.js';
import type { AppContext } from '../context.js';
import type { ApiAccountBranding, DeployTarget, EffectiveCadence } from '../types.js';

/**
 * Where an approved fix for this project lands (M2.3 #3). Every generated
 * Action needs a target, so this is what unlocks the Audit view's "Propose
 * fix" button. One target per project; the kind selects which fields matter.
 */
async function deployTargetSection(ctx: AppContext): Promise<HTMLElement> {
  let current: DeployTarget | null = null;
  try {
    current = await fetchDeployTarget();
  } catch {
    // No API / not reachable — render the empty form rather than blocking Settings.
  }

  const fields = deployTargetFields(ctx, {
    current,
    onSaved: () => ctx.toast('Deploy target saved. Auto-fixable findings can now be proposed.'),
  });

  return el('section', { class: 'panel' }, [
    el('header', {}, [
      el('h3', {}, ['Deploy target']),
      el('span', { class: 'more' }, [current ? `current: ${current.kind}` : 'none set']),
    ]),
    fields,
  ]);
}

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
      el('div', { class: 'fq-note' }, ['Choose a site from the switcher at the top of the rail first.']),
    ]);
  }
  let entities;
  try {
    entities = await fetchEntities();
  } catch (err) {
    return el('section', { class: 'panel' }, [
      el('header', {}, [el('h3', {}, ['Your brand'])]),
      el('div', { class: 'fq-note' }, [`Could not load your brands: ${readableError(err)}`]),
    ]);
  }
  if (entities.length === 0) {
    return el('section', { class: 'panel' }, [
      el('header', {}, [el('h3', {}, ['Your brand'])]),
      el('div', { class: 'fq-note' }, ['This site has no brand yet. Add one from Set up a site.']),
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
 * M2.5 agency white-label: branding is an account-level setting, so it lives
 * alongside "which project/API base am I pointed at" rather than a separate
 * page. Operates on `getAccountId()` — the account last selected from the
 * Clients grid — since this view has no id in the URL to read one from.
 */
async function brandingSection(ctx: AppContext): Promise<HTMLElement> {
  const accountId = getAccountId();
  if (!accountId) {
    return el('section', { class: 'panel' }, [
      el('header', {}, [el('h3', {}, ['Branding'])]),
      el('div', { class: 'fq-note' }, ['Pick a client from the Clients grid first.']),
    ]);
  }

  // Prefilled, because the form is the only way to see what is stored. Three
  // blank inputs over saved values read as "nothing is set", and saving one
  // field then cleared the other two.
  let current: ApiAccountBranding = {};
  try {
    const account = (await fetchAccounts()).find((a) => a.id === accountId);
    if (account) current = account.branding;
  } catch {
    // Unreachable API — render the form empty rather than blocking Settings,
    // the same choice `deployTargetSection` makes.
  }

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
    el('header', {}, [el('h3', {}, ['Branding']), el('span', { class: 'more' }, [`account ${accountId.slice(0, 8)}…`])]),
    el('div', { class: 'form' }, [
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
      el('div', { class: 'fq-note' }, ['Pick a client from the Clients grid first.']),
    ]);
  }
  let c: EffectiveCadence;
  try {
    c = await fetchAccountCadence(accountId);
  } catch (err) {
    return el('section', { class: 'panel' }, [
      el('header', {}, [el('h3', {}, ['Polling cadence'])]),
      el('div', { class: 'fq-note' }, [`Could not load the cadence: ${readableError(err)}`]),
    ]);
  }
  const row = (label: string, value: string, source: string, why: string) =>
    el('div', { class: 'kw-row' }, [
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

export async function settingsView(ctx: AppContext): Promise<HTMLElement> {
  return el('div', {}, [
    el('div', { class: 'pagehead' }, [
      el('h1', {}, [screenName('settings')]),
      el('p', {}, ['Your brand, where approved fixes deploy, and how reports are branded.']),
    ]),
    el('div', { class: 'settings-sec' }, ['Your brand']),
    await brandKindSection(ctx),
    el('div', { class: 'settings-sec' }, ['Deploy target']),
    await deployTargetSection(ctx),
    el('div', { class: 'settings-sec' }, ['Branding']),
    await brandingSection(ctx),
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
    // Operator-only. Both render nothing for a customer, so this is where an
    // administrator registers Engine's own OAuth client and checks the
    // deployment's vendor keys, away from the customer's connections.
    await platformSection(ctx),
    await vendorKeysPanel(),
  ]);
}
