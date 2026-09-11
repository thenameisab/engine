import { el } from '../dom.js';
import { screenName } from '../format.js';
import {
  getProjectId,
  getAccountId,
  fetchEntities,
  setEntityKindApi,
  setPasswordApi,
  fetchAccountCadence,
  fetchPlatformAccess,
} from '../api.js';
import { ENTITY_KIND_OPTIONS, DEFAULT_ENTITY_KIND } from '../format.js';
import { readableError } from '../errors.js';
import type { AppContext } from '../context.js';
import type { EffectiveCadence } from '../types.js';

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

export async function settingsView(ctx: AppContext): Promise<HTMLElement> {
  return el('div', {}, [
    el('div', { class: 'pagehead' }, [
      el('h1', {}, [screenName('settings')]),
      el('p', {}, ['Your brand, how often Engine looks, and your sign-in.']),
    ]),
    el('div', { class: 'settings-sec' }, ['Your brand']),
    await brandKindSection(ctx),
    el('div', { class: 'settings-sec' }, ['Polling cadence']),
    await cadenceSection(),
    el('div', { class: 'settings-sec' }, ['Sign-in']),
    passwordSection(ctx),
    el('div', { class: 'settings-sec' }, ['Connected accounts']),
    el('section', { class: 'panel' }, [
      el('div', { class: 'form' }, [
        el('div', { class: 'fhint' }, [
          'Search Console, Analytics, Business Profile, Bing and Cloudflare are connected from the Integrations page, ' +
            'along with where approved fixes deploy and — for an agency — your report branding.',
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
