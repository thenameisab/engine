import { el } from '../dom.js';
import { MOCK_AUDIT } from '../mock.js';
import type { AppContext } from '../context.js';
import type { FindingRow } from '../types.js';

function findingRow(f: FindingRow): HTMLElement {
  return el('div', { class: 'frow' }, [
    el('span', { class: `sev ${f.severity}` }, [f.severity]),
    el('div', { class: 'fmain' }, [
      el('div', { class: 't' }, [f.title]),
      el('div', { class: 'm' }, [`${f.type} · ${f.url}`]),
    ]),
    f.autoFixable ? el('span', { class: 'pill impact' }, ['auto-fixable']) : el('span', { class: 'pill effort' }, ['manual']),
    el('span', { class: 'impact-n num' }, [`+${f.predictedImpact}`]),
  ]);
}

export async function auditView(ctx: AppContext): Promise<HTMLElement> {
  // /audit is DB-backed (marks onboarding milestones), so it needs Postgres —
  // sample-only in pre-alpha. The findings shape is exactly @engine/diagnosis's.
  ctx.setBadge('sample');
  const d = MOCK_AUDIT;

  return el('div', {}, [
    el('div', { class: 'pagehead' }, [
      el('h1', {}, ['Technical audit']),
      el('p', { html: `Health score <b>${d.healthScore}</b> · <b>${d.autoFixableCount}</b> findings map to a one-click fix.` }),
    ]),
    el('section', { class: 'panel' }, [
      el('header', {}, [
        el('h3', {}, ['Findings']),
        el('span', { class: 'more' }, [`${d.findings.length} issues`]),
      ]),
      el('div', { class: 'flist' }, d.findings.map(findingRow)),
    ]),
  ]);
}
