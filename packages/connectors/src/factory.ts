/**
 * Build connectors from a plain env record, gracefully degrading when a
 * provider's key is absent. The API layer (apps/api) uses this so a missing
 * key means "that engine is off", never a crash — matching the readiness
 * posture in @engine/config.
 */
import type { SerpConnector } from './serp.js';
import type { LlmEngineConnector } from './llmEngine.js';
import type { LlmStreamingConnector } from './llmStream.js';
import type { LlmConversationalConnector } from './llmTools.js';
import { SerperConnector } from './serpSerper.js';
import { OpenAIConnector } from './llmOpenAI.js';
import { GeminiConnector } from './llmGemini.js';
import { SarvamConnector } from './llmSarvam.js';
import { SURFACE_MIN_CONTEXT, llmModelChoice, llmModelsWithContext } from './llmModels.js';

type EnvRecord = Record<string, string | undefined>;

/**
 * Instantiate the configured SERP connector, or null if none is wired.
 * `SERP_PROVIDER` selects the vendor (default 'serper').
 */
export function createSerpConnector(env: EnvRecord): SerpConnector | null {
  const provider = env.SERP_PROVIDER ?? 'serper';
  if (provider === 'serper') {
    if (!env.SERPER_API_KEY) return null;
    return new SerperConnector({ apiKey: env.SERPER_API_KEY });
  }
  // 'dataforseo' / 'serpapi' adapters are not built yet — the interface reserves
  // them as switch targets. Returning null keeps this honest until they exist.
  return null;
}

/** Instantiate every LLM engine whose key is present (A2 polls across engines). */
export function createLlmConnectors(env: EnvRecord): LlmEngineConnector[] {
  const connectors: LlmEngineConnector[] = [];
  if (env.OPENAI_API_KEY) {
    connectors.push(new OpenAIConnector({ apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL }));
  }
  if (env.GEMINI_API_KEY) {
    connectors.push(new GeminiConnector({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL }));
  }
  if (env.SARVAM_API_KEY) {
    // Each Sarvam model carries its own vendor ceiling: the conversational
    // model refuses a 16,000-token budget outright (400, not a truncated
    // answer). The ceiling travels with the model choice, as it does for the
    // streaming connector below.
    const choice = env.SARVAM_MODEL ? llmModelChoice(env.SARVAM_MODEL) : undefined;
    connectors.push(
      new SarvamConnector({
        apiKey: env.SARVAM_API_KEY,
        model: env.SARVAM_MODEL,
        ...(choice ? { maxTokens: choice.maxTokens } : {}),
      }),
    );
  }
  return connectors;
}

/**
 * The engine used for streamed, interactive answers, or null if none is wired.
 *
 * Separate from `createLlmConnectors` because the two answer different
 * questions. That one returns *every* configured engine, because an AI
 * visibility measurement is only meaningful across engines. A person waiting
 * on a streamed answer wants one answer, from whichever engine this deployment
 * can actually stream — and of the three adapters only Sarvam implements
 * `stream`, since it is the one this deployment has credit on.
 */
export function createStreamingLlmConnector(env: EnvRecord, model?: string): LlmStreamingConnector | null {
  if (env.SARVAM_API_KEY) {
    // `model` is the customer's pick, already checked against
    // `LLM_MODEL_CHOICES` by the caller — an unvalidated id must never reach
    // the vendor, whose 400 names every model on the account. `SARVAM_MODEL`
    // remains the deployment-level override for when no pick was made.
    const id = model ?? env.SARVAM_MODEL;
    const choice = id ? llmModelChoice(id) : undefined;
    return new SarvamConnector({
      apiKey: env.SARVAM_API_KEY,
      model: id,
      // Each model carries its own vendor ceiling; exceeding it is a 400, not
      // a truncated answer.
      ...(choice ? { maxTokens: choice.maxTokens } : {}),
    });
  }
  return null;
}

/**
 * The smallest context window a Driver turn is expected to fit in.
 *
 * A system prompt, a nineteen-tool catalogue, several turns of history and
 * several tool results in one request. 32K does not hold that reliably, so the
 * requirement is stated and the model is chosen against it — see driver
 * scoping §2 and §9a decision 5.
 *
 * Re-exported from `SURFACE_MIN_CONTEXT` rather than declared twice. Settings
 * now lists, per surface, the models that can run it, and the list a customer
 * reads has to be the same number the connector enforces — otherwise Settings
 * offers a model the loop then refuses.
 */
export const DRIVER_MIN_CONTEXT_TOKENS = SURFACE_MIN_CONTEXT.driver;

/**
 * The engine used for a tool-calling conversation, or null if none is wired.
 *
 * A third factory beside the other two because it answers a third question.
 * `createLlmConnectors` returns every configured engine, because a visibility
 * measurement is only meaningful across engines. `createStreamingLlmConnector`
 * returns the customer's picked model for a one-shot answer. This one takes
 * the surface's requirement first and the customer's pick second, in that
 * order and never the other way round: a model too small for the catalogue
 * does not fail with a shorter answer, it fails mid-conversation.
 *
 * `model` is the customer's pick from Settings, and it is honoured only if it
 * clears `minContextTokens`. §9a decision 5 put the choice in the customer's
 * hands *within* what the surface can run — which is why the filter is applied
 * before the pick is consulted rather than after. `SARVAM_MODEL` is still
 * ignored here: that override names the citation poll's instrument, which is
 * the 32K conversational model.
 */
export function createConversationalLlmConnector(
  env: EnvRecord,
  minContextTokens = DRIVER_MIN_CONTEXT_TOKENS,
  model?: string,
): LlmConversationalConnector | null {
  if (!env.SARVAM_API_KEY) return null;
  const eligible = llmModelsWithContext(minContextTokens).filter((m) => m.engine === 'sarvam');
  const choice = eligible.find((m) => m.id === model) ?? eligible[0];
  if (!choice) return null;
  return new SarvamConnector({ apiKey: env.SARVAM_API_KEY, model: choice.id, maxTokens: choice.maxTokens });
}
