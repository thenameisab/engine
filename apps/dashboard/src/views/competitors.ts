import { el } from '../dom.js';
import { auditLastRunLine } from '../format.js';
import {
  fetchEntities,
  fetchCompetitors,
  addCompetitor,
  removeCompetitor,
  fetchCompetitorGaps,
  runCompetitorAudit,
  type AuditLastRun,
} from '../api.js';
import type { AppContext } from '../context.js';
import type { ApiEntity, CompetitorGap, CompetitorRef, GapType } from '../types.js';

/**
 * A5 Competitor Intelligence view. Leads with "Biggest gaps to close" (the
 * ranked list, spec §8), then the gap tables grouped by dimension under a
 * shared self-entity picker. Both self and competitors are entities in the
 * entity-first model, so the competitor set is built by picking other tracked
 * entities. Running the analysis emits findings into the shared inventory, so
 * each gap is one click from a fix in the Fix Queue.
 */

const GAP_LABELS: Record<GapType, string> = {
  'keyword-gap': 'Keyword gaps',
  'citation-gap': 'Citation gaps',
  'content-gap': 'Content gaps',
  'entity-gap': 'Entity gaps',
  'backlink-gap': 'Backlink gaps',
};

const GAP_BLURB: Record<GapType, string> = {
  'keyword-gap': 'Keywords a competitor ranks for that you don’t.',
  'citation-gap': 'Prompts where AI answers cite a competitor and not you.',
  'content-gap': 'Topics/sources they cover that you don’t.',
  'entity-gap': 'Competitors whose brand search engines and AI understand better than yours.',
  'backlink-gap': 'Referring domains they have that you don’t.'
};

const ORDER: GapType[] = ['keyword-gap', 'citation-gap', 'content-gap', 'entity-gap', 'backlink-gap'];

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function impactClass(n: number): string {
  return n >= 0.66 ? 'bad' : n >= 0.33 ? 'warn' : 'good';
}

function leadRow(g: CompetitorGap): HTMLElement {
  return el('div', { class: 'ci-lead-row' }, [
    el('span', { class: `ci-tag ci-${g.type}` }, [GAP_LABELS[g.type].replace(' gaps', '')]),
    el('span', { class: 'ci-item' }, [g.item]),
    el('span', { class: 'ci-held num' }, [`${g.heldByCount} competitor${g.heldByCount === 1 ? '' : 's'}`]),
    el('span', { class: `ci-impact num ${impactClass(g.impact)}` }, [pct(g.impact)]),
  ]);
}

function gapTable(type: GapType, gaps: CompetitorGap[]): HTMLElement {
  const rows = gaps.filter((g) => g.type === type);
  return el('section', { class: 'panel ci-table' }, [
    el('header', {}, [el('h3', {}, [GAP_LABELS[type]]), el('span', { class: 'num muted' }, [String(rows.length)])]),
    el('p', { class: 'ci-blurb' }, [GAP_BLURB[type]]),
    rows.length === 0
      ? el('div', { class: 'fq-note' }, ['No gaps on this dimension.'])
      : el(
          'div',
          { class: 'ci-rows' },
          rows.slice(0, 12).map((g) =>
            el('div', { class: 'ci-row' }, [
              el('span', { class: 'ci-item' }, [g.item]),
              el('span', { class: 'ci-held num' }, [`×${g.heldByCount}`]),
              el('span', { class: `ci-impact num ${impactClass(g.impact)}` }, [pct(g.impact)]),
            ]),
          ),
        ),
  ]);
}

export async function competitorsView(ctx: AppContext): Promise<HTMLElement> {
  let entities: ApiEntity[] = [];
  let loadError: string | null = null;
  try {
    entities = await fetchEntities();
  } catch (err) {
    loadError = (err as Error).message;
  }

  const root = el('div', {});
  // The nightly pass re-runs this analysis for every self-entity that has a
  // competitor set, so the head says when it last did. Kept out of `head`'s
  // initial children because the early returns above render `head` alone.
  const lastRunLine = el('p', { class: 'lastrun' }, [auditLastRunLine(null)]);
  function setLastRun(run: AuditLastRun | null): void {
    lastRunLine.textContent = auditLastRunLine(run);
  }
  const head = el('div', { class: 'pagehead' }, [
    el('h1', {}, ['Competitor intelligence']),
    el('p', {}, ['Where do competitors beat you — across SEO and GEO — on one entity model? Pick your entity, name its competitors, then close the biggest gaps.']),
  ]);

  if (loadError) {
    root.append(head, el('section', { class: 'panel' }, [el('div', { class: 'fq-note' }, [`Could not load entities: ${loadError}`])]));
    return root;
  }
  if (entities.length < 2) {
    root.append(head, el('section', { class: 'panel' }, [el('div', { class: 'fq-note' }, ['Track at least two entities to compare — competitors are entities too.'])]));
    return root;
  }

  const selfSelect = el('select', { class: 'ci-select' }, entities.map((e) => el('option', { value: e.id }, [e.canonicalName]))) as HTMLSelectElement;
  const compSelect = el('select', { class: 'ci-select' }, []) as HTMLSelectElement;
  const addBtn = el('button', { class: 'btn ghost' }, ['Add competitor']);
  const runBtn = el('button', { class: 'btn' }, ['Run analysis']);
  const chips = el('div', { class: 'ci-chips' });
  const leadWrap = el('section', { class: 'panel ci-lead' });
  const tablesWrap = el('div', { class: 'ci-tables' });

  function selfId(): string {
    return selfSelect.value;
  }

  function refreshCompOptions(competitors: CompetitorRef[]): void {
    const taken = new Set([selfId(), ...competitors.map((c) => c.entityId)]);
    const opts = entities.filter((e) => !taken.has(e.id));
    compSelect.replaceChildren(...opts.map((e) => el('option', { value: e.id }, [e.canonicalName])));
    addBtn.toggleAttribute('disabled', opts.length === 0);
  }

  function renderChips(competitors: CompetitorRef[]): void {
    chips.replaceChildren(
      ...(competitors.length === 0
        ? [el('span', { class: 'muted' }, ['No competitors yet.'])]
        : competitors.map((c) => {
            const x = el('button', { class: 'ci-chip-x', title: 'Remove' }, ['×']);
            x.addEventListener('click', async () => {
              try {
                await removeCompetitor(selfId(), c.competitorSetId);
                await loadSet();
                ctx.toast(`Removed ${c.canonicalName}`);
              } catch (err) {
                ctx.toast(`Remove failed: ${(err as Error).message}`);
              }
            });
            return el('span', { class: 'ci-chip' }, [c.canonicalName, x]);
          })),
    );
  }

  function renderGaps(gaps: CompetitorGap[]): void {
    leadWrap.replaceChildren(
      el('header', {}, [el('h3', {}, ['Biggest gaps to close'])]),
      gaps.length === 0
        ? el('div', { class: 'fq-note' }, ['No analysis yet, or no gaps found. Add competitors and run the analysis.'])
        : el('div', { class: 'ci-lead-rows' }, gaps.slice(0, 8).map(leadRow)),
    );
    tablesWrap.replaceChildren(...ORDER.map((t) => gapTable(t, gaps)));
  }

  async function loadSet(): Promise<void> {
    let competitors: CompetitorRef[] = [];
    try {
      competitors = await fetchCompetitors(selfId());
    } catch (err) {
      ctx.toast(`Could not load competitors: ${(err as Error).message}`);
    }
    refreshCompOptions(competitors);
    renderChips(competitors);
    try {
      const { gaps, lastRun } = await fetchCompetitorGaps(selfId());
      renderGaps(gaps);
      setLastRun(lastRun);
    } catch {
      renderGaps([]);
    }
  }

  selfSelect.addEventListener('change', loadSet);

  addBtn.addEventListener('click', async () => {
    if (!compSelect.value) return;
    try {
      await addCompetitor(selfId(), compSelect.value);
      await loadSet();
    } catch (err) {
      ctx.toast(`Add failed: ${(err as Error).message}`);
    }
  });

  runBtn.addEventListener('click', async () => {
    runBtn.setAttribute('disabled', 'true');
    runBtn.textContent = 'Running…';
    try {
      const res = await runCompetitorAudit(selfId());
      renderGaps(res.gaps);
      setLastRun({ kind: 'competitor', trigger: 'manual', findingsCount: res.findingsCount, ranAt: new Date().toISOString() });
      ctx.toast(`Compared vs ${res.competitorsAudited} competitor(s) · ${res.findingsCount} finding(s) → Audit`);
    } catch (err) {
      ctx.toast(`Analysis failed: ${(err as Error).message}`);
    } finally {
      runBtn.removeAttribute('disabled');
      runBtn.textContent = 'Run analysis';
    }
  });

  head.append(
    lastRunLine,
    el('div', { class: 'ci-controls' }, [
      el('label', { class: 'ci-lbl' }, ['You', selfSelect]),
      el('label', { class: 'ci-lbl' }, ['Competitor', compSelect]),
      addBtn,
      runBtn,
    ]),
    chips,
  );
  root.append(head, leadWrap, tablesWrap);

  await loadSet();
  return root;
}
