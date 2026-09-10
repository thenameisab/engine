import { el } from '../dom.js';
import { auditLastRunLine } from '../format.js';
import { fetchEntities, fetchLocalProfile, fetchLocalVisibility, runLocalAudit, saveLocalProfile, type AuditLastRun } from '../api.js';
import { readableError } from '../errors.js';
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

/**
 * The facts a person can actually supply about their own location.
 *
 * Reviews and directory listings are deliberately absent: nobody types their
 * review history or every directory they appear in, and a form that asked for
 * them would be abandoned. What is typed here is marked as not having sourced
 * reviews, so the score is renormalized rather than penalised for the gap.
 */
function profileForm(
  ctx: AppContext,
  entityId: string,
  existing: Record<string, unknown> | null,
  onSaved: () => void,
): HTMLElement {
  const str = (k: string): string => (typeof existing?.[k] === 'string' ? (existing[k] as string) : '');
  const name = el('input', { class: 'field', type: 'text', value: str('name'), placeholder: 'Bright Smile Dental' }) as HTMLInputElement;
  const address = el('input', { class: 'field', type: 'text', value: str('address'), placeholder: '12 High Street, Leeds, LS1 4DA' }) as HTMLInputElement;
  const phone = el('input', { class: 'field', type: 'text', value: str('phone'), placeholder: '+44 113 496 0000' }) as HTMLInputElement;
  const categories = el('input', {
    class: 'field',
    type: 'text',
    value: Array.isArray(existing?.categories) ? (existing.categories as string[]).join(', ') : '',
    placeholder: 'Dentist, Cosmetic dentist',
  }) as HTMLInputElement;
  const description = el('textarea', { class: 'field', rows: '3', placeholder: 'What this location does, in a sentence or two.' }) as HTMLTextAreaElement;
  description.value = str('description');
  const hoursSet = el('input', { type: 'checkbox' }) as HTMLInputElement;
  hoursSet.checked = existing?.hoursSet === true;

  const save = el('button', { class: 'btn primary' }, ['Save location details']);
  save.addEventListener('click', async () => {
    if (!name.value.trim() || !address.value.trim()) {
      ctx.toast('A name and an address are the two facts the audit cannot work without.');
      return;
    }
    save.setAttribute('disabled', 'true');
    try {
      await saveLocalProfile(entityId, {
        name: name.value.trim(),
        address: address.value.trim(),
        phone: phone.value.trim(),
        categories: categories.value.split(',').map((c) => c.trim()).filter(Boolean),
        hoursSet: hoursSet.checked,
        attributes: Array.isArray(existing?.attributes) ? existing.attributes : [],
        photoCount: typeof existing?.photoCount === 'number' ? existing.photoCount : 0,
        description: description.value.trim() || null,
        // Kept from a previous Google sync if there was one; never invented.
        directoryListings: Array.isArray(existing?.directoryListings) ? existing.directoryListings : [],
        reviews: Array.isArray(existing?.reviews) ? existing.reviews : [],
        // The whole point of the flag: a person cannot type a review history,
        // so an empty list here means unknown, not none.
        reviewsSourced: Array.isArray(existing?.reviews) && (existing.reviews as unknown[]).length > 0,
      });
      ctx.toast('Saved. Run the audit to score this location.');
      onSaved();
    } catch (err) {
      ctx.toast(readableError(err));
    } finally {
      save.removeAttribute('disabled');
    }
  });

  return el('section', { class: 'panel' }, [
    el('h3', {}, ['Location details']),
    el('p', { class: 'fq-note' }, [
      'Connect Google Business Profile on Integrations to fill these automatically, including reviews. Typed in here, the score covers the listing and its address consistency; review health is left unmeasured rather than counted as zero.',
    ]),
    el('div', { class: 'form' }, [
      el('label', { class: 'flabel' }, ['Business name']), name,
      el('label', { class: 'flabel' }, ['Address']), address,
      el('label', { class: 'flabel' }, ['Phone']), phone,
      el('label', { class: 'flabel' }, ['Categories (comma separated)']), categories,
      el('label', { class: 'flabel' }, ['Description']), description,
      el('label', { class: 'flabel check' }, [hoursSet, 'Opening hours are published']),
      el('div', { class: 'form-actions' }, [save]),
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
  const formWrap = el('div', {});

  // The form follows whichever location is selected, and shows what is already
  // there so a Google-synced profile can be corrected rather than retyped.
  async function loadForm(): Promise<void> {
    if (!select.value) {
      formWrap.replaceChildren();
      return;
    }
    const entityId = select.value;
    const existing = await fetchLocalProfile(entityId).catch(() => null);
    formWrap.replaceChildren(profileForm(ctx, entityId, existing, () => void loadForm()));
  }
  select.addEventListener('change', () => void loadForm());

  function render(rows: LocalVisibility[]): void {
    listWrap.replaceChildren(
      rows.length === 0
        ? el('section', { class: 'panel' }, [el('div', { class: 'fq-note' }, [
              'No location scored yet. Fill in the details below, or connect Google Business Profile, then run the audit — the nightly pass keeps it current from then on.',
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
    void loadForm();
  }

  // No brand, nothing to be local about. Said plainly rather than showing a
  // form with an empty picker above it.
  if (!loadError && entities.length === 0) {
    return el('div', {}, [
      el('div', { class: 'pagehead' }, [el('h1', {}, ['Local SEO'])]),
      el('section', { class: 'panel' }, [
        el('div', { class: 'fq-note' }, ['Add a brand for this site first — a location is a brand in Engine.']),
      ]),
    ]);
  }

  return el('div', {}, [
    el('div', { class: 'pagehead' }, [
      el('h1', {}, ['Local SEO']),
      el('p', {}, ['Is each location’s Google Business Profile complete, its NAP consistent across directories, and its reviews healthy? Score blends GBP completeness, NAP consistency, and review health.']),
      lastRunLine,
      el('div', { class: 'ci-controls' }, [el('label', { class: 'ci-lbl' }, ['Location', select]), runBtn]),
    ]),
    listWrap,
    formWrap,
  ]);
}
