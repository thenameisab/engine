import type { CopilotAnswer } from './types.js';

/**
 * The phrasing layer is *polish only*. The deterministic answer built in
 * answer.ts is already complete, correct, and cited; a phrasing model may
 * reword its prose for fluency but is structurally forbidden from touching the
 * numbers, citations, drilldown, or suggested action. So the whole product
 * works — and every test runs — with zero model access. An LLM is an optional
 * upgrade to tone, never a dependency for truth.
 *
 * This matters concretely here: the OpenAI key exists but has no credits, so
 * `templatePhrasing` is the shipped default and `openAiPhrasing` is wired but
 * dormant behind the interface until credits land.
 */
export interface PhrasingModel {
  /** Return a reworded version of `answer.answer`, or the original on any failure. */
  phrase(answer: CopilotAnswer): Promise<string>;
}

/** The default: return the deterministic prose unchanged. Zero-cost, instant, always correct. */
export const templatePhrasing: PhrasingModel = {
  phrase: (answer) => Promise.resolve(answer.answer),
};

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = 'gpt-4o-mini';

interface OpenAIChatResponse {
  choices?: { message?: { content?: string } }[];
}

export interface OpenAiPhrasingOptions {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
  /** Hard cap so phrasing can never threaten the <3s answer budget. */
  timeoutMs?: number;
}

/**
 * OpenAI-backed phrasing. Sends the *already-final* answer text and asks only
 * for a fluency rewrite that preserves every figure — the system prompt
 * forbids adding or changing numbers. Any failure (no credits, timeout,
 * malformed response) falls back to the deterministic text, so enabling this
 * can improve tone but can never break or slow an answer past the timeout.
 */
export function openAiPhrasing(options: OpenAiPhrasingOptions): PhrasingModel {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 1500;

  return {
    async phrase(answer) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(OPENAI_ENDPOINT, {
          method: 'POST',
          headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            model: options.model ?? DEFAULT_MODEL,
            messages: [
              {
                role: 'system',
                content:
                  'You reword an SEO/GEO analytics answer for a concise, friendly tone. ' +
                  'Preserve every number, percentage, range, position, and entity name EXACTLY as given. ' +
                  'Never add facts or figures not present. Return only the reworded sentence(s).',
              },
              { role: 'user', content: answer.answer },
            ],
          }),
        });
        if (!res.ok) return answer.answer;
        const body = (await res.json()) as OpenAIChatResponse;
        const reworded = body.choices?.[0]?.message?.content?.trim();
        return reworded && reworded.length > 0 ? reworded : answer.answer;
      } catch {
        return answer.answer;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Apply a phrasing model to an answer, returning a new answer with only its
 * prose swapped. Everything else (citations/drilldown/action) is carried
 * through untouched — the guarantee that phrasing can't rewrite the facts.
 */
export async function applyPhrasing(answer: CopilotAnswer, model: PhrasingModel): Promise<CopilotAnswer> {
  const phrased = await model.phrase(answer);
  return { ...answer, answer: phrased };
}
