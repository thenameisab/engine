/**
 * OpenAI implementation of `LlmEngineConnector` (A2 — primary LLM engine).
 *
 * Calls the Chat Completions API once per sample (n-sampling → confidence
 * band upstream). Citations are extracted from URLs in the answer text; a
 * later enhancement can enable the web-search tool for structured grounding
 * sources (the `buildCitationEvent` seam already merges grounding sources when
 * present). No OpenAI SDK — a plain fetch keeps this portable to Workers.
 */
import type { LlmEngineConnector, LlmAnswerResult, LlmAnswerSample, PromptQuery } from './llmEngine.js';
import { buildCitationEvent, runSamples } from './llmCitation.js';

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = 'gpt-4o-mini';

interface OpenAIChatResponse {
  choices?: { message?: { content?: string } }[];
}

export interface OpenAIConnectorOptions {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
  /** Persist the raw answer to the raw lake and return its ref. Defaults to a synthetic ref. */
  rawSink?: (query: PromptQuery, raw: unknown) => Promise<string> | string;
  now?: () => Date;
}

export class OpenAIConnector implements LlmEngineConnector {
  readonly engine = 'openai' as const;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly rawSink: NonNullable<OpenAIConnectorOptions['rawSink']>;
  private readonly now: () => Date;

  constructor(options: OpenAIConnectorOptions) {
    if (!options.apiKey) throw new Error('OpenAIConnector requires an apiKey');
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_MODEL;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => new Date());
    this.rawSink = options.rawSink ?? ((_q, _raw) => `openai:pending:${this.now().toISOString()}`);
  }

  private async sample(query: PromptQuery): Promise<LlmAnswerSample> {
    const resp = await this.fetchImpl(OPENAI_ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, messages: [{ role: 'user', content: query.prompt }] }),
    });
    if (!resp.ok) {
      throw new Error(`OpenAI request failed: ${resp.status} ${await resp.text()}`);
    }
    const raw = (await resp.json()) as OpenAIChatResponse;
    const answerText = raw.choices?.[0]?.message?.content ?? '';
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
}
