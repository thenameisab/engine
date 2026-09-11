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
  /**
   * The model's total context window, in tokens.
   *
   * Declared on the model rather than decided per screen, because "which
   * models can run this surface" is a question about the model. Driver carries
   * a system prompt, a twenty-tool catalogue, several turns of history and
   * several tool results in one request; `sarvam-105b-conversations` at 32K
   * cannot hold that reliably, and the right fix is a surface that filters on
   * a declared number rather than a hardcoded list of which model suits which
   * screen. Decided 2026-09-10, driver scoping §9a decision 5.
   */
  contextTokens: number;
}

export const LLM_MODEL_CHOICES: readonly LlmModelChoice[] = [
  {
    id: 'sarvam-105b',
    engine: 'sarvam',
    label: 'Considered',
    byline: 'Works through the question before answering. The first words take a few seconds, and it can write a longer answer.',
    reasons: true,
    maxTokens: 16000,
    contextTokens: 128_000,
  },
  {
    id: 'sarvam-105b-conversations',
    engine: 'sarvam',
    label: 'Quick',
    byline: 'Starts answering straight away. No reasoning step, and a shorter maximum answer.',
    reasons: false,
    maxTokens: 8192,
    contextTokens: 32_000,
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

/**
 * The models with at least this much context, largest first.
 *
 * The filter §9a decision 5 asks for, at its first use. A surface states what
 * it needs and gets the models that can run it, so Driver never offers a 32K
 * model in the first place and no list of "which model suits which screen"
 * has to be maintained anywhere.
 */
export function llmModelsWithContext(minTokens: number): LlmModelChoice[] {
  return LLM_MODEL_CHOICES.filter((m) => m.contextTokens >= minTokens).slice().sort(
    (a, b) => b.contextTokens - a.contextTokens,
  );
}

/**
 * The surfaces that ask a model something live.
 *
 * Three today, and the list is here rather than in the dashboard because the
 * requirement each one places on a model is a fact about the request it makes,
 * not about the screen it is made from. §9a decision 5: "a model declares its
 * context size once and every surface filters on it" — this is the other half
 * of that sentence, the surface's side.
 *
 *   `prompt`  "Try a prompt" on AI answers. One prompt, verbatim, no history.
 *   `ask`     the command palette's question. One grounded answer, reworded.
 *   `driver`  the agent loop: a system prompt, a nineteen-tool catalogue,
 *             replayed history and several tool results in one request.
 */
export type ModelSurface = 'prompt' | 'ask' | 'driver';

export const MODEL_SURFACES: readonly ModelSurface[] = ['prompt', 'ask', 'driver'];

/**
 * What each surface needs from a model, in context tokens.
 *
 * Zero is not "no requirement stated" — it is the measured one. A single
 * prompt and a single grounded rewording both fit any model on the account, so
 * both offer every model and the customer's choice there is about waiting.
 * Driver is the one surface with a requirement that excludes a model, and the
 * number is the one `factory.ts` has always used.
 */
export const SURFACE_MIN_CONTEXT: Record<ModelSurface, number> = {
  prompt: 0,
  ask: 0,
  driver: 128_000,
};

/** The models that can run this surface, largest context first. */
export function modelsForSurface(surface: ModelSurface): LlmModelChoice[] {
  return llmModelsWithContext(SURFACE_MIN_CONTEXT[surface]);
}

/**
 * Which of `LLM_MODEL_CHOICES` each surface may offer, by id.
 *
 * The shape `GET /ai/models` sends, so the dashboard filters the one catalogue
 * it already has rather than fetching three. Ids rather than whole models
 * because the models are in the same response.
 */
export function modelIdsBySurface(): Record<ModelSurface, string[]> {
  return Object.fromEntries(
    MODEL_SURFACES.map((s) => [s, modelsForSurface(s).map((m) => m.id)]),
  ) as Record<ModelSurface, string[]>;
}
