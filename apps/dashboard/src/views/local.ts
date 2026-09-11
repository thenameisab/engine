import { el } from '../dom.js';
import { auditLastRunLine, screenName } from '../format.js';
import { fetchEntities, fetchLocalVisibility, runLocalAudit, type AuditLastRun } from '../api.js';
import { readableError } from '../errors.js';
import type { AppContext } from '../context.js';
import type { ApiEntity, LocalVisibility } from '../types.js';

/**
 * B5 Local SEO Audit (v1.5) view. Leads with each location's local visibility
 * score (spec §8), then breaks it into the three components — GBP completeness,
 * NAP consistency, review health — so an owner sees *why* a location scores
 * low, each of which maps to a GBP/citation fix in the Fix Queue. Weakest
 * locations first. A location is an entity; pick one and run its audit.
 *
 * Read-only about the facts themselves: they are set on Integrations, under
 * the Google Business Profile tile, either by connecting it or by typing them
 * in. This screen is reachable only once one of those has happened, so it does
 * not carry the form. Running against a location whose facts are missing still
 * returns a clear "no profile set" message rather than a fake score.
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
      // Null means nobody ever looked, and a 0%-wide bar would say the
      // opposite. The row still appears, so the reader can see the surface
      // exists and what would fill it.
      v.components.reviewHealth === null
        ? el('div', { class: 'eg-comp' }, [
            el('span', { class: 'eg-comp-k' }, ['Review health']),
            el('span', { class: 'eg-comp-unmeasured' }, ['not measured — connect Google Business Profile']),
          ])
        : bar('Review health', v.components.reviewHealth),
    ]),
    el('div', { class: 'eg-foot num' }, [
      v.components.reviewHealth === null
        ? 'Score covers the listing and its address consistency only.'
        : `${v.reviewsConsidered} review${v.reviewsConsidered === 1 ? '' : 's'} considered`,
    ]),
  ]);
}

export async function localView(ctx: AppContext): Promise<HTMLElement> {
  let entities: ApiEntity[] = [];
  let visibility: LocalVisibility[] = [];
  let lastRun: AuditLastRun | null = null;
  let loadError: string | null = null;
  try {
    const [fetchedEntities, local] = await Promise.all([fetchEntities(), fetchLocalVisibility()]);
    entities = fetchedEntities;
    visibility = local.visibility;
    lastRun = local.lastRun;
  } catch (err) {
    loadError = (err as Error).message;
  }

  const select = el('select', { class: 'ci-select' }, entities.map((e) => el('option', { value: e.id }, [e.canonicalName]))) as HTMLSelectElement;
  const runBtn = el('button', { class: 'btn' }, ['Run local audit']);
  const listWrap = el('div', { class: 'eg-list' });
  const lastRunLine = el('p', { class: 'lastrun' }, [auditLastRunLine(lastRun)]);

  function render(rows: LocalVisibility[]): void {
    listWrap.replaceChildren(
      rows.length === 0
        ? el('section', { class: 'panel' }, [el('div', { class: 'fq-note' }, [
              'No location scored yet. Run the audit — the nightly pass keeps it current from then on. Location details are on Integrations, under Google Business Profile.',
            ])])
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
      lastRunLine.textContent = auditLastRunLine({
        trigger: 'manual',
        findingsCount: res.findingsCount,
        ranAt: new Date().toISOString(),
      });
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

  // No brand, nothing to be local about. Said plainly rather than showing a
  // form with an empty picker above it.
  if (!loadError && entities.length === 0) {
    return el('div', {}, [
      el('div', { class: 'pagehead' }, [el('h1', {}, [screenName('local')])]),
      el('section', { class: 'panel' }, [
        el('div', { class: 'fq-note' }, ['Add a brand for this site first — a location is a brand in Engine.']),
      ]),
    ]);
  }

  return el('div', {}, [
    el('div', { class: 'pagehead' }, [
      el('h1', {}, [screenName('local')]),
      el('p', {}, ['Is each location’s Google Business Profile complete, its NAP consistent across directories, and its reviews healthy? Score blends GBP completeness, NAP consistency, and review health.']),
      lastRunLine,
      el('div', { class: 'ci-controls' }, [el('label', { class: 'ci-lbl' }, ['Location', select]), runBtn]),
    ]),
    listWrap,
  ]);
}
