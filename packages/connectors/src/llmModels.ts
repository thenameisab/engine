/**
 * The models a customer may pick for a live answer.
 *
 * A closed list, not a free-text field, for two reasons. The vendor rejects an
 * unknown id with a 400 that names every valid one — leaking the account's
 * model inventory into a customer-visible error — and a model id chosen by the
 * caller is a request Engine pays for, so it belongs to the product's
 * vocabulary rather than the client's.
 *
 * Only the interactive surfaces read this. The scheduled poll that fills
 * `citation_events` stays on one fixed model on purpose: a citation band is a
 * measurement over time, and samples taken from different models are not
 * comparable — a bank whose model changed mid-window would report a movement
 * in the brand's AI visibility that was really a movement in the measuring
 * instrument.
 *
 * Every byline below is measured against the live vendor, not copied from
 * marketing. Two trials per model per prompt, 2026-09-09:
 *
 *   sarvam-105b                 reasoning starts 0.28-0.46s, answer starts
 *                               2.2-21.1s, 726-6,954 characters of reasoning,
 *                               finishes 7.5-110s.
 *   sarvam-105b-conversations   answer starts 0.44-0.63s, no reasoning ever
 *                               emitted, finishes 28-118s.
 *
 * The honest difference is **time to the first word**, not total time: the
 * conversational model is not faster to finish (it often writes more), it just
 * starts immediately because it does not think first. Neither byline claims a
 * quality difference, because none was measured. See the 2026-09-09 entry in
 * `working_log.md`.
 */
export interface LlmModelChoice {
  /** The vendor's model id, sent verbatim. */
  id: string;
  engine: 'sarvam';
  /** What the picker shows. */
  label: string;
  /** One line under the label, in the customer's terms. */
  byline: string;
  /**
   * Whether the model emits `reasoning_content` before its answer. Drives the
   * "thinking" state in the UI: a model that does not reason has no thinking
   * phase to show, and a spinner labelled "thinking" over a model that answers
   * immediately is a lie about what is happening.
   */
  reasons: boolean;
  /**
   * The vendor's own output ceiling for this model, sent as `max_tokens`.
   *
   * Per model rather than one constant because the vendor enforces different
   * ceilings and rejects the request outright when it is exceeded:
   * `sarvam-105b-conversations` answers a 16,000-token budget with
   * `400 max_tokens (16000) exceeds the maximum output length of 8192 tokens`.
   * A single shared default therefore makes one of the two models unusable.
   */
  maxTokens: number;
}

export const LLM_MODEL_CHOICES: readonly LlmModelChoice[] = [
  {
    id: 'sarvam-105b',
    engine: 'sarvam',
    label: 'Considered',
    byline: 'Works through the question before answering. The first words take a few seconds, and it can write a longer answer.',
    reasons: true,
    maxTokens: 16000,
  },
  {
    id: 'sarvam-105b-conversations',
    engine: 'sarvam',
    label: 'Quick',
    byline: 'Starts answering straight away. No reasoning step, and a shorter maximum answer.',
    reasons: false,
    maxTokens: 8192,
  },
];

/**
 * The model used when the caller names none.
 *
 * The conversational model, because it is the one the scheduled poll measures
 * with (`AI_POLL_MODEL` in apps/api, decided 2026-09-10: across three category
 * prompts it named companies in all three where the reasoning model named one
 * in one). A live "try a prompt" answer should come from the same instrument
 * as the stored band, or the picker shows a customer an answer their band was
 * never based on.
 */
export const DEFAULT_LLM_MODEL_ID = 'sarvam-105b-conversations';

export function isKnownLlmModel(id: string): boolean {
  return LLM_MODEL_CHOICES.some((m) => m.id === id);
}

export function llmModelChoice(id: string): LlmModelChoice | undefined {
  return LLM_MODEL_CHOICES.find((m) => m.id === id);
}
