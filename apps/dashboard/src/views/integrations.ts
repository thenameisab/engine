import { el } from '../dom.js';
import { screenName } from '../format.js';
import { logoTile } from '../logo.js';
import { infoCard } from '../hovercard.js';
import { fetchIntegrations, fetchPlatformAccess } from '../api.js';
import { readableError } from '../errors.js';
import { integrationsGallery } from './googleIntegrations.js';
import type { AppContext } from '../context.js';
import type { ReadinessReport, IntegrationReadiness } from '../types.js';

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
 * The Integrations page: the customer's connections, and nothing else.
 *
 * The operator panels that used to sit under the cards (Engine's own OAuth
 * client, the deployment's vendor keys) moved to Settings. A customer opening
 * this page has one question, "is my account connected", and the answer should
 * not share a screen with the deployment's configuration.
 */
export async function integrationsView(ctx: AppContext): Promise<HTMLElement> {
  return el('div', {}, [
    el('div', { class: 'pagehead' }, [
      el('h1', {}, [screenName('integrations')]),
      el('p', {}, ['Connect the accounts Engine reads from and writes to. Pick one to sign in or paste a key.']),
    ]),
    await integrationsGallery(ctx),
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
