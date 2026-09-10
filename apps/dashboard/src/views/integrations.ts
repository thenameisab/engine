import { el } from '../dom.js';
import { screenName } from '../format.js';
import { logoTile } from '../logo.js';
import { infoCard } from '../hovercard.js';
import {
  fetchAccounts,
  fetchDeployTarget,
  fetchIntegrations,
  fetchPlatformAccess,
  getAccountId,
  updateBrandingApi,
} from '../api.js';
import { deployTargetFields } from '../deployTargetForm.js';
import { readableError } from '../errors.js';
import { integrationsGallery } from './googleIntegrations.js';
import type { AppContext } from '../context.js';
import type { AccountCard, DeployTarget, ReadinessReport, IntegrationReadiness } from '../types.js';

const STATUS_TEXT: Record<IntegrationReadiness['status'], string> = {
  configured: 'Wired',
  partial: 'Partial',
  missing: 'Not wired',
};

function integrationCard(i: IntegrationReadiness): HTMLElement {
  return el('div', { class: `intg ${i.status}` }, [
    el('div', { class: 'intg-top' }, [
      logoTile(i.logoDomain, i.name),
      el('span', { class: `intg-dot ${i.status}` }),
      el('div', { class: 'intg-name' }, [
        i.name,
        i.requiredForMvp ? null : el('span', { class: 'tagband' }, ['optional']),
      ]),
      el('span', { class: `intg-status ${i.status}` }, [STATUS_TEXT[i.status]]),
    ]),
    el('div', { class: 'intg-cat' }, [i.category]),
    i.missing.length > 0
      ? el('div', { class: 'intg-missing' }, [
          'Missing: ',
          el('span', { class: 'num' }, [i.missing.map((m) => m.name).join(', ')]),
        ])
      : el('div', { class: 'intg-ok num' }, ['all required vars set']),
  ]);
}

function summaryStat(label: string, n: number, cls: string): HTMLElement {
  return el('div', { class: `sstat ${cls}` }, [
    el('div', { class: 'sstat-n num' }, [String(n)]),
    el('div', { class: 'sstat-l' }, [label]),
  ]);
}

/**
 * Platform readiness: whether **this deployment** has its own vendor keys wired.
 *
 * An operator view, not a customer one. It used to fall back to a hardcoded
 * `MOCK_READINESS` when the API was unreachable, which was wrong twice over: it
 * presented invented status as fact, and the fixture had gone stale — it still
 * listed a `gsc-oauth` integration that no longer exists. An unreachable API is
 * now reported as an unreachable API.
 */
export async function integrationsSection(): Promise<HTMLElement> {
  let report: ReadinessReport;
  try {
    report = await fetchIntegrations();
  } catch (err) {
    return el('div', { class: 'fq-note' }, [
      `Could not read integration readiness: ${readableError(err)}`,
    ]);
  }

  const s = report.summary;
  return el('div', {}, [
    el('div', { class: 'summary-row' }, [
      summaryStat('Wired', s.configured, 'configured'),
      summaryStat('Partial', s.partial, 'partial'),
      summaryStat('Not wired', s.missing, 'missing'),
    ]),
    el('div', { class: 'intg-grid' }, report.integrations.map(integrationCard)),
  ]);
}

/**
 * Where an approved fix for this project lands (M2.3 #3). Every generated
 * Action needs a target, so this is what unlocks the Findings screen's
 * "Propose fix" button. One target per project; the kind selects which fields
 * matter.
 *
 * It sat on Settings, one screen away from the accounts it depends on — a
 * GitHub PR target needs the GitHub connection, and a Cloudflare worker target
 * needs the Cloudflare key, both of which are connected here. The customer had
 * to set up half of one thing in two places.
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
      el('h3', {}, ['Where approved fixes deploy']),
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
 *
 * Operates on `getAccountId()`, the client last selected from the Clients grid,
 * since this view has no id in the URL to read one from.
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

/**
 * The Integrations page: everything a customer sets up, and nothing a
 * deployment operator does.
 *
 * Three sections. Where fixes go, the connected accounts, and — for an agency —
 * report branding. The first and last were on Settings, which split one job
 * across two screens: a GitHub PR target needs the GitHub connection that is
 * granted here, and a branded report needs the client whose connections are
 * listed here.
 *
 * The operator panels (Engine's own OAuth client, the deployment's vendor keys)
 * stay on Settings. A customer opening this page is setting up their own
 * account, and that should not share a screen with the deployment's
 * configuration.
 */
export async function integrationsView(ctx: AppContext): Promise<HTMLElement> {
  const [deploy, gallery, branding] = await Promise.all([
    deployTargetSection(ctx),
    integrationsGallery(ctx),
    brandingSection(ctx),
  ]);

  return el('div', {}, [
    el('div', { class: 'pagehead' }, [
      el('h1', {}, [screenName('integrations')]),
      el('p', {}, ['Where approved fixes deploy, and the accounts Engine reads from and writes to.']),
    ]),
    el('div', { class: 'settings-sec' }, ['Where fixes go']),
    deploy,
    el('div', { class: 'settings-sec' }, ['Connected accounts']),
    gallery,
    ...(branding ? [el('div', { class: 'settings-sec' }, ['Report branding']), branding] : []),
  ]);
}

/**
 * The deployment's own vendor keys, for Settings. Admin-only: the API answers
 * 404 to anyone else, and rendering "could not read" in that case would report
 * a failure at something the customer never asked for, so it renders nothing.
 */
export async function vendorKeysPanel(): Promise<HTMLElement | null> {
  let isAdmin = false;
  try {
    isAdmin = (await fetchPlatformAccess()).isAdmin;
  } catch {
    return null;
  }
  if (!isAdmin) return null;
  return el('div', {}, [
    el('div', { class: 'settings-sec' }, ['Vendor keys']),
    el('section', { class: 'panel' }, [
      el('header', {}, [
        el('h3', {}, ['Keys this deployment holds']),
        infoCard('What vendor keys are', {
          title: 'Our keys, not yours',
          body: [
            'Whether this deployment has its own vendor keys wired: search results, AI answers, billing.',
            'Separate from the connections on the Integrations page, which belong to a client and only that client can revoke.',
          ],
        }),
      ]),
      el('div', { class: 'intg-wrap' }, [await integrationsSection()]),
    ]),
  ]);
}
