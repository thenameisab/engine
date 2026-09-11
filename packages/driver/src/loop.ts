/**
 * The agent loop — §4.1, with the bounds the vendor probe measured.
 *
 * Build messages → call the model with the catalogue → if it asked for tools,
 * run them server-side and append `tool` results → repeat → emit the answer.
 *
 * Four bounds, all enforced here rather than left to the model, and every one
 * of them now has a number from `docs/reviews/2026-09-11-driver-vendor-probe.md`
 * rather than a guess:
 *
 *  - **Rounds per turn: 4.** A wall-clock and cost bound, not a CPU one. The
 *    probe measured a median round at 5.2 s, so four rounds is what fits a
 *    45-second turn.
 *  - **Calls per round: 4.** Measured to work; no vendor ceiling was found, and
 *    four independent reads is as wide as any catalogue question needs. Enforced
 *    by truncating the model's list rather than by trusting the vendor.
 *  - **Wall clock: 45 s**, as a deadline across the whole turn. Not a platform
 *    limit — an HTTP-triggered Worker has no wall-clock cap — so this is a
 *    product decision about what a person will wait for.
 *  - **Tokens: a ceiling on the running total.** The probe measured a worst-case
 *    turn at 6,866 prompt tokens and projected ~15,000 by round four, 12% of
 *    `sarvam-105b`'s 128K window, so this bound will not bind in practice. It
 *    exists because "will not bind in practice" is exactly the assumption that
 *    stops being true without anyone noticing.
 *
 * **Nothing streams.** The probe found that SSE parsing is the entire CPU cost
 * of a turn — 5.96 ms against 0.018 ms for the same turn as a JSON body — and
 * that this account is on Workers Free, with 10 ms. A non-streamed round costs
 * ~0.08 ms, so ten of them fit in under a millisecond. Streaming the final
 * answer is worth doing and is what `streamConverse` is for, but it is a
 * surface decision that comes with a plan decision, and both belong with the
 * screen in step 5 rather than being pre-empted here. `RoundRecord` carries
 * everything a streamed variant would need, so that is a wrapper rather than a
 * rewrite.
 *
 * The loop does not know what a tool *is*. It is handed a `ToolRunner` that
 * takes a name and a JSON string and returns an envelope, and in production
 * that is `runToolCall` in `apps/api/src/driver/`, which is where scope is
 * injected and rows are read. That is what keeps this file free of the database
 * and testable without one.
 */
import type {
  LlmConversationalConnector,
  LlmMessage,
  LlmToolCall,
  LlmToolDefinition,
  LlmTokenUsage,
} from '@engine/connectors';
import { READ_TOOLS } from './catalogue.js';
import { toolErrorEnvelope } from './envelope.js';
import type { ToolDefinition } from './types.js';

/* ── bounds ───────────────────────────────────────────────────────────────── */

export interface LoopBounds {
  maxRounds: number;
  maxCallsPerRound: number;
  wallClockMs: number;
  /** Ceiling on the running total of prompt + completion tokens for the turn. */
  maxTotalTokens: number;
}

/**
 * The measured defaults. Each traces to a section of the probe's §6 table.
 *
 * Exported so a caller can widen them deliberately and so a test can narrow
 * them without waiting 45 real seconds.
 */
export const DEFAULT_BOUNDS: LoopBounds = {
  maxRounds: 4,
  maxCallsPerRound: 4,
  wallClockMs: 45_000,
  maxTotalTokens: 96_000,
};

/* ── the loop's inputs and outputs ────────────────────────────────────────── */

/**
 * Runs one tool and returns the envelope to put on the `tool` message.
 *
 * Returns rather than throws: a tool that failed still has to produce a
 * message, because the vendor rejects a request whose `tool_calls` are not all
 * answered. `runToolCall` in `apps/api` already guarantees this by returning an
 * error envelope instead of propagating.
 */
export type ToolRunner = (name: string, rawArguments: string) => Promise<string>;

export interface TurnInput {
  /** The system prompt. Built by `buildSystemPrompt`; passed in so the loop stays pure. */
  systemPrompt: string;
  /** What the customer just asked. */
  question: string;
  /**
   * Earlier turns, oldest first, without the system message.
   *
   * Empty for a new thread. Step 4 will load these from `driver_messages`; the
   * loop neither reads nor writes them, it only places them.
   */
  history?: LlmMessage[];
}

export interface ToolCallRecord {
  id: string;
  name: string;
  arguments: string;
  durationMs: number;
  /** Set when the call was answered without being run, and why. */
  skipped?: 'per-round-cap' | 'deadline';
}

export interface RoundRecord {
  /** 1-based, so a log reads the way a person counts. */
  round: number;
  durationMs: number;
  finishReason: string | null;
  usage?: LlmTokenUsage;
  toolCalls: ToolCallRecord[];
}

/**
 * Why the loop stopped.
 *
 * `answered` is the only one that is not a budget being spent. The other four
 * are all partial answers, and the caller is expected to say so to the
 * customer rather than presenting a truncated answer as a complete one.
 */
export type StopReason = 'answered' | 'max-rounds' | 'deadline' | 'token-budget' | 'no-answer';

export interface TurnResult {
  text: string;
  reasoning: string;
  stopReason: StopReason;
  /** True whenever the answer rests on less than the model wanted to gather. */
  partial: boolean;
  rounds: RoundRecord[];
  usage: LlmTokenUsage;
  /**
   * The whole transcript, system message included, ready to persist.
   *
   * Returned rather than kept internal because step 4 stores the conversation
   * and §4.4's audit requirement is that a customer asking "where did that
   * number come from" three days later gets the tool call and its result, not
   * the prose.
   */
  messages: LlmMessage[];
}

export interface RunTurnOptions {
  connector: LlmConversationalConnector;
  runTool: ToolRunner;
  /** Defaults to the whole read catalogue. Narrowed in tests, and by governance later. */
  tools?: readonly ToolDefinition[];
  bounds?: Partial<LoopBounds>;
  /** Injected so tests do not wait on real time. */
  now?: () => number;
  signal?: AbortSignal;
}

/* ── helpers ──────────────────────────────────────────────────────────────── */

/**
 * The catalogue in the vendor's vocabulary.
 *
 * `ToolDefinition` carries `tier`, `access` and `tables` that the model has no
 * business seeing — tier and access are ours to enforce, and the table names
 * are provenance for the reader, not a hint for the model. Only the three
 * fields the vendor defines are sent.
 */
export function toLlmTools(tools: readonly ToolDefinition[]): LlmToolDefinition[] {
  return tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
}

/** Sum usage across rounds, treating an unreported turn as zero rather than dropping the total. */
function addUsage(total: LlmTokenUsage, turn: LlmTokenUsage | undefined): LlmTokenUsage {
  if (!turn) return total;
  return {
    promptTokens: total.promptTokens + turn.promptTokens,
    completionTokens: total.completionTokens + turn.completionTokens,
    totalTokens: total.totalTokens + turn.totalTokens,
  };
}

/**
 * The message that answers a call we chose not to run.
 *
 * Every id in an assistant message's `tool_calls` must come back on a `tool`
 * message or the next request is malformed and the vendor rejects it — so a
 * capped or abandoned call is answered, not dropped. The text says why, in the
 * envelope's error shape, because the model can act on "you asked for six, four
 * ran" and cannot act on silence.
 */
function skippedEnvelope(call: LlmToolCall, why: ToolCallRecord['skipped'], cap: number): string {
  return toolErrorEnvelope(
    call.name,
    why === 'per-round-cap'
      ? `Not run: at most ${cap} tools may be called in one round, and this call was past that limit. ` +
          `Ask for it again in the next round if you still need it.`
      : 'Not run: this turn ran out of time before the call could be made.',
  );
}

/* ── the loop ─────────────────────────────────────────────────────────────── */

/**
 * Run one conversational turn to completion.
 *
 * Throws only when the model call itself throws — a transport or vendor
 * failure, which the caller degrades from (§4.8's fallback to the deterministic
 * Copilot). Every other failure inside the turn, including a tool that threw,
 * becomes a message in the transcript so the model can react to it.
 */
export async function runTurn(input: TurnInput, opts: RunTurnOptions): Promise<TurnResult> {
  const bounds = { ...DEFAULT_BOUNDS, ...opts.bounds };
  const now = opts.now ?? (() => Date.now());
  const catalogue = opts.tools ?? READ_TOOLS;
  const tools = toLlmTools(catalogue);
  const deadline = now() + bounds.wallClockMs;

  const messages: LlmMessage[] = [
    { role: 'system', content: input.systemPrompt },
    ...(input.history ?? []),
    { role: 'user', content: input.question },
  ];

  const rounds: RoundRecord[] = [];
  let usage: LlmTokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let reasoning = '';

  /** One model call, recorded. */
  const ask = async (toolChoice: 'auto' | 'none') => {
    const started = now();
    const turn = await opts.connector.converse(messages, {
      ...(toolChoice === 'auto' ? { tools, toolChoice: 'auto' as const } : { toolChoice: 'none' as const }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    usage = addUsage(usage, turn.usage);
    if (turn.reasoning) reasoning = turn.reasoning;
    return { turn, startedAt: started };
  };

  const finish = (text: string, stopReason: StopReason): TurnResult => ({
    text,
    reasoning,
    stopReason,
    partial: stopReason !== 'answered',
    rounds,
    usage,
    messages,
  });

  for (let round = 1; round <= bounds.maxRounds; round += 1) {
    if (now() >= deadline) return await concludePartially('deadline');

    const { turn, startedAt } = await ask('auto');
    const record: RoundRecord = {
      round,
      durationMs: now() - startedAt,
      finishReason: turn.finishReason,
      ...(turn.usage ? { usage: turn.usage } : {}),
      toolCalls: [],
    };
    rounds.push(record);

    // No tool calls means the model is answering. That turn is the answer;
    // there is no separate final round to make.
    if (turn.toolCalls.length === 0) {
      messages.push({ role: 'assistant', content: turn.text });
      return finish(turn.text, 'answered');
    }

    messages.push({ role: 'assistant', content: turn.text || null, toolCalls: turn.toolCalls });

    const toRun = turn.toolCalls.slice(0, bounds.maxCallsPerRound);
    const capped = turn.toolCalls.slice(bounds.maxCallsPerRound);

    // Concurrently: the vendor returns a round's calls together, they are
    // independent reads by construction, and serialising them would multiply
    // the round's wall clock by the number of calls for nothing.
    const results = await Promise.all(
      toRun.map(async (call) => {
        const started = now();
        const content = await opts.runTool(call.name, call.arguments);
        return { call, content, durationMs: now() - started };
      }),
    );

    for (const { call, content, durationMs } of results) {
      record.toolCalls.push({ id: call.id, name: call.name, arguments: call.arguments, durationMs });
      messages.push({ role: 'tool', toolCallId: call.id, content });
    }

    for (const call of capped) {
      record.toolCalls.push({
        id: call.id,
        name: call.name,
        arguments: call.arguments,
        durationMs: 0,
        skipped: 'per-round-cap',
      });
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        content: skippedEnvelope(call, 'per-round-cap', bounds.maxCallsPerRound),
      });
    }

    if (usage.totalTokens >= bounds.maxTotalTokens) return await concludePartially('token-budget');
  }

  return await concludePartially('max-rounds');

  /**
   * Spend one last call getting an answer out of what was gathered.
   *
   * §4.1 asks for "a partial answer on expiry rather than a timeout", and the
   * material for one is already in the transcript — several tool results the
   * model has not yet been asked to summarise. `tool_choice: 'none'` is what
   * makes this terminate: it forbids another round of calls, so the model has
   * to answer from what it has.
   *
   * Not attempted past the deadline. The point of a deadline is not to wait
   * longer, so a turn that ran out of time returns what it has and says so.
   */
  async function concludePartially(reason: StopReason): Promise<TurnResult> {
    if (reason === 'deadline' || now() >= deadline) {
      return finish('', reason === 'deadline' ? 'deadline' : reason);
    }

    const { turn, startedAt } = await ask('none');
    rounds.push({
      round: rounds.length + 1,
      durationMs: now() - startedAt,
      finishReason: turn.finishReason,
      ...(turn.usage ? { usage: turn.usage } : {}),
      toolCalls: [],
    });
    messages.push({ role: 'assistant', content: turn.text });
    return finish(turn.text, turn.text ? reason : 'no-answer');
  }
}
