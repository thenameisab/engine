import { el } from '../dom.js';
import { screenName } from '../format.js';
import { deployTargetFields } from '../deployTargetForm.js';
import {
  getProjectId,
  getAccountId,
  updateBrandingApi,
  fetchDeployTarget,
  saveDeployTarget,
  fetchEntities,
  setEntityKindApi,
} from '../api.js';
import { ENTITY_KIND_OPTIONS, DEFAULT_ENTITY_KIND } from '../format.js';
import { readableError } from '../errors.js';
import { platformSection } from './platform.js';
import { vendorKeysPanel } from './integrations.js';
import type { AppContext } from '../context.js';
import type { DeployTarget } from '../types.js';

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
function brandingSection(ctx: AppContext): HTMLElement {
  const accountId = getAccountId();
  if (!accountId) {
    return el('section', { class: 'panel' }, [
      el('header', {}, [el('h3', {}, ['Branding'])]),
      el('div', { class: 'fq-note' }, ['Pick a client from the Clients grid first.']),
    ]);
  }

  const nameInput = el('input', { class: 'field', type: 'text', placeholder: 'Acme Agency' }) as HTMLInputElement;
  const logoInput = el('input', { class: 'field', type: 'text', placeholder: 'https://…/logo.png' }) as HTMLInputElement;
  const colorInput = el('input', { class: 'field', type: 'text', placeholder: '#4f46e5' }) as HTMLInputElement;

  const save = el('button', {
    class: 'btn primary',
    onclick: async () => {
      try {
        await updateBrandingApi(accountId, {
          companyName: nameInput.value.trim() || undefined,
          logoUrl: logoInput.value.trim() || undefined,
          primaryColor: colorInput.value.trim() || undefined,
        });
        ctx.toast('Branding saved.');
      } catch (err) {
        ctx.toast(`Could not save branding: ${(err as Error).message}`);
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
    brandingSection(ctx),
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
