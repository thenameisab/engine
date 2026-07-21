import { el } from '../dom.js';
import { fetchAudit, fetchDeployTarget, proposeFix } from '../api.js';
import type { AppContext } from '../context.js';
import type { AuditData, DeployTarget, FindingRow } from '../types.js';

/**
 * One finding row. An auto-fixable finding gets a "Propose fix" button that
 * asks the API to generate the fix and drop it into the Fix Queue — the step
 * that used to be API-only. Disabled until the project has a deploy target
 * (where a fix would land), since the generator needs one.
 */
function findingRow(f: FindingRow, hasTarget: boolean, ctx: AppContext): HTMLElement {
  const right: (HTMLElement | null)[] = [
    f.autoFixable ? el('span', { class: 'pill impact' }, ['auto-fixable']) : el('span', { class: 'pill effort' }, ['manual']),
    el('span', { class: 'impact-n num' }, [`+${f.predictedImpact}`]),
  ];

  if (f.autoFixable) {
    const btn = el('button', {
      class: 'card-act',
      ...(hasTarget ? {} : { disabled: 'true', title: 'Set a deploy target in Settings first' }),
      onclick: async (e: Event) => {
        e.stopPropagation();
        btn.setAttribute('disabled', 'true');
        btn.textContent = 'Proposing…';
        try {
          const { actions, note } = await proposeFix(f.id);
          if (actions.length === 0) {
            ctx.toast(note ?? 'No fix could be generated for this finding.');
            btn.removeAttribute('disabled');
            btn.textContent = 'Propose fix';
            return;
          }
          ctx.toast(`Proposed ${actions.length} fix${actions.length === 1 ? '' : 'es'} → Fix Queue`);
          btn.textContent = 'Proposed ✓';
        } catch (err) {
          ctx.toast(`Propose failed: ${(err as Error).message}`);
          btn.removeAttribute('disabled');
          btn.textContent = 'Propose fix';
        }
      },
    }, ['Propose fix']);
    right.push(btn);
  }

  return el('div', { class: 'frow' }, [
    el('span', { class: `sev ${f.severity}` }, [f.severity]),
    el('div', { class: 'fmain' }, [
      el('div', { class: 't' }, [f.title]),
      el('div', { class: 'm' }, [f.url ? `${f.type} · ${f.url}` : f.type]),
    ]),
    ...right,
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

export async function auditView(ctx: AppContext): Promise<HTMLElement> {
  let data: AuditData | null = null;
  let loadError: string | null = null;
  let target: DeployTarget | null = null;
  try {
    // The target is best-effort: a failure here (or none set) just disables the
    // Propose buttons, it does not block showing the audit.
    [data, target] = await Promise.all([fetchAudit(), fetchDeployTarget().catch(() => null)]);
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
  const hasTarget = target !== null;
  return el('div', {}, [
    el('div', { class: 'pagehead' }, [el('h1', {}, ['Technical audit']), summary(d)]),
    hasTarget
      ? null
      : el('section', { class: 'panel' }, [
          el('div', { class: 'fq-note' }, [
            'Set a deploy target in Settings to turn auto-fixable findings into proposed fixes.',
          ]),
        ]),
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
        : el('div', { class: 'flist' }, d.findings.map((f) => findingRow(f, hasTarget, ctx))),
    ]),
  ]);
}
