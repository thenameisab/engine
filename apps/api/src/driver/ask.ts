/**
 * One Driver turn, end to end: session scope in, grounded answer out.
 *
 * This is the seam between the loop, which is pure and knows nothing about
 * databases, and the product, which has a session, a project and a set of
 * connected integrations. Three things happen here and nowhere else:
 *
 *  1. **Scope is injected.** `projectId` and `accountId` come from the route,
 *     after `projectAccessError` has established that this user may read this
 *     project. They are put into the tool context, never into a tool's
 *     arguments, and no path from the model's output reaches them (§4.2 rule 1).
 *  2. **The catalogue is bound to a runner.** `runToolCall` validates the
 *     model's arguments, runs the handler and returns an envelope.
 *  3. **Degradation.** §4.8: when no model key is configured, or the vendor
 *     fails, chat does not hard-fail — it falls back to the deterministic
 *     four-intent Copilot, which needs no key and answers in under three
 *     seconds. That fallback is the reason `packages/copilot` stays.
 */
import { createConversationalLlmConnector } from '@engine/connectors';
import {
  assembleAnswer,
  buildParts,
  buildSystemPrompt,
  runTurn,
  type LoopBounds,
  type ResponsePart,
  type RoundRecord,
  type ToolResult,
  type TurnResult,
} from '@engine/driver';
import type { LlmMessage, LlmTokenUsage } from '@engine/connectors';
import type { Db } from '../db.js';
import { getProject } from '../repositories/accounts.js';
import { answerQuestion } from '../repositories/copilotQuery.js';
import { loadHistory, persistTurn } from '../repositories/driverThreads.js';
import type { DriverToolContext } from './context.js';
import { RENDER_SPECS } from './parts.js';
import { runToolCall } from './registry.js';

export interface AskInput {
  question: string;
  /**
   * Who is asking, when a person is.
   *
   * Absent for the edge worker's service token, which has no `users` row to own
   * a thread. Without it the turn is not stored and replays nothing, so a
   * service caller gets a single-turn conversation — which is all it has ever
   * had.
   */
  userId?: string;
  /**
   * Continue this thread. Absent starts a new one.
   *
   * The route has already established that this user may read it. Earlier turns
   * are then loaded from `driver_messages` and from nowhere else: until this
   * step the caller sent a `history` array that went into the transcript
   * unread, which let a browser forge an assistant turn and have the model
   * treat it as something it had said itself.
   */
  threadId?: string;
  /**
   * What the customer is looking at (§4.9). Supplied by the server from the
   * screen they asked from — never taken from the request body, because a
   * value a caller controls that lands in the system prompt is a way to
   * rewrite the rules above it.
   */
  screenContext?: string;
  bounds?: Partial<LoopBounds>;
  signal?: AbortSignal;
}

/**
 * How the answer was produced.
 *
 * Carried out to the caller so a screen can say which one it is showing. A
 * fallback answer presented as a Driver answer is a quiet downgrade — the
 * customer asks a follow-up the deterministic Copilot cannot possibly handle
 * and gets a worse answer with no explanation.
 */
export type AnswerSource = 'driver' | 'copilot-fallback';

export interface AskResponse {
  source: AnswerSource;
  text: string;
  /**
   * The answer as typed parts — §4.5.
   *
   * The prose, then the figures the tools returned. Every value in a non-text
   * part came from a tool result, never from the model, which is §4.6 rule 1
   * made structural rather than promised.
   */
  parts: ResponsePart[];
  /** The thread this turn was stored in. Absent when nothing was stored. */
  threadId?: string;
  /** Present only for a Driver answer. */
  turn?: TurnResult;
  /** Why the fallback was used, when it was. */
  fellBackBecause?: string;
  modelEngine?: string;
}

/** A question and its answer, which is all the deterministic path produces. */
function exchange(question: string, answer: string): LlmMessage[] {
  return [
    { role: 'user', content: question },
    { role: 'assistant', content: answer },
  ];
}

export async function askDriver(
  db: Db,
  env: Record<string, string | undefined>,
  projectId: string,
  input: AskInput,
): Promise<AskResponse> {
  const project = await getProject(db, projectId);
  if (!project) throw new Error(`project ${projectId} not found`);

  /**
   * Store the turn, and stamp the thread id on the response.
   *
   * Every exit goes through here, the two fallbacks included. A thread that
   * dropped the turns the vendor could not answer would replay on the next
   * question as a conversation the customer never had, and the audit trail
   * would be missing exactly the turns someone would later ask about.
   *
   * A service caller has no `users` row to own a thread, so nothing is stored
   * and the response carries no `threadId`.
   *
   * **A failed write does not lose the answer.** By the time this runs the
   * tools have already read the database and the model has already been paid
   * for; a transient write failure — a statement timeout, a dropped
   * connection — would otherwise turn a complete grounded answer into a 500,
   * and the customer would re-ask and spend the whole turn again. So a
   * persistence failure is logged and the answer goes back without a
   * `threadId`, which the caller reads as "this did not become a thread".
   *
   * Deliberately not routed into the `catch` below. That path answers a vendor
   * failure by degrading to the deterministic Copilot, and degrading a good
   * answer because the *audit write* failed would be the wrong trade twice
   * over — a worse answer, and a second write that is about to fail the same
   * way. Same shape as `upsertUser` at sign-in: the thing that mattered
   * worked, the bookkeeping did not, say so in the log and carry on.
   */
  const record = async (
    response: AskResponse,
    messages: readonly LlmMessage[],
    extra: { rounds?: readonly RoundRecord[]; modelId?: string; usage?: LlmTokenUsage } = {},
  ): Promise<AskResponse> => {
    if (!input.userId) return response;
    try {
      const threadId = await persistTurn(db, {
        projectId,
        userId: input.userId,
        ...(input.threadId ? { threadId: input.threadId } : {}),
        question: input.question,
        messages,
        rounds: extra.rounds ?? [],
        ...(extra.modelId ? { modelId: extra.modelId } : {}),
        ...(extra.usage ? { usage: extra.usage } : {}),
      });
      return { ...response, threadId };
    } catch (error) {
      console.error(`driver answered project ${projectId} but the turn could not be stored`, error);
      return response;
    }
  };

  /**
   * The deterministic answer, stored as this turn's answer.
   *
   * `answerQuestion` assembles its prose from the database, so the text is
   * already grounded — narrower than a Driver answer, not less trustworthy.
   * `before` carries whatever the loop managed to produce first, so a turn that
   * called four tools and then timed out keeps those calls in the audit trail
   * rather than throwing them away with the answer.
   */
  const fallback = async (
    why: string,
    before: readonly LlmMessage[] = [],
    rounds: readonly RoundRecord[] = [],
    gathered: readonly ResponsePart[] = [],
  ) => {
    const result = await answerQuestion(db, projectId, input.question);
    const text = result.answer.answer;
    const messages = before.length > 0
      ? [...before, { role: 'assistant', content: text } as const]
      : exchange(input.question, text);
    // A turn that gathered four tables and then timed out keeps them. The
    // deterministic answer is narrower than what was on the table, and
    // throwing the evidence away as well makes it narrower still.
    return record(
      { source: 'copilot-fallback', text, parts: assembleAnswer(text, gathered), fellBackBecause: why },
      messages,
      { rounds },
    );
  };

  const connector = createConversationalLlmConnector(env);
  if (!connector) {
    return fallback('no conversational model is configured on this deployment');
  }

  // Scope, assembled once from the session's project and passed to every tool.
  // Nothing the model produces can change any field of this object.
  const ctx: DriverToolContext = {
    db,
    projectId,
    accountId: project.accountId,
    domain: project.domain,
  };

  const systemPrompt = buildSystemPrompt({
    domain: project.domain,
    projectName: project.name,
    today: new Date().toISOString().slice(0, 10),
    ...(input.screenContext ? { screenContext: input.screenContext } : {}),
  });

  // Earlier turns, from the database. The request body has no say in what the
  // model believes it said before — that is the whole point of this step.
  const history = input.threadId ? await loadHistory(db, input.threadId) : [];

  // Every tool result this turn produced, in call order, kept for the parts.
  // The loop's `ToolRunner` returns only the envelope, which is all the model
  // needs; the screen needs the structure behind it, so it is captured here
  // rather than parsed back out of a string the loop already discarded.
  const gathered: ResponsePart[] = [];
  const collect = async (name: string, rawArguments: string): Promise<string> => {
    const { envelope, result } = await runToolCall(ctx, name, rawArguments);
    const render = RENDER_SPECS[name];
    if (result && render) gathered.push(...buildParts(name, render, result satisfies ToolResult));
    return envelope;
  };

  try {
    const turn = await runTurn(
      {
        systemPrompt,
        question: input.question,
        ...(history.length > 0 ? { history } : {}),
      },
      {
        connector,
        runTool: collect,
        ...(input.bounds ? { bounds: input.bounds } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );

    // What this turn added: the loop returns `[system, ...history, user, ...new]`,
    // so the tail past the system message and the replayed history is exactly
    // the new part. Slicing rather than rebuilding keeps the stored transcript
    // identical to the one the model was actually shown.
    const added = turn.messages.slice(1 + history.length);

    // A turn that hit its deadline before producing any text has nothing to
    // show. The deterministic answer is better than an empty one, and saying
    // which is which is the whole point of `source`.
    if (!turn.text) {
      return await fallback(`the turn stopped early: ${turn.stopReason}`, added, turn.rounds, gathered);
    }

    // `return await`, not a bare `return`: a promise returned from inside a
    // `try` settles after the block has already exited, so its rejection would
    // sail past the `catch` below rather than being handled by it.
    return await record(
      {
        source: 'driver',
        text: turn.text,
        parts: assembleAnswer(turn.text, gathered),
        turn,
        modelEngine: connector.engine,
      },
      added,
      { rounds: turn.rounds, modelId: connector.model, usage: turn.usage },
    );
  } catch (error) {
    // §4.8: the vendor being down is not a reason for chat to fail.
    const why = error instanceof Error ? error.message : String(error);
    return fallback(why);
  }
}
