import { el } from '../dom.js';
import { fetchEntities, fetchCitationOpportunities, runOffsiteAudit } from '../api.js';
import type { AppContext } from '../context.js';
import type { ApiEntity, CitationOpportunity } from '../types.js';

/**
 * A6 Backlink & Mention Index (v1.5) view. Leads with "Citation opportunities"
 * (spec §8) — the domains AI engines cite in the customer's category where the
 * entity is absent, mined from the A2 answer archive. Each opportunity is a
 * digital-PR target (C6); running the audit emits findings into the shared
 * inventory, so each is one step from the Fix Queue. Off-site signal is unified
 * under the entity, not shown as a disconnected link/mention world.
 */

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function authorityClass(n: number): string {
  return n >= 0.66 ? 'good' : n >= 0.4 ? 'warn' : 'bad';
}

function opportunityRow(o: CitationOpportunity): HTMLElement {
  return el('div', { class: 'off-row' }, [
    el('span', { class: 'off-domain' }, [o.domain]),
    el('span', { class: 'off-meta num' }, [`cited ${o.citationCount}× · ${o.distinctEntities} peer${o.distinctEntities === 1 ? '' : 's'}`]),
    el('span', { class: `off-auth num ${authorityClass(o.authority)}`, title: 'Category authority' }, [pct(o.authority)]),
  ]);
}

export async function offsiteView(ctx: AppContext): Promise<HTMLElement> {
  let entities: ApiEntity[] = [];
  let loadError: string | null = null;
  try {
    entities = await fetchEntities();
  } catch (err) {
    loadError = (err as Error).message;
  }

  const root = el('div', {});
  const head = el('div', { class: 'pagehead' }, [
    el('h1', {}, ['Backlink & mentions']),
    el('p', {}, ['Which domains do AI engines cite in your category — and which of them are missing you? Citation opportunities are your highest-leverage digital-PR targets.']),
  ]);

  if (loadError) {
    root.append(head, el('section', { class: 'panel' }, [el('div', { class: 'fq-note' }, [`Could not load entities: ${loadError}`])]));
    return root;
  }
  if (entities.length === 0) {
    root.append(head, el('section', { class: 'panel' }, [el('div', { class: 'fq-note' }, ['Track an entity first — off-site signal is unified under the entity.'])]));
    return root;
  }

  const selfSelect = el('select', { class: 'ci-select' }, entities.map((e) => el('option', { value: e.id }, [e.canonicalName]))) as HTMLSelectElement;
  const runBtn = el('button', { class: 'btn' }, ['Run off-site audit']);
  const leadWrap = el('section', { class: 'panel off-lead' });

  function renderOpps(opps: CitationOpportunity[]): void {
    leadWrap.replaceChildren(
      el('header', {}, [el('h3', {}, ['Citation opportunities']), el('span', { class: 'num muted' }, [String(opps.length)])]),
      opps.length === 0
        ? el('div', { class: 'fq-note' }, ['No analysis yet, or no gaps found. Run the off-site audit to mine the AI citation archive.'])
        : el('div', { class: 'off-rows' }, opps.slice(0, 20).map(opportunityRow)),
    );
  }

  async function load(): Promise<void> {
    try {
      renderOpps(await fetchCitationOpportunities(selfSelect.value));
    } catch {
      renderOpps([]);
    }
  }

  selfSelect.addEventListener('change', load);

  runBtn.addEventListener('click', async () => {
    runBtn.setAttribute('disabled', 'true');
    runBtn.textContent = 'Running…';
    try {
      const res = await runOffsiteAudit(selfSelect.value);
      renderOpps(res.opportunities);
      ctx.toast(`Analyzed ${res.observationsAnalyzed} citation(s) across ${res.categorySize} entit${res.categorySize === 1 ? 'y' : 'ies'} · ${res.findingsCount} finding(s) → Audit`);
    } catch (err) {
      ctx.toast(`Off-site audit failed: ${(err as Error).message}`);
    } finally {
      runBtn.removeAttribute('disabled');
      runBtn.textContent = 'Run off-site audit';
    }
  });

  head.append(
    el('div', { class: 'ci-controls' }, [el('label', { class: 'ci-lbl' }, ['Entity', selfSelect]), runBtn]),
  );
  root.append(head, leadWrap);

  await load();
  return root;
}
