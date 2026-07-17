import { el } from '../dom.js';
import { fetchAudit } from '../api.js';
import type { AppContext } from '../context.js';
import type { AuditData, FindingRow } from '../types.js';

function findingRow(f: FindingRow): HTMLElement {
  return el('div', { class: 'frow' }, [
    el('span', { class: `sev ${f.severity}` }, [f.severity]),
    el('div', { class: 'fmain' }, [
      el('div', { class: 't' }, [f.title]),
      el('div', { class: 'm' }, [f.url ? `${f.type} · ${f.url}` : f.type]),
    ]),
    f.autoFixable ? el('span', { class: 'pill impact' }, ['auto-fixable']) : el('span', { class: 'pill effort' }, ['manual']),
    el('span', { class: 'impact-n num' }, [`+${f.predictedImpact}`]),
  ]);
}

/**
 * The header line. Every part is conditional because every part can legitimately
 * be absent: a project that has never been crawled has no health score, and
 * saying "Health score 100" — or 72, as the sample data did — describes a site
 * nobody has looked at.
 */
function summary(d: AuditData): HTMLElement {
  if (d.healthScore === null) {
    return el('p', {}, ['No audit has run for this project yet.']);
  }
  const pages = d.pagesAudited === 1 ? '1 page' : `${d.pagesAudited} pages`;
  return el('p', {
    html:
      `Health score <b>${d.healthScore}</b> across ${pages} · ` +
      `<b>${d.autoFixableCount}</b> of <b>${d.findings.length}</b> findings map to a one-click fix.`,
  });
}

export async function auditView(_ctx: AppContext): Promise<HTMLElement> {
  let data: AuditData | null = null;
  let loadError: string | null = null;
  try {
    data = await fetchAudit();
  } catch (err) {
    // Same rule as the Fix Queue: an unreachable API is not an empty audit, and
    // this view will not invent findings to paper over the difference.
    loadError = (err as Error).message;
  }

  if (!data) {
    return el('div', {}, [
      el('div', { class: 'pagehead' }, [el('h1', {}, ['Technical audit'])]),
      el('section', { class: 'panel' }, [
        el('div', { class: 'fq-note' }, [`Could not load the audit: ${loadError}`]),
      ]),
    ]);
  }

  const d = data;
  return el('div', {}, [
    el('div', { class: 'pagehead' }, [el('h1', {}, ['Technical audit']), summary(d)]),
    el('section', { class: 'panel' }, [
      el('header', {}, [
        el('h3', {}, ['Findings']),
        el('span', { class: 'more' }, [d.findings.length === 1 ? '1 issue' : `${d.findings.length} issues`]),
      ]),
      d.findings.length === 0
        ? el('div', { class: 'fq-note' }, [
            d.healthScore === null
              ? 'Run a crawl to populate the audit — findings appear here once one reports.'
              : 'No findings. The last crawl found nothing to fix.',
          ])
        : el('div', { class: 'flist' }, d.findings.map(findingRow)),
    ]),
  ]);
}
