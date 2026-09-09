import { el } from './dom.js';
import { getAiModel, setAiModel } from './api.js';
import type { AiModels, LlmModelChoice } from './types.js';

/**
 * The model picker, shared by the two surfaces that ask a model something
 * live — "Try a prompt" on AI answers and the Ask Engine bar.
 *
 * One component rather than two because the choice is one choice: a person who
 * picked the quick model to ask a question means it on the other screen too,
 * which is why the selection is remembered rather than reset per panel.
 *
 * The byline sits under the control, always visible, rather than in a tooltip
 * or only on the open dropdown. The difference between these models is tens of
 * seconds of waiting, so it has to be readable before the choice is made, not
 * after.
 */
export interface ModelPicker {
  /** The control, ready to append. */
  root: HTMLElement;
  /** The chosen model id, or undefined when this deployment offers none. */
  current(): string | undefined;
  /** Whether the chosen model thinks before it answers. */
  reasons(): boolean;
}

/** A picker over `models`, or an inert one when the deployment offers none. */
export function modelPicker(catalogue: AiModels | null): ModelPicker {
  const models = catalogue?.models ?? [];
  if (models.length === 0) {
    // Nothing to choose between. An empty select is worse than no select.
    return { root: el('span', { class: 'mp-none' }), current: () => undefined, reasons: () => false };
  }

  // The remembered pick, unless it is no longer offered — a model can leave
  // the catalogue when a key changes, and a stale id would be refused by the
  // route with "unknown model" on every ask.
  const remembered = getAiModel();
  const initial = models.find((m) => m.id === remembered)
    ?? models.find((m) => m.id === catalogue?.defaultModel)
    ?? models[0];

  const select = el('select', { class: 'field mp-select' },
    models.map((m) => el('option', { value: m.id }, [m.label]))) as HTMLSelectElement;
  select.value = initial.id;

  const byline = el('div', { class: 'mp-byline num' });
  const chosen = (): LlmModelChoice => models.find((m) => m.id === select.value) ?? initial;

  const paint = (): void => {
    byline.textContent = chosen().byline;
  };
  paint();

  select.addEventListener('change', () => {
    setAiModel(select.value);
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
