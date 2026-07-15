import { el } from '../dom.js';
import { fetchIntegrations } from '../api.js';
import { MOCK_READINESS } from '../mock.js';
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

export async function integrationsView(ctx: AppContext): Promise<HTMLElement> {
  let report: ReadinessReport = MOCK_READINESS;
  try {
    report = await fetchIntegrations();
    ctx.setBadge('live');
  } catch {
    ctx.setBadge('sample');
  }

  const s = report.summary;
  return el('div', {}, [
    el('div', { class: 'pagehead' }, [
      el('h1', {}, ['Integrations']),
      el('p', { html: `${s.configured}/${s.total} wired · <b>${report.mvpReady ? 'MVP-ready' : 'not MVP-ready'}</b>. Set an API base URL in Settings to read this live from <span class="num">/health/integrations</span>.` }),
    ]),
    el('div', { class: 'summary-row' }, [
      summaryStat('Wired', s.configured, 'configured'),
      summaryStat('Partial', s.partial, 'partial'),
      summaryStat('Not wired', s.missing, 'missing'),
    ]),
    el('div', { class: 'intg-grid' }, report.integrations.map(integrationCard)),
  ]);
}

function summaryStat(label: string, n: number, cls: string): HTMLElement {
  return el('div', { class: `sstat ${cls}` }, [
    el('div', { class: 'sstat-n num' }, [String(n)]),
    el('div', { class: 'sstat-l' }, [label]),
  ]);
}
