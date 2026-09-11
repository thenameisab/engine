/**
 * Driver conversations: the rows behind a thread, and who may read one.
 *
 * Two responsibilities that look like one and are not.
 *
 * **Audit** (§4.4). Everything a turn produced is stored: the question, every
 * tool call with its raw arguments and duration, every tool result, and the
 * answer. `threadTranscript` reads it back whole, because "where did that
 * number come from" is a question asked days later about a specific figure.
 *
 * **Replay.** What goes back to the model on the next turn is a strict subset:
 * the question and the answer, and nothing else. `loadHistory` is that subset
 * and `threadTranscript` is the audit. They are separate functions because they
 * are separate questions, and the difference is explained where `loadHistory`
 * is defined.
 */
import type { LlmMessage, LlmTokenUsage } from '@engine/connectors';
import type { RoundRecord } from '@engine/driver';
import type { Db } from '../db.js';

export type ThreadVisibility = 'private' | 'named' | 'organisation';

export interface DriverThread {
  id: string;
  projectId: string;
  createdBy: string;
  title: string | null;
  visibility: ThreadVisibility;
  createdAt: string;
  lastMessageAt: string;
}

interface ThreadRow {
  id: string;
  project_id: string;
  created_by: string;
  title: string | null;
  visibility: ThreadVisibility;
  created_at: Date;
  last_message_at: Date;
}

function toThread(row: ThreadRow): DriverThread {
  return {
    id: row.id,
    projectId: row.project_id,
    createdBy: row.created_by,
    title: row.title,
    visibility: row.visibility,
    createdAt: row.created_at.toISOString(),
    lastMessageAt: row.last_message_at.toISOString(),
  };
}

/* ── The read check ───────────────────────────────────────────────────────── */

/**
 * May this user read this thread?
 *
 * §9a decision 4's three states, in one query, and self-contained on purpose.
 * `organisation` means "any member of the account that owns this project", not
 * "anyone who got this far" — the membership join is here rather than left to
 * `projectAccessError` upstream, so the function is true to its name when it is
 * called from somewhere that forgot the guard. Every route calls both anyway;
 * this is the layer that does not depend on that being remembered.
 *
 * `projectId` is matched as well as `threadId` so a thread id from one project
 * cannot be read through another project's route, where the caller's membership
 * may well be genuine.
 *
 * Returns the thread rather than a boolean, because every caller needs it next
 * and a second read would be a second chance to read a different row.
 */
export async function readableThread(
  db: Db,
  projectId: string,
  threadId: string,
  userId: string,
): Promise<DriverThread | null> {
  const [row] = await db<ThreadRow[]>`
    select t.id, t.project_id, t.created_by, t.title, t.visibility, t.created_at, t.last_message_at
    from driver_threads t
    where t.id = ${threadId}
      and t.project_id = ${projectId}
      and (
        t.created_by = ${userId}
        or (
          t.visibility = 'organisation'
          and exists (
            select 1 from projects p
            join account_members am on am.account_id = p.account_id
            where p.id = t.project_id and am.user_id = ${userId}
          )
        )
        or (
          t.visibility = 'named'
          and exists (
            select 1 from driver_thread_shares s
            where s.thread_id = t.id and s.user_id = ${userId}
          )
        )
      )
    limit 1
  `;
  return row ? toThread(row) : null;
}

/** Every thread in this project this user may read, most recently active first. */
export async function listReadableThreads(
  db: Db,
  projectId: string,
  userId: string,
  limit = 50,
): Promise<DriverThread[]> {
  const rows = await db<ThreadRow[]>`
    select t.id, t.project_id, t.created_by, t.title, t.visibility, t.created_at, t.last_message_at
    from driver_threads t
    where t.project_id = ${projectId}
      and (
        t.created_by = ${userId}
        or (
          t.visibility = 'organisation'
          and exists (
            select 1 from projects p
            join account_members am on am.account_id = p.account_id
            where p.id = t.project_id and am.user_id = ${userId}
          )
        )
        or (
          t.visibility = 'named'
          and exists (
            select 1 from driver_thread_shares s
            where s.thread_id = t.id and s.user_id = ${userId}
          )
        )
      )
    order by t.last_message_at desc
    limit ${limit}
  `;
  return rows.map(toThread);
}

/* ── Replay ───────────────────────────────────────────────────────────────── */

/**
 * How many stored messages a new turn may replay.
 *
 * The probe measured one worst-case turn at 12% of the 128K window, so a single
 * turn never binds. A long thread does, and nothing else bounds it, so the
 * bound is here. Twenty messages is ten exchanges — past the point where a
 * follow-up still refers to the first question.
 */
export const MAX_REPLAYED_MESSAGES = 20;

/**
 * The thread as the model should see it: questions and answers, no tool traffic.
 *
 * Three reasons the stored tool calls and results are deliberately not replayed,
 * in the order they matter.
 *
 * **Security.** §4.7's untrusted content — crawled page text, third-party AI
 * answers, competitor pages — enters the transcript as a tool result. Replaying
 * it re-injects it into every later turn of the thread, so one poisoned page
 * read once would keep arguing its case for the rest of the conversation.
 * Dropping tool messages confines that content to the turn that fetched it.
 *
 * **Cost.** Tool results are the bulk of a turn's tokens. Replaying them makes
 * a thread's cost quadratic in its length for data the model has already read
 * and summarised.
 *
 * **Freshness.** A tool result is a measurement with a timestamp. Replaying
 * yesterday's rows invites the model to answer today's question from them; a
 * second call to the same tool is cheap and correct.
 *
 * The cost of this choice is that the model cannot re-derive a figure it did not
 * put in its own answer, and has to call the tool again. That is the intended
 * behaviour, not a regression.
 *
 * Assistant rows with no content are skipped: those are the pure tool-call turns,
 * and an assistant message carrying `tool_calls` with no `tool` messages after it
 * is rejected by the vendor.
 */
export async function loadHistory(db: Db, threadId: string): Promise<LlmMessage[]> {
  const rows = await db<{ role: string; content: string | null }[]>`
    select role, content from (
      select role, content, seq from driver_messages
      where thread_id = ${threadId}
        and role in ('user', 'assistant')
        and content is not null
      order by seq desc
      limit ${MAX_REPLAYED_MESSAGES}
    ) recent
    order by seq asc
  `;

  // A window taken from the end can open on an answer whose question fell
  // outside it. Advance to the first question so the replay starts on a whole
  // exchange rather than on a reply to something the model cannot see.
  const start = rows.findIndex((r) => r.role === 'user');
  if (start === -1) return [];

  return rows.slice(start).map((r) =>
    r.role === 'user'
      ? ({ role: 'user', content: r.content ?? '' } as const)
      : ({ role: 'assistant', content: r.content } as const),
  );
}

/* ── Writing a turn ───────────────────────────────────────────────────────── */

export interface PersistTurnInput {
  projectId: string;
  userId: string;
  /** Continue this thread. Absent starts one, and the caller gets its id back. */
  threadId?: string;
  /** The question, used for the title when a thread is being created. */
  question: string;
  /**
   * Everything the turn added, in order: the user message, then the assistant
   * and tool messages the loop produced. The system message and the replayed
   * history are already excluded by the caller.
   */
  messages: readonly LlmMessage[];
  /** The loop's audit trail, or empty when the deterministic fallback answered. */
  rounds: readonly RoundRecord[];
  modelId?: string;
  usage?: LlmTokenUsage;
}

/** A title from the question. Long enough to tell two threads apart, short enough to list. */
function titleFrom(question: string): string {
  const clean = question.replace(/\s+/g, ' ').trim();
  return clean.length <= 80 ? clean : `${clean.slice(0, 79)}…`;
}

/**
 * Store one turn, creating the thread if this is the first.
 *
 * One transaction. A thread whose question was stored and whose answer was not
 * would replay as an unanswered question on the next turn, and a tool call
 * stored without the message that requested it is an audit trail with a hole in
 * it. Both are the same fact and are written together or not at all.
 *
 * Written after the answer exists rather than before it, so a turn the vendor
 * never answered leaves no empty thread behind. The fallback path in `ask.ts`
 * always produces text, so there is always something to store.
 */
export async function persistTurn(db: Db, input: PersistTurnInput): Promise<string> {
  // The model's calls, by the vendor id that appears on the assistant message.
  // Built once outside the transaction: it is a reshaping of data already in
  // hand, and holding a transaction open to do it buys nothing.
  const callsById = new Map(
    input.rounds.flatMap((round) => round.toolCalls.map((call) => [call.id, call] as const)),
  );

  // Usage is the whole turn's, so it goes on one message rather than on each.
  // A turn with a tool round and an answer has two assistant messages; writing
  // the total on both would make `sum(prompt_tokens)` over a thread report
  // roughly double what the turn cost. The answer is the message that carries
  // it, because that is the one a reader is looking at when they ask.
  let lastAssistant = -1;
  input.messages.forEach((m, i) => {
    if (m.role === 'assistant') lastAssistant = i;
  });

  return db.begin(async (tx) => {
    let threadId = input.threadId;
    if (threadId) {
      // This must stay ahead of the `max(seq)` read below, and not be moved to
      // the end as a tidier-looking "touch the thread when done". The update
      // takes a row lock on the thread, so a second turn on the same thread
      // blocks here and reads a `max(seq)` that already includes this turn's
      // rows. Without it both turns compute the same next sequence number and
      // the second one dies on `unique (thread_id, seq)`, losing a whole answer
      // to a unique-violation rollback.
      await tx`update driver_threads set last_message_at = now() where id = ${threadId}`;
    } else {
      const [created] = await tx<{ id: string }[]>`
        insert into driver_threads (project_id, created_by, title)
        values (${input.projectId}, ${input.userId}, ${titleFrom(input.question)})
        returning id
      `;
      threadId = created.id;
    }

    const [{ next }] = await tx<{ next: number }[]>`
      select coalesce(max(seq), 0) + 1 as next from driver_messages where thread_id = ${threadId}
    `;

    let seq = Number(next);
    for (const [index, message] of input.messages.entries()) {
      // The model id goes on every assistant message — each one came from that
      // model — and the usage only on the last, for the reason above. Both are
      // written only when reported: `readWireUsage` returns undefined rather
      // than zeros when the vendor said nothing, and storing zeros would read
      // back as a turn that cost nothing rather than one never measured.
      const assistant = message.role === 'assistant';
      const carriesUsage = index === lastAssistant && input.usage !== undefined;
      // Empty text is stored as null, not as an empty string. A turn that
      // produced no prose and a turn that produced the empty string are the
      // same fact, and `loadHistory` filters on null — an empty assistant
      // message replayed into the next turn is a message that says nothing and
      // still costs a slot in the window.
      const content = 'content' in message && message.content !== '' ? message.content : null;
      const [row] = await tx<{ id: string }[]>`
        insert into driver_messages (thread_id, seq, role, content, tool_call_id, model_id, prompt_tokens, completion_tokens)
        values (
          ${threadId},
          ${seq},
          ${message.role},
          ${content},
          ${message.role === 'tool' ? message.toolCallId : null},
          ${assistant ? input.modelId ?? null : null},
          ${carriesUsage ? input.usage!.promptTokens : null},
          ${carriesUsage ? input.usage!.completionTokens : null}
        )
        returning id
      `;
      seq += 1;

      if (message.role !== 'assistant' || !message.toolCalls) continue;
      for (const call of message.toolCalls) {
        const record = callsById.get(call.id);
        await tx`
          insert into driver_tool_calls (message_id, tool_call_id, name, arguments, duration_ms, skipped)
          values (
            ${row.id}, ${call.id}, ${call.name}, ${call.arguments},
            ${record?.durationMs ?? null}, ${record?.skipped ?? null}
          )
        `;
      }
    }

    return threadId;
  });
}

/* ── Reading a thread back ────────────────────────────────────────────────── */

export interface TranscriptToolCall {
  id: string;
  name: string;
  arguments: string;
  durationMs: number | null;
  skipped: string | null;
  error: string | null;
  /** The envelope the tool returned, from the `tool` message that answered it. */
  result: string | null;
}

export interface TranscriptMessage {
  id: string;
  seq: number;
  role: 'user' | 'assistant' | 'tool';
  content: string | null;
  toolCallId: string | null;
  modelId: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  createdAt: string;
  toolCalls: TranscriptToolCall[];
}

/**
 * The whole thread, tool calls attached to the message that asked for them and
 * each call carrying the result that answered it.
 *
 * The joining is done here rather than in SQL because the result lives on a
 * different row of the same table, matched by the vendor's call id — a self
 * join that reads worse than the two loops below and returns the same thing.
 */
export async function threadTranscript(db: Db, threadId: string): Promise<TranscriptMessage[]> {
  const rows = await db<{
    id: string;
    seq: number;
    role: TranscriptMessage['role'];
    content: string | null;
    tool_call_id: string | null;
    model_id: string | null;
    prompt_tokens: number | null;
    completion_tokens: number | null;
    created_at: Date;
  }[]>`
    select id, seq, role, content, tool_call_id, model_id, prompt_tokens, completion_tokens, created_at
    from driver_messages where thread_id = ${threadId} order by seq asc
  `;
  if (rows.length === 0) return [];

  const calls = await db<{
    message_id: string;
    tool_call_id: string;
    name: string;
    arguments: string;
    duration_ms: number | null;
    skipped: string | null;
    error: string | null;
  }[]>`
    select c.message_id, c.tool_call_id, c.name, c.arguments, c.duration_ms, c.skipped, c.error
    from driver_tool_calls c
    join driver_messages m on m.id = c.message_id
    where m.thread_id = ${threadId}
    order by c.created_at asc
  `;

  const resultFor = new Map(
    rows.filter((r) => r.role === 'tool' && r.tool_call_id).map((r) => [r.tool_call_id!, r.content]),
  );

  const byMessage = new Map<string, TranscriptToolCall[]>();
  for (const call of calls) {
    const list = byMessage.get(call.message_id) ?? [];
    list.push({
      id: call.tool_call_id,
      name: call.name,
      arguments: call.arguments,
      durationMs: call.duration_ms,
      skipped: call.skipped,
      error: call.error,
      result: resultFor.get(call.tool_call_id) ?? null,
    });
    byMessage.set(call.message_id, list);
  }

  return rows.map((r) => ({
    id: r.id,
    seq: r.seq,
    role: r.role,
    content: r.content,
    toolCallId: r.tool_call_id,
    modelId: r.model_id,
    promptTokens: r.prompt_tokens,
    completionTokens: r.completion_tokens,
    createdAt: r.created_at.toISOString(),
    toolCalls: byMessage.get(r.id) ?? [],
  }));
}

/* ── Ownership, visibility and shares ─────────────────────────────────────── */

/**
 * Change a thread's title, its visibility, or both. Author only.
 *
 * Only the author, not every account member: `organisation` visibility grants a
 * read, and a reader who could then make the thread private would be taking
 * someone else's conversation away from them.
 */
export async function updateThread(
  db: Db,
  threadId: string,
  authorId: string,
  patch: { title?: string; visibility?: ThreadVisibility },
): Promise<DriverThread | null> {
  const [row] = await db<ThreadRow[]>`
    update driver_threads set
      title = coalesce(${patch.title ?? null}, title),
      visibility = coalesce(${patch.visibility ?? null}, visibility)
    where id = ${threadId} and created_by = ${authorId}
    returning id, project_id, created_by, title, visibility, created_at, last_message_at
  `;
  return row ? toThread(row) : null;
}

export interface ThreadShare {
  userId: string;
  email: string | null;
  name: string | null;
  sharedBy: string | null;
  createdAt: string;
}

export async function listThreadShares(db: Db, threadId: string): Promise<ThreadShare[]> {
  const rows = await db<{
    user_id: string;
    email: string | null;
    name: string | null;
    shared_by: string | null;
    created_at: Date;
  }[]>`
    select s.user_id, u.email, u.name, s.shared_by, s.created_at
    from driver_thread_shares s
    left join users u on u.id = s.user_id
    where s.thread_id = ${threadId}
    order by s.created_at asc
  `;
  return rows.map((r) => ({
    userId: r.user_id,
    email: r.email,
    name: r.name,
    sharedBy: r.shared_by,
    createdAt: r.created_at.toISOString(),
  }));
}

/**
 * Share with one person, and open the door if it was shut.
 *
 * `visibility` is the authority and the share table is the recipient list: the
 * read check consults the list only when visibility is `named`, so a share row
 * on a private thread grants nothing. That separation is what lets a thread go
 * organisation-wide and come back to the same people later, but it would make
 * "share with Priya" a two-step act that silently does nothing on step one. So
 * a share promotes `private` to `named` in the same transaction.
 *
 * `organisation` is left alone. It already grants more than this share does,
 * and narrowing a thread is a decision to take deliberately, not a side effect
 * of adding someone to it.
 *
 * Re-sharing is not an error; it keeps the original row and its `shared_by`.
 */
export async function shareThread(
  db: Db,
  threadId: string,
  userId: string,
  sharedBy: string,
): Promise<void> {
  await db.begin(async (tx) => {
    await tx`
      insert into driver_thread_shares (thread_id, user_id, shared_by)
      values (${threadId}, ${userId}, ${sharedBy})
      on conflict (thread_id, user_id) do nothing
    `;
    await tx`
      update driver_threads set visibility = 'named'
      where id = ${threadId} and visibility = 'private'
    `;
  });
}

/** Remove one person's share. Returns false when there was nothing to remove. */
export async function unshareThread(db: Db, threadId: string, userId: string): Promise<boolean> {
  const rows = await db<{ user_id: string }[]>`
    delete from driver_thread_shares
    where thread_id = ${threadId} and user_id = ${userId}
    returning user_id
  `;
  return rows.length === 1;
}
