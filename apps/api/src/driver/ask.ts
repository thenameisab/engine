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
import { buildSystemPrompt, runTurn, type LoopBounds, type TurnResult } from '@engine/driver';
import type { LlmMessage } from '@engine/connectors';
import type { Db } from '../db.js';
import { getProject } from '../repositories/accounts.js';
import { answerQuestion } from '../repositories/copilotQuery.js';
import type { DriverToolContext } from './context.js';
import { runToolCall } from './registry.js';

export interface AskInput {
  question: string;
  /** Earlier turns of this thread, oldest first. Step 4 will load these from the database. */
  history?: LlmMessage[];
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
  /** Present only for a Driver answer. */
  turn?: TurnResult;
  /** Why the fallback was used, when it was. */
  fellBackBecause?: string;
  modelEngine?: string;
}

/**
 * The deterministic answer, as a Driver-shaped response.
 *
 * `answerQuestion` returns a `CopilotAnswer` whose prose is assembled from the
 * database, so the text is already grounded — it is narrower than a Driver
 * answer, not less trustworthy.
 */
async function fallback(db: Db, projectId: string, question: string, why: string): Promise<AskResponse> {
  const result = await answerQuestion(db, projectId, question);
  return { source: 'copilot-fallback', text: result.answer.answer, fellBackBecause: why };
}

export async function askDriver(
  db: Db,
  env: Record<string, string | undefined>,
  projectId: string,
  input: AskInput,
): Promise<AskResponse> {
  const project = await getProject(db, projectId);
  if (!project) throw new Error(`project ${projectId} not found`);

  const connector = createConversationalLlmConnector(env);
  if (!connector) {
    return fallback(db, projectId, input.question, 'no conversational model is configured on this deployment');
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

  try {
    const turn = await runTurn(
      {
        systemPrompt,
        question: input.question,
        ...(input.history ? { history: input.history } : {}),
      },
      {
        connector,
        runTool: (name, rawArguments) => runToolCall(ctx, name, rawArguments),
        ...(input.bounds ? { bounds: input.bounds } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );

    // A turn that hit its deadline before producing any text has nothing to
    // show. The deterministic answer is better than an empty one, and saying
    // which is which is the whole point of `source`.
    if (!turn.text) {
      return fallback(db, projectId, input.question, `the turn stopped early: ${turn.stopReason}`);
    }

    return { source: 'driver', text: turn.text, turn, modelEngine: connector.engine };
  } catch (error) {
    // §4.8: the vendor being down is not a reason for chat to fail.
    const why = error instanceof Error ? error.message : String(error);
    return fallback(db, projectId, input.question, why);
  }
}
