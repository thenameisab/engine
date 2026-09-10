import { el } from '../dom.js';
import { auditLastRunLine } from '../format.js';
import { fetchEntityStrengths, runEntityAudit, type AuditLastRun } from '../api.js';
import type { AppContext } from '../context.js';
import type { EntityStrength } from '../types.js';

/**
 * B3 Entity & Knowledge Graph Audit view. Leads with each entity's
 * strength/corroboration score (spec §8), then breaks it into the four
 * components so an owner sees *why* an entity is weak — missing Wikidata
 * mapping, no on-site entity schema, inconsistent sameAs, or thin cross-web
 * corroboration — each of which maps to a fix in the Fix Queue. Weakest
 * entities first: those are the ones search + AI understand least.
 */

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function scoreClass(n: number): string {
  return n >= 0.75 ? 'good' : n >= 0.5 ? 'warn' : 'bad';
}

function bar(label: string, value: number): HTMLElement {
  return el('div', { class: 'eg-comp' }, [
    el('span', { class: 'eg-comp-k' }, [label]),
    el('span', { class: 'eg-comp-track' }, [
      el('span', { class: `eg-comp-fill ${scoreClass(value)}`, style: `width:${Math.round(value * 100)}%` }),
    ]),
    el('span', { class: 'eg-comp-v num' }, [pct(value)]),
  ]);
}

function strengthCard(s: EntityStrength): HTMLElement {
  return el('section', { class: 'panel eg-card' }, [
    el('header', {}, [
      el('h3', {}, [s.canonicalName]),
      el('span', { class: `eg-score ${scoreClass(s.score)} num` }, [pct(s.score)]),
    ]),
    el('div', { class: 'eg-comps' }, [
      bar('Wikidata mapping', s.components.wikidata),
      bar('On-site entity schema', s.components.schema),
      bar('sameAs consistency', s.components.sameAsConsistency),
      bar('Cross-web corroboration', s.components.corroboration),
    ]),
    el('div', { class: 'eg-foot num' }, [
      `${s.corroboratingDomains} corroborating source domain${s.corroboratingDomains === 1 ? '' : 's'}`,
    ]),
  ]);
}

export async function entityGraphView(ctx: AppContext): Promise<HTMLElement> {
  let strengths: EntityStrength[] = [];
  let lastRun: AuditLastRun | null = null;
  let loadError: string | null = null;
  try {
    ({ strengths, lastRun } = await fetchEntityStrengths());
  } catch (err) {
    loadError = (err as Error).message;
  }

  const runBtn = el('button', { class: 'btn' }, ['Run entity audit']);
  const listWrap = el('div', { class: 'eg-list' });
  // This audit follows every crawl, so the screen has to say when it last did:
  // without the line, a clean result and an audit nobody ever ran look alike.
  const lastRunLine = el('p', { class: 'lastrun' }, [auditLastRunLine(lastRun)]);

  function render(rows: EntityStrength[]): void {
    listWrap.replaceChildren(
      rows.length === 0
        ? el('section', { class: 'panel' }, [
            el('div', { class: 'fq-note' }, [
              'Nothing to score yet. This audit runs by itself after every crawl — run one now if you would rather not wait.',
            ]),
          ])
        : el('div', {}, rows.map(strengthCard)),
    );
  }

  runBtn.addEventListener('click', async () => {
    runBtn.setAttribute('disabled', 'true');
    runBtn.textContent = 'Running…';
    try {
      const res = await runEntityAudit();
      render(res.strengths.slice().sort((a, b) => a.score - b.score));
      lastRunLine.textContent = auditLastRunLine({
        trigger: 'manual',
        findingsCount: res.findingsCount,
        ranAt: new Date().toISOString(),
      });
      ctx.toast(`Audited ${res.entitiesAudited} entit${res.entitiesAudited === 1 ? 'y' : 'ies'} · ${res.findingsCount} finding(s) → Audit`);
    } catch (err) {
      ctx.toast(`Entity audit failed: ${(err as Error).message}`);
    } finally {
      runBtn.removeAttribute('disabled');
      runBtn.textContent = 'Run entity audit';
    }
  });

  if (loadError) {
    listWrap.append(
      el('section', { class: 'panel' }, [el('div', { class: 'fq-note' }, [`Could not load entity strengths: ${loadError}`])]),
    );
  } else {
    render(strengths);
  }

  return el('div', {}, [
    el('div', { class: 'pagehead' }, [
      el('h1', {}, ['Entity graph']),
      el('p', {}, ['Do search and AI understand who each entity is? Strength blends Wikidata mapping, on-site schema, sameAs consistency, and cross-web corroboration.']),
      lastRunLine,
      runBtn,
    ]),
    listWrap,
  ]);
}
