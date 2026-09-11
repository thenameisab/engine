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
 *
 * Four public entry points, two wire calls. `converse` and `streamConverse`
 * are the primitives — a list of messages, an optional tool catalogue, one
 * reply — and `sample`, `complete` and `stream` are the single-prompt callers
 * that were here first, now expressed through them. They used to be four
 * near-identical `fetch` blocks that had already drifted: only one of them
 * sent the truncation check, and only one of them accepted a signal.
 */
import type { LlmEngineConnector, LlmAnswerResult, LlmAnswerSample, LlmCompleter, PromptQuery } from './llmEngine.js';
import { buildCitationEvent, runSamples } from './llmCitation.js';
import { parseSseJson, type LlmStreamChunk, type LlmStreamingConnector } from './llmStream.js';
import {
  ToolCallAccumulator,
  readWireToolCalls,
  readWireUsage,
  toWireMessage,
  toWireToolChoice,
  toWireTools,
  type LlmConversationOptions,
  type LlmConversationalConnector,
  type LlmMessage,
  type LlmTurn,
  type LlmTurnChunk,
  type WireToolCall,
  type WireToolCallDelta,
  type WireUsage,
} from './llmTools.js';

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
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: WireToolCallDelta[];
    };
  }[];
  /** Sent unasked in its own frame with an empty `choices`, just before `[DONE]`. */
  usage?: WireUsage | null;
}

interface SarvamChatResponse {
  choices?: {
    finish_reason?: string;
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: WireToolCall[];
    };
  }[];
  usage?: WireUsage | null;
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

export class SarvamConnector
  implements LlmEngineConnector, LlmStreamingConnector, LlmConversationalConnector, LlmCompleter
{
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

  /**
   * The one request this connector makes.
   *
   * `max_tokens` is clamped to the connector's ceiling rather than taking the
   * caller's word for it: the ceiling is the model's own, and exceeding it is
   * a 400 from the vendor, not a shorter answer.
   */
  private async post(
    messages: LlmMessage[],
    opts: LlmConversationOptions,
    stream: boolean,
    label: string,
  ): Promise<Response> {
    const resp = await this.fetchImpl(SARVAM_ENDPOINT, {
      method: 'POST',
      headers: { 'api-subscription-key': this.apiKey, 'content-type': 'application/json' },
      ...(opts.signal ? { signal: opts.signal } : {}),
      body: JSON.stringify({
        model: this.model,
        messages: messages.map(toWireMessage),
        max_tokens: Math.min(opts.maxTokens ?? this.maxTokens, this.maxTokens),
        ...(opts.tools?.length ? { tools: toWireTools(opts.tools) } : {}),
        ...(opts.toolChoice ? { tool_choice: toWireToolChoice(opts.toolChoice) } : {}),
        ...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : {}),
        ...(stream ? { stream: true } : {}),
      }),
    });
    if (!resp.ok) throw new Error(`Sarvam ${label} failed: ${resp.status} ${await resp.text()}`);
    return resp;
  }

  /**
   * One model turn over a message list, with an optional tool catalogue.
   *
   * Returns a truncated turn rather than throwing on one. A turn cut off
   * mid-thought means different things to different callers — the citation
   * sample below refuses it, an agent loop may retry with a larger budget —
   * and the transport is not the layer that should decide.
   */
  async converse(messages: LlmMessage[], opts: LlmConversationOptions = {}): Promise<LlmTurn> {
    const resp = await this.post(messages, opts, false, 'request');
    const raw = (await resp.json()) as SarvamChatResponse;
    const choice = raw.choices?.[0];
    return {
      text: choice?.message?.content ?? '',
      reasoning: choice?.message?.reasoning_content ?? '',
      toolCalls: readWireToolCalls(choice?.message?.tool_calls),
      finishReason: choice?.finish_reason ?? null,
      usage: readWireUsage(raw.usage),
      raw,
    };
  }

  /**
   * One model turn, as it arrives.
   *
   * Both content channels are forwarded, tagged, because the reasoning phase
   * is most of the wait and a caller that cannot see it has nothing to show
   * the user. Tool calls arrive as fragments keyed by index; the accumulator
   * announces each call as soon as its name is known and hands over the
   * complete calls at the end, because a half-arrived argument string is not
   * something a caller can act on.
   *
   * Truncation is reported here, unlike in `converse`: a stream that produced
   * no answer text, no tool call and ended on `finish_reason: 'length'` was
   * cut off mid-thought, and a caller watching an empty box has nothing else
   * to go on.
   */
  async *streamConverse(messages: LlmMessage[], opts: LlmConversationOptions = {}): AsyncIterable<LlmTurnChunk> {
    const resp = await this.post(messages, opts, true, 'stream');
    if (!resp.body) throw new Error('Sarvam stream failed: the response carried no body');

    const calls = new ToolCallAccumulator();
    let answered = false;
    let finishReason: string | undefined;
    for await (const event of parseSseJson(resp.body, opts.signal)) {
      const frame = event as SarvamStreamEvent;
      const choice = frame.choices?.[0];
      if (!choice) {
        // The usage frame carries no choice. Before this, the guard below
        // dropped it and the token counts with it.
        const usage = readWireUsage(frame.usage);
        if (usage) yield { type: 'usage', usage };
        continue;
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;

      const thinking = choice.delta?.reasoning_content;
      if (thinking) yield { type: 'thinking', delta: thinking };

      const text = choice.delta?.content;
      if (text) {
        answered = true;
        yield { type: 'text', delta: text };
      }

      for (const fragment of choice.delta?.tool_calls ?? []) {
        const started = calls.absorb(fragment);
        if (started) yield { type: 'tool_call_start', id: started.id, name: started.name };
      }
    }

    const complete = calls.drain();
    for (const call of complete) yield { type: 'tool_call', call };

    if (!answered && complete.length === 0 && finishReason === 'length') {
      throw new Error(
        `Sarvam returned no answer text: the reply was truncated at ${this.maxTokens} tokens while the model was still reasoning`,
      );
    }
  }

  private async sample(query: PromptQuery): Promise<LlmAnswerSample> {
    const turn = await this.converse([{ role: 'user', content: query.prompt }]);

    // An empty answer after a truncated response is the reasoning-budget case,
    // not a model that had nothing to say. Recording it as an uncited sample
    // would understate the brand's AI visibility with no trace of why.
    if (!turn.text && turn.finishReason === 'length') {
      throw new Error(
        `Sarvam returned no answer text: the reply was truncated at ${this.maxTokens} tokens while the model was still reasoning`,
      );
    }

    const rawAnswerRef = await this.rawSink(query, turn.raw);
    return {
      rawAnswerRef,
      answerText: turn.text,
      citation: buildCitationEvent(turn.text, [], query.citationTargets),
      sampledAt: this.now().toISOString(),
    };
  }

  /**
   * One answer to one instruction, for the extraction pass that asks which
   * companies a stored answer names. Same endpoint and model as `sample`, a
   * smaller budget because the reply is a short list, and no citation logic
   * because the caller is not measuring anything with it.
   */
  async complete(prompt: string, opts: { maxTokens?: number } = {}): Promise<string> {
    const turn = await this.converse([{ role: 'user', content: prompt }], { maxTokens: opts.maxTokens });
    return turn.text;
  }

  async poll(query: PromptQuery, nSamples: number): Promise<LlmAnswerResult> {
    const samples = await runSamples(nSamples, () => this.sample(query));
    return { engine: this.engine, model: this.model, query, method: 'api', samples };
  }

  /**
   * Stream one answer to one prompt — the live "try a prompt" surface.
   *
   * A narrowing of `streamConverse`: no catalogue is offered, so no tool chunk
   * can arrive, and the two that can are exactly `LlmStreamChunk`. The narrow
   * type is kept because the surface that consumes it has no tool calls to
   * render and should not have to prove that on every chunk.
   */
  async *stream(prompt: string, signal?: AbortSignal): AsyncIterable<LlmStreamChunk> {
    for await (const chunk of this.streamConverse([{ role: 'user', content: prompt }], { signal })) {
      if (chunk.type === 'thinking' || chunk.type === 'text') yield chunk;
    }
  }
}
