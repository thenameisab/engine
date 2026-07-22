import { el } from '../dom.js';
import { fetchEntities, fetchLocalVisibility, runLocalAudit } from '../api.js';
import type { AppContext } from '../context.js';
import type { ApiEntity, LocalVisibility } from '../types.js';

/**
 * B5 Local SEO Audit (v1.5) view. Leads with each location's local visibility
 * score (spec §8), then breaks it into the three components — GBP completeness,
 * NAP consistency, review health — so an owner sees *why* a location scores
 * low, each of which maps to a GBP/citation fix in the Fix Queue. Weakest
 * locations first. A location is an entity; pick one and run its audit. Profile
 * facts are set via the API/GBP connector; running without them returns a clear
 * "no profile set" message rather than a fake score.
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

function visibilityCard(v: LocalVisibility): HTMLElement {
  return el('section', { class: 'panel eg-card' }, [
    el('header', {}, [
      el('h3', {}, [v.canonicalName]),
      el('span', { class: `eg-score ${scoreClass(v.score)} num` }, [pct(v.score)]),
    ]),
    el('div', { class: 'eg-comps' }, [
      bar('GBP completeness', v.components.gbpCompleteness),
      bar('NAP consistency', v.components.napConsistency),
      bar('Review health', v.components.reviewHealth),
    ]),
    el('div', { class: 'eg-foot num' }, [`${v.reviewsConsidered} review${v.reviewsConsidered === 1 ? '' : 's'} considered`]),
  ]);
}

export async function localView(ctx: AppContext): Promise<HTMLElement> {
  let entities: ApiEntity[] = [];
  let visibility: LocalVisibility[] = [];
  let loadError: string | null = null;
  try {
    [entities, visibility] = await Promise.all([fetchEntities(), fetchLocalVisibility()]);
  } catch (err) {
    loadError = (err as Error).message;
  }

  const select = el('select', { class: 'ci-select' }, entities.map((e) => el('option', { value: e.id }, [e.canonicalName]))) as HTMLSelectElement;
  const runBtn = el('button', { class: 'btn' }, ['Run local audit']);
  const listWrap = el('div', { class: 'eg-list' });

  function render(rows: LocalVisibility[]): void {
    listWrap.replaceChildren(
      rows.length === 0
        ? el('section', { class: 'panel' }, [el('div', { class: 'fq-note' }, ['No local audit has run yet. Set a location profile (via the GBP connector/API), then run one to score its local visibility.'])])
        : el('div', {}, rows.map(visibilityCard)),
    );
  }

  runBtn.addEventListener('click', async () => {
    if (!select.value) return;
    runBtn.setAttribute('disabled', 'true');
    runBtn.textContent = 'Running…';
    try {
      const res = await runLocalAudit(select.value);
      const others = visibility.filter((v) => v.entityId !== res.visibility.entityId);
      visibility = [...others, res.visibility].sort((a, b) => a.score - b.score);
      render(visibility);
      ctx.toast(`Local visibility ${pct(res.visibility.score)} · ${res.findingsCount} finding(s) → Audit`);
    } catch (err) {
      const msg = (err as Error).message;
      ctx.toast(msg.includes('409') ? 'No local profile set for this location yet.' : `Local audit failed: ${msg}`);
    } finally {
      runBtn.removeAttribute('disabled');
      runBtn.textContent = 'Run local audit';
    }
  });

  if (loadError) {
    listWrap.append(el('section', { class: 'panel' }, [el('div', { class: 'fq-note' }, [`Could not load local visibility: ${loadError}`])]));
  } else {
    render(visibility);
  }

  return el('div', {}, [
    el('div', { class: 'pagehead' }, [
      el('h1', {}, ['Local SEO']),
      el('p', {}, ['Is each location’s Google Business Profile complete, its NAP consistent across directories, and its reviews healthy? Score blends GBP completeness, NAP consistency, and review health.']),
      el('div', { class: 'ci-controls' }, [el('label', { class: 'ci-lbl' }, ['Location', select]), runBtn]),
    ]),
    listWrap,
  ]);
}
