/**
 * Google Gemini implementation of `LlmEngineConnector` (A2 — second engine,
 * built for readiness alongside OpenAI).
 *
 * Calls the Generative Language `generateContent` endpoint once per sample.
 * When the Google Search grounding tool is enabled, Gemini returns
 * `groundingMetadata` with real source URIs — the GEO-honest signal — which we
 * extract as structured `sourcesCited`. Falls back to URLs in the answer text
 * otherwise. No SDK; plain fetch, portable to Workers.
 */
import type { LlmEngineConnector, LlmAnswerResult, LlmAnswerSample, PromptQuery } from './llmEngine.js';
import { buildCitationEvent, runSamples } from './llmCitation.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-2.0-flash';

interface GeminiGroundingChunk {
  web?: { uri?: string; title?: string };
}

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    groundingMetadata?: { groundingChunks?: GeminiGroundingChunk[] };
  }[];
}

/** Pull answer text + grounding source URIs out of a Gemini response. */
export function parseGeminiResponse(raw: GeminiResponse): { text: string; sources: string[] } {
  const candidate = raw.candidates?.[0];
  const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? '').join('');
  const sources = (candidate?.groundingMetadata?.groundingChunks ?? [])
    .map((chunk) => chunk.web?.uri)
    .filter((uri): uri is string => typeof uri === 'string');
  return { text, sources };
}

export interface GeminiConnectorOptions {
  apiKey: string;
  model?: string;
  /** Enable the Google Search grounding tool so answers carry real source URIs. */
  grounding?: boolean;
  fetchImpl?: typeof fetch;
  rawSink?: (query: PromptQuery, raw: unknown) => Promise<string> | string;
  now?: () => Date;
}

export class GeminiConnector implements LlmEngineConnector {
  readonly engine = 'gemini' as const;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly grounding: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly rawSink: NonNullable<GeminiConnectorOptions['rawSink']>;
  private readonly now: () => Date;

  constructor(options: GeminiConnectorOptions) {
    if (!options.apiKey) throw new Error('GeminiConnector requires an apiKey');
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_MODEL;
    this.grounding = options.grounding ?? true;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => new Date());
    this.rawSink = options.rawSink ?? ((_q, _raw) => `gemini:pending:${this.now().toISOString()}`);
  }

  private async sample(query: PromptQuery): Promise<LlmAnswerSample> {
    const url = `${GEMINI_BASE}/${this.model}:generateContent?key=${this.apiKey}`;
    const body: Record<string, unknown> = {
      contents: [{ role: 'user', parts: [{ text: query.prompt }] }],
    };
    if (this.grounding) body.tools = [{ google_search: {} }];

    const resp = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new Error(`Gemini request failed: ${resp.status} ${await resp.text()}`);
    }
    const raw = (await resp.json()) as GeminiResponse;
    const { text, sources } = parseGeminiResponse(raw);
    const rawAnswerRef = await this.rawSink(query, raw);
    return {
      rawAnswerRef,
      citation: buildCitationEvent(text, sources, query.citationTargets),
      sampledAt: this.now().toISOString(),
    };
  }

  async poll(query: PromptQuery, nSamples: number): Promise<LlmAnswerResult> {
    const samples = await runSamples(nSamples, () => this.sample(query));
    return { engine: this.engine, query, method: 'api', samples };
  }
}
