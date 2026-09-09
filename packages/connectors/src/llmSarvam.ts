/**
 * Sarvam implementation of `LlmEngineConnector` (A2 — the engine this
 * deployment actually has credit on).
 *
 * OpenAI-shaped Chat Completions, so this mirrors `llmOpenAI.ts`, with two
 * differences that come from the vendor and are not cosmetic:
 *
 * 1. The key travels in `api-subscription-key`, not `authorization`.
 * 2. `sarvam-105b` is a reasoning model. It fills `message.reasoning_content`
 *    first and `message.content` only after it has finished thinking, out of
 *    the same `max_tokens` budget. With a small budget the response arrives
 *    `200 OK` with `content: null` and `finish_reason: 'length'`, which would
 *    be recorded as an answer that cited nobody. Hence the large default
 *    budget and the explicit truncation error below.
 *
 * Sarvam does not browse, so there is no grounding metadata to merge: sources
 * are whatever URLs the answer text contains, and `cited` is normally decided
 * by the brand-name targets. `buildCitationEvent` already handles that.
 */
import type { LlmEngineConnector, LlmAnswerResult, LlmAnswerSample, PromptQuery } from './llmEngine.js';
import { buildCitationEvent, runSamples } from './llmCitation.js';
import { parseSseJson, type LlmStreamChunk, type LlmStreamingConnector } from './llmStream.js';

const SARVAM_ENDPOINT = 'https://api.sarvam.ai/v1/chat/completions';
const DEFAULT_MODEL = 'sarvam-105b';

/**
 * Generous because reasoning tokens are drawn from the same budget as the
 * answer, and how long the model thinks varies per call rather than per
 * prompt. Measured on one prompt: 966 completion tokens for a two-sentence
 * reply, 658 for a full answer on another run, and 28,793 characters of
 * reasoning that was still truncated at 8,000 tokens on a third. The
 * `reasoning_effort` parameter ('low' | 'medium' | 'high') does not bound it —
 * the 8,000-token truncation was a 'low' run — so the budget is set above the
 * worst measurement instead of a knob being added that does not hold.
 */
const DEFAULT_MAX_TOKENS = 16000;

interface SarvamStreamEvent {
  choices?: {
    finish_reason?: string;
    delta?: { content?: string | null; reasoning_content?: string | null };
  }[];
}

interface SarvamChatResponse {
  choices?: {
    finish_reason?: string;
    message?: { content?: string | null; reasoning_content?: string | null };
  }[];
}

export interface SarvamConnectorOptions {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
  /** Persist the raw answer to the raw lake and return its ref. Defaults to a synthetic ref. */
  rawSink?: (query: PromptQuery, raw: unknown) => Promise<string> | string;
  now?: () => Date;
}

export class SarvamConnector implements LlmEngineConnector, LlmStreamingConnector {
  readonly engine = 'sarvam' as const;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly fetchImpl: typeof fetch;
  private readonly rawSink: NonNullable<SarvamConnectorOptions['rawSink']>;
  private readonly now: () => Date;

  constructor(options: SarvamConnectorOptions) {
    if (!options.apiKey) throw new Error('SarvamConnector requires an apiKey');
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_MODEL;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => new Date());
    this.rawSink = options.rawSink ?? ((_q, _raw) => `sarvam:pending:${this.now().toISOString()}`);
  }

  private async sample(query: PromptQuery): Promise<LlmAnswerSample> {
    const resp = await this.fetchImpl(SARVAM_ENDPOINT, {
      method: 'POST',
      headers: { 'api-subscription-key': this.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'user', content: query.prompt }],
        max_tokens: this.maxTokens,
      }),
    });
    if (!resp.ok) {
      throw new Error(`Sarvam request failed: ${resp.status} ${await resp.text()}`);
    }
    const raw = (await resp.json()) as SarvamChatResponse;
    const choice = raw.choices?.[0];
    const answerText = choice?.message?.content ?? '';

    // An empty answer after a truncated response is the reasoning-budget case,
    // not a model that had nothing to say. Recording it as an uncited sample
    // would understate the brand's AI visibility with no trace of why.
    if (!answerText && choice?.finish_reason === 'length') {
      throw new Error(
        `Sarvam returned no answer text: the reply was truncated at ${this.maxTokens} tokens while the model was still reasoning`,
      );
    }

    const rawAnswerRef = await this.rawSink(query, raw);
    return {
      rawAnswerRef,
      citation: buildCitationEvent(answerText, [], query.citationTargets),
      sampledAt: this.now().toISOString(),
    };
  }

  async poll(query: PromptQuery, nSamples: number): Promise<LlmAnswerResult> {
    const samples = await runSamples(nSamples, () => this.sample(query));
    return { engine: this.engine, query, method: 'api', samples };
  }

  /**
   * Stream one answer, separating the reasoning phase from the answer.
   *
   * Sarvam is OpenAI-shaped here too: `stream: true` yields
   * `choices[0].delta`, and this model puts its thinking in
   * `delta.reasoning_content` and the answer in `delta.content`. Both are
   * forwarded, tagged, because the reasoning phase is most of the wait and a
   * caller that cannot see it has nothing to show the user.
   *
   * Truncation is reported the same way `sample` reports it: a stream that
   * ends with `finish_reason: 'length'` having produced no answer text at all
   * was cut off mid-thought, and saying so beats handing back an empty answer.
   */
  async *stream(prompt: string, signal?: AbortSignal): AsyncIterable<LlmStreamChunk> {
    const resp = await this.fetchImpl(SARVAM_ENDPOINT, {
      method: 'POST',
      headers: { 'api-subscription-key': this.apiKey, 'content-type': 'application/json' },
      signal,
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: this.maxTokens,
        stream: true,
      }),
    });
    if (!resp.ok) {
      throw new Error(`Sarvam stream failed: ${resp.status} ${await resp.text()}`);
    }
    if (!resp.body) throw new Error('Sarvam stream failed: the response carried no body');

    let answered = false;
    let finishReason: string | undefined;
    for await (const event of parseSseJson(resp.body, signal)) {
      const choice = (event as SarvamStreamEvent).choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const thinking = choice.delta?.reasoning_content;
      if (thinking) yield { type: 'thinking', delta: thinking };
      const text = choice.delta?.content;
      if (text) {
        answered = true;
        yield { type: 'text', delta: text };
      }
    }

    if (!answered && finishReason === 'length') {
      throw new Error(
        `Sarvam returned no answer text: the reply was truncated at ${this.maxTokens} tokens while the model was still reasoning`,
      );
    }
  }
}
