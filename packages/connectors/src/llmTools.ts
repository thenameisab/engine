/**
 * Multi-turn conversations with tool calling, shared across LLM engines.
 *
 * The batch `poll` path in `llmEngine.ts` sends one prompt and reads one
 * answer, and `llmStream.ts` streams that same single turn. Driver needs the
 * third shape: a growing list of messages in four roles, a catalogue of tools
 * the model may ask for, and a reply that is either text or a request to run
 * something. That is what this file declares.
 *
 * The types are the OpenAI-shaped ones every engine in this repo speaks, but
 * they are declared in Engine's own terms — `toolCalls`, not `tool_calls`, and
 * a tool choice that is a name rather than a nested object — because the
 * serialisation is the adapter's job and Driver should not be written against
 * one vendor's JSON. `llmSarvam.ts` does the translation in one place.
 *
 * Nothing here executes a tool. A tool call is a request the model made; what
 * runs, whether it is allowed to run, and what the result means all belong to
 * `packages/driver` and its semantic layer.
 */

/**
 * A tool the model may ask for: a name, what it is for, and the shape of its
 * arguments.
 *
 * `parameters` is a JSON Schema object sent verbatim. It is typed as an opaque
 * record rather than a schema type because the vendor validates nothing — the
 * model is free to send arguments that do not match, and the caller must
 * validate what arrives against its own schema regardless.
 */
export interface LlmToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** One call the model asked for. */
export interface LlmToolCall {
  /** The vendor's id for this call. It must come back on the `tool` message. */
  id: string;
  name: string;
  /**
   * The arguments as the vendor sent them — a JSON string, unparsed.
   *
   * Deliberately not parsed here. A model can emit malformed JSON, and the
   * layer that knows which tool this is and what its schema says is the layer
   * that should decide what to do about it. Parsing in the adapter would turn
   * a recoverable "ask the model again" into a transport error.
   */
  arguments: string;
}

/**
 * One message in a conversation.
 *
 * `assistant.content` is nullable because a turn that only asks for tools
 * carries no text, and sending `''` for it is a different claim from sending
 * nothing.
 */
export type LlmMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: LlmToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

/**
 * What the model is allowed to do with the catalogue this turn.
 *
 * `'required'` forces some tool; `{ name }` forces one named tool, which is
 * also how structured output is obtained on this vendor — force a tool whose
 * parameters are the schema you want back.
 */
export type LlmToolChoice = 'auto' | 'none' | 'required' | { name: string };

/** How hard a reasoning model should think before it answers. */
export type LlmReasoningEffort = 'low' | 'medium' | 'high';

export interface LlmConversationOptions {
  tools?: LlmToolDefinition[];
  toolChoice?: LlmToolChoice;
  /** Overrides the connector's default budget, never raising it above it. */
  maxTokens?: number;
  /**
   * Passed through because the probe in the Driver scoping document has to
   * measure what `'high'` costs in seconds on a full catalogue, and a
   * parameter the connector does not carry cannot be measured through it.
   * Omitted means the vendor's default.
   */
  reasoningEffort?: LlmReasoningEffort;
  signal?: AbortSignal;
}

/** What one model turn produced. */
export interface LlmTurn {
  /** The assistant's text. Empty when the turn only asked for tools. */
  text: string;
  /** The reasoning text, when the model emitted any. */
  reasoning: string;
  /** What the model asked to run, in the order it asked. */
  toolCalls: LlmToolCall[];
  finishReason: string | null;
  /**
   * What the turn cost, when the vendor reported it.
   *
   * Optional because a vendor may omit it, and a missing count has to be
   * distinguishable from a count of zero: an agent loop that budgets tokens
   * must know the difference between "this turn was free" and "we do not know
   * what this turn cost".
   */
  usage?: LlmTokenUsage;
  /** The vendor payload, for a raw sink or an audit trail. */
  raw: unknown;
}

/** What one turn spent, as the vendor reported it. */
export interface LlmTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * A streamed turn.
 *
 * `thinking` and `text` are the two chunks `llmStream.ts` already defines, and
 * they mean the same thing here. The two tool chunks are separate on purpose:
 * a call's arguments arrive in fragments and are useless until complete, but
 * its *name* usually arrives in the first fragment — and the name is what lets
 * a screen say "checking your search performance" instead of showing a spinner
 * for the whole round. Same reason `thinking` is a chunk type at all.
 */
export type LlmTurnChunk =
  | { type: 'thinking'; delta: string }
  | { type: 'text'; delta: string }
  /** The model has started asking for a tool. Arguments are still arriving. */
  | { type: 'tool_call_start'; id: string; name: string }
  /** A complete call, arguments included. Emitted once per call. */
  | { type: 'tool_call'; call: LlmToolCall }
  /**
   * What the turn cost. Emitted at most once, near the end of the stream.
   *
   * The vendor sends this in its own frame with an empty `choices` array, just
   * before `[DONE]`, without being asked for it. It used to be dropped, which
   * left an agent loop with no way to budget tokens across rounds except by
   * making a second non-streaming call for the count.
   */
  | { type: 'usage'; usage: LlmTokenUsage };

export interface LlmConversationalConnector {
  engine: string;
  /**
   * The model id this connector talks to.
   *
   * Exposed because the caller stores it against the answer: `driver_messages`
   * records which model produced each assistant turn, and a thread read back
   * six months later has to say that rather than "whatever the factory picks
   * today". The factory chooses the model, so the caller cannot name it
   * without asking the connector it was handed.
   */
  model: string;
  /** One turn, complete. Throws on transport or vendor failure. */
  converse(messages: LlmMessage[], opts?: LlmConversationOptions): Promise<LlmTurn>;
  /** One turn, as it arrives. Throws on transport or vendor failure. */
  streamConverse(messages: LlmMessage[], opts?: LlmConversationOptions): AsyncIterable<LlmTurnChunk>;
}

// ---------------------------------------------------------------------------
// OpenAI-shaped wire format. Sarvam, OpenAI and every other Chat Completions
// clone share it, so the translation lives here rather than in one adapter.
// ---------------------------------------------------------------------------

/** The wire shape of one message. */
export function toWireMessage(m: LlmMessage): Record<string, unknown> {
  switch (m.role) {
    case 'tool':
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    case 'assistant':
      return {
        role: 'assistant',
        content: m.content,
        // Absent rather than empty: an assistant message with
        // `tool_calls: []` is rejected by some Chat Completions servers, and
        // it says something different from a turn that called nothing.
        ...(m.toolCalls?.length
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: c.arguments },
              })),
            }
          : {}),
      };
    default:
      return { role: m.role, content: m.content };
  }
}

/** The wire shape of the tool catalogue. */
export function toWireTools(tools: LlmToolDefinition[]): Record<string, unknown>[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/** The wire shape of a tool choice. */
export function toWireToolChoice(choice: LlmToolChoice): unknown {
  return typeof choice === 'string' ? choice : { type: 'function', function: { name: choice.name } };
}

/** One `tool_calls` entry on a non-streamed assistant message. */
export interface WireToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

/**
 * Read the tool calls off a completed assistant message.
 *
 * A call with no name is dropped: it names nothing to run, and passing it on
 * would push the failure into the loop, which cannot do anything about it
 * either. Arguments default to `'{}'` because a tool with no required
 * parameters is legitimately called with none, and the vendor sometimes omits
 * the field entirely rather than sending an empty object.
 */
export function readWireToolCalls(calls: WireToolCall[] | undefined): LlmToolCall[] {
  return (calls ?? [])
    .filter((c) => Boolean(c.function?.name))
    .map((c, i) => ({
      id: c.id ?? `call_${i}`,
      name: c.function!.name!,
      arguments: c.function?.arguments ?? '{}',
    }));
}

/** The vendor's spelling of a usage block, on both the JSON body and the stream. */
export interface WireUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/**
 * Read a usage block, or `undefined` when the vendor sent none.
 *
 * `undefined` rather than a zeroed object on purpose: a loop budgeting tokens
 * has to tell "the vendor did not say" from "this turn cost nothing", and only
 * one of those two means it should stop trusting its own running total.
 */
export function readWireUsage(usage: WireUsage | null | undefined): LlmTokenUsage | undefined {
  if (!usage) return undefined;
  const { prompt_tokens, completion_tokens, total_tokens } = usage;
  if (prompt_tokens === undefined && completion_tokens === undefined && total_tokens === undefined) {
    return undefined;
  }
  const promptTokens = prompt_tokens ?? 0;
  const completionTokens = completion_tokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: total_tokens ?? promptTokens + completionTokens,
  };
}

/** One `tool_calls` entry inside a streamed delta. */
export interface WireToolCallDelta {
  /** Which call this fragment belongs to. The only reliable key across events. */
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

/**
 * Accumulates tool calls arriving in fragments across stream events.
 *
 * The vendor sends a call's id and name once, usually in the first fragment,
 * then its arguments a few characters at a time across later events — each
 * fragment identified only by `index`. Concatenating them in arrival order
 * without keying on the index is what breaks the moment two calls interleave,
 * which is exactly the case the parallel-tool-call probe exists to find out
 * about. Keyed from the start so the answer to that question changes nothing
 * here.
 */
export class ToolCallAccumulator {
  private readonly byIndex = new Map<number, { id: string; name: string; args: string }>();
  private readonly announced = new Set<number>();

  /**
   * Absorb one fragment. Returns the call's identity the first time its name
   * is known, and null every other time — so a caller can announce a call
   * once, as it starts, without tracking that itself.
   */
  absorb(delta: WireToolCallDelta): { id: string; name: string } | null {
    const index = delta.index ?? 0;
    const entry = this.byIndex.get(index) ?? { id: '', name: '', args: '' };
    if (delta.id) entry.id = delta.id;
    if (delta.function?.name) entry.name += delta.function.name;
    if (delta.function?.arguments) entry.args += delta.function.arguments;
    this.byIndex.set(index, entry);

    if (entry.name && !this.announced.has(index)) {
      this.announced.add(index);
      return { id: entry.id || `call_${index}`, name: entry.name };
    }
    return null;
  }

  /** Every complete call, in the vendor's own index order. */
  drain(): LlmToolCall[] {
    return [...this.byIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .filter(([, e]) => e.name !== '')
      .map(([index, e]) => ({ id: e.id || `call_${index}`, name: e.name, arguments: e.args || '{}' }));
  }
}
