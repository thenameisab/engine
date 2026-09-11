import { el } from '../dom.js';
import { fetchEntities, fetchLocalProfile, saveLocalProfile } from '../api.js';
import { readableError } from '../errors.js';
import type { AppContext } from '../context.js';

/**
 * The location facts a person can supply about their own business, and the
 * picker that says which location they are describing.
 *
 * This lives on Integrations, beside the Google Business Profile tile, rather
 * than on the Local screen where it started. Local is now hidden until either
 * a Business Profile connection or these facts exist, and a form that creates
 * the facts cannot sit behind a gate those same facts open. Integrations is
 * also where it belongs on its own terms: it is the second source for the same
 * document the GBP sync writes, so the two ways of answering "where is this
 * business" are one choice in one place.
 */

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
      // The first save is what makes Local reachable, so the toast says where
      // the customer just got to rather than only that a record was written.
      ctx.toast('Saved. Local is now on Visibility — run the audit there to score this location.');
      onSaved();
    } catch (err) {
      ctx.toast(readableError(err));
    } finally {
      save.removeAttribute('disabled');
    }
  });

  return el('div', { class: 'form' }, [
    el('label', { class: 'flabel' }, ['Business name']), name,
    el('label', { class: 'flabel' }, ['Address']), address,
    el('label', { class: 'flabel' }, ['Phone']), phone,
    el('label', { class: 'flabel' }, ['Categories (comma separated)']), categories,
    el('label', { class: 'flabel' }, ['Description']), description,
    el('label', { class: 'flabel check' }, [hoursSet, 'Opening hours are published']),
    el('div', { class: 'form-actions' }, [save]),
  ]);
}

/**
 * The whole section, for the Google Business Profile panel.
 *
 * Returns synchronously and fills itself, because the panel it mounts into is
 * built synchronously. `connected` only changes the wording: the form is
 * offered either way, so a customer whose sync has not run yet, or whose
 * Google listing is thinner than the truth, can still correct it by hand.
 */
export function locationDetailsSection(ctx: AppContext, connected: boolean): HTMLElement {
  const select = el('select', { class: 'ci-select' }, []) as HTMLSelectElement;
  const formWrap = el('div', {});
  const host = el('div', { class: 'intg-section' }, [
    el('div', { class: 'flabel' }, ['Location details']),
    el('p', { class: 'fhint' }, [
      connected
        ? 'Filled from Google Business Profile each sync. Editing here overwrites what the sync wrote, until the next sync.'
        : 'No Business Profile connection needed. Typed in here, the score covers the listing and its address consistency; review health is left unmeasured rather than counted as zero.',
    ]),
    el('label', { class: 'ci-lbl' }, ['Location', select]),
    formWrap,
  ]);

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

  void (async () => {
    const entities = await fetchEntities().catch(() => []);
    if (entities.length === 0) {
      // No brand, nothing to be local about. Said plainly rather than showing
      // an empty picker above a form that could not save.
      host.replaceChildren(
        el('div', { class: 'flabel' }, ['Location details']),
        el('div', { class: 'fhint' }, ['Add a brand for this site first — a location is a brand in Engine.']),
      );
      return;
    }
    select.replaceChildren(...entities.map((e) => el('option', { value: e.id }, [e.canonicalName])));
    await loadForm();
  })();

  return host;
}
