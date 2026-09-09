/**
 * Build connectors from a plain env record, gracefully degrading when a
 * provider's key is absent. The API layer (apps/api) uses this so a missing
 * key means "that engine is off", never a crash — matching the readiness
 * posture in @engine/config.
 */
import type { SerpConnector } from './serp.js';
import type { LlmEngineConnector } from './llmEngine.js';
import { SerperConnector } from './serpSerper.js';
import { OpenAIConnector } from './llmOpenAI.js';
import { GeminiConnector } from './llmGemini.js';
import { SarvamConnector } from './llmSarvam.js';

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
    connectors.push(new SarvamConnector({ apiKey: env.SARVAM_API_KEY, model: env.SARVAM_MODEL }));
  }
  return connectors;
}
