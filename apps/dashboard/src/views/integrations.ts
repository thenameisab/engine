import { el } from '../dom.js';
import { logoTile } from '../logo.js';
import { fetchIntegrations } from '../api.js';
import { googleIntegrationsSection } from './googleIntegrations.js';
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
      `Could not read integration readiness: ${(err as Error).message}`,
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
 * The Integrations page.
 *
 * Its own route rather than a block at the bottom of Settings, below the API
 * connection, deploy target and branding forms. Connecting Google is the first
 * thing a new account has to do and the thing they will come back to when a
 * sync stalls; three sections down a settings page is not where either of those
 * belongs.
 */
export async function integrationsView(ctx: AppContext): Promise<HTMLElement> {
  return el('div', {}, [
    el('div', { class: 'pagehead' }, [
      el('h1', {}, ['Integrations']),
      el('p', {}, ['Connect your Google accounts and choose which property or location each project reads.']),
    ]),
    await googleIntegrationsSection(ctx),
    el('div', { class: 'settings-sec' }, ['Platform wiring']),
    el('section', { class: 'panel' }, [
      el('header', {}, [
        el('h3', {}, ['External integrations']),
        el('span', { class: 'more' }, ['from /health/integrations']),
      ]),
      el('div', { class: 'fhint num intg-wrap' }, [
        'Whether this deployment has its own vendor keys wired \u2014 SERP, LLM, billing. Separate from the Google connections above, which are yours.',
      ]),
      el('div', { class: 'intg-wrap' }, [await integrationsSection()]),
    ]),
  ]);
}
