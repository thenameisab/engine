import { el } from './dom.js';
import { getAiModel, modelsFor, setAiModel } from './api.js';
import type { AiModels, LlmModelChoice, ModelSurface } from './types.js';

/**
 * The model picker, shared by the three surfaces that ask a model something
 * live — "Try a prompt" on AI answers, the command palette's question, and
 * Driver.
 *
 * One component and one remembered choice *per surface*, which is the change
 * §9a decision 5 forced. The old rule was that the choice is one choice: "a
 * person who picked the quick model to ask a question means it on the other
 * screen too." That is true of the two one-shot surfaces and false of Driver,
 * which carries a system prompt, a nineteen-tool catalogue, replayed history
 * and several tool results in one request and cannot run a 32K model at all.
 *
 * So the surface states what it needs, a model declares its context window
 * once, and the server filters — Driver never offers a model it cannot run in
 * the first place, and no list of "which model suits which screen" has to be
 * maintained anywhere. `catalogue.surfaces` is that answer; `modelsFor` reads
 * it.
 *
 * Settings owns the default for each surface and is where a customer sees what
 * is on offer. This control is seeded from that default and overrides it for
 * the question being asked, which is why it stays next to the input: the
 * difference between these models is tens of seconds of waiting, and a choice
 * about waiting belongs where the waiting starts.
 *
 * The byline sits under the control, always visible, rather than in a tooltip
 * or only on the open dropdown, for the same reason.
 */
export interface ModelPicker {
  /** The control, ready to append. */
  root: HTMLElement;
  /** The chosen model id, or undefined when this surface offers none. */
  current(): string | undefined;
  /** Whether the chosen model thinks before it answers. */
  reasons(): boolean;
}

/** A picker over the models `surface` can run, or an inert one when it can run none. */
export function modelPicker(catalogue: AiModels | null, surface: ModelSurface): ModelPicker {
  const models = modelsFor(catalogue, surface);
  if (models.length === 0) {
    // Nothing to choose between. An empty select is worse than no select, and
    // one model is not a choice either — a surface like Driver, which today
    // has exactly one model big enough for it, shows the byline through
    // Settings rather than a select with one option.
    return { root: el('span', { class: 'mp-none' }), current: () => undefined, reasons: () => false };
  }

  // The remembered pick, unless it is no longer offered — a model can leave
  // the catalogue when a key changes, and can leave *this surface's* list
  // without leaving the catalogue. A stale id would be refused by the route
  // with "unknown model" on every ask.
  const remembered = getAiModel(surface);
  const initial = models.find((m) => m.id === remembered)
    ?? models.find((m) => m.id === catalogue?.defaultModel)
    ?? models[0];

  const select = el('select', { class: 'field mp-select', 'aria-label': 'Model' },
    models.map((m) => el('option', { value: m.id }, [m.label]))) as HTMLSelectElement;
  select.value = initial.id;

  const byline = el('div', { class: 'mp-byline num' });
  const chosen = (): LlmModelChoice => models.find((m) => m.id === select.value) ?? initial;

  const paint = (): void => {
    byline.textContent = chosen().byline;
  };
  paint();

  select.addEventListener('change', () => {
    setAiModel(surface, select.value);
    paint();
  });

  return {
    root: el('div', { class: 'mp' }, [
      el('label', { class: 'mp-lbl' }, [el('span', { class: 'label' }, ['Model']), select]),
      byline,
    ]),
    current: () => select.value,
    reasons: () => chosen().reasons,
  };
}

/**
 * One model's label and byline, without a control.
 *
 * For a surface with exactly one model it can run. A select with one option is
 * a control that cannot be used, and hiding the model entirely leaves a
 * customer unable to answer "which model answered this" — which §8's trust
 * paragraph says Driver must always be able to say.
 */
export function modelByline(catalogue: AiModels | null, surface: ModelSurface): HTMLElement | null {
  const models = modelsFor(catalogue, surface);
  if (models.length !== 1) return null;
  const only = models[0];
  return el('div', { class: 'mp' }, [
    el('div', { class: 'mp-one' }, [el('span', { class: 'label' }, ['Model']), el('b', {}, [only.label])]),
    el('div', { class: 'mp-byline num' }, [only.byline]),
  ]);
}
