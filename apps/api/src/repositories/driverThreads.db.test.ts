import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.js';
import {
  MAX_REPLAYED_MESSAGES,
  listReadableThreads,
  listThreadShares,
  loadHistory,
  persistTurn,
  readableThread,
  shareThread,
  threadTranscript,
  unshareThread,
  updateThread,
} from './driverThreads.js';

/**
 * Driver conversation storage, against a real Postgres.
 *
 * Two things are being proved here and they pull in opposite directions.
 *
 * **Everything is stored.** A tool call with its raw arguments, its duration
 * and the envelope it returned, attached to the message that asked for it —
 * §4.4's answer to "where did that number come from", asked three days later.
 *
 * **Almost nothing is replayed.** What goes back to the model on the next turn
 * is the questions and the answers, and none of the tool traffic. The reason is
 * in `loadHistory`, and the test that matters most is the one asserting a tool
 * result does not survive into a later turn.
 *
 * Runs only when `TEST_DATABASE_URL` points at a migrated database.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('driver threads (Postgres)', () => {
  let db: Db;
  let accountId: string;
  let projectId: string;
  /** A second project in a second account, to prove a thread id does not travel. */
  let otherProjectId: string;

  const author = `user-author-${crypto.randomUUID()}`;
  const colleague = `user-colleague-${crypto.randomUUID()}`;
  const outsider = `user-outsider-${crypto.randomUUID()}`;

  beforeAll(async () => {
    db = createDb(url!);
    const [account] = await db<{ id: string }[]>`
      insert into accounts (name) values (${`threads ${crypto.randomUUID()}`}) returning id
    `;
    accountId = account.id;
    const [project] = await db<{ id: string }[]>`
      insert into projects (account_id, name, domain)
      values (${accountId}, 'Threads Co', 'threads.example') returning id
    `;
    projectId = project.id;

    const [otherAccount] = await db<{ id: string }[]>`
      insert into accounts (name) values (${`threads-other ${crypto.randomUUID()}`}) returning id
    `;
    const [otherProject] = await db<{ id: string }[]>`
      insert into projects (account_id, name, domain)
      values (${otherAccount.id}, 'Other Co', 'other.example') returning id
    `;
    otherProjectId = otherProject.id;

    for (const id of [author, colleague, outsider]) {
      await db`insert into users (id, email) values (${id}, ${`${id}@example.com`})`;
    }
    for (const id of [author, colleague]) {
      await db`insert into account_members (account_id, user_id, role) values (${accountId}, ${id}, 'member')`;
    }
  });

  afterAll(async () => {
    await db`delete from accounts where id::text = ${accountId}`;
    await db`delete from projects where id::text = ${otherProjectId}`;
    await db`delete from users where id = any(${[author, colleague, outsider]})`;
    await db.end();
  });

  beforeEach(async () => {
    await db`delete from driver_threads where project_id::text in (${projectId}, ${otherProjectId})`;
  });

  /** A turn shaped the way the loop returns one: question, tool round, answer. */
  function turnWithTool() {
    return {
      messages: [
        { role: 'user', content: 'how healthy is the site?' },
        {
          role: 'assistant',
          content: null,
          toolCalls: [{ id: 'call_1', name: 'site_health', arguments: '{"period":28}' }],
        },
        { role: 'tool', toolCallId: 'call_1', content: '<tool_result name="site_health" state="ok">{"healthScore":73}</tool_result>' },
        { role: 'assistant', content: 'Your health score is 73.' },
      ] as const,
      rounds: [
        {
          round: 1,
          durationMs: 5200,
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'call_1', name: 'site_health', arguments: '{"period":28}', durationMs: 31 }],
        },
        { round: 2, durationMs: 1800, finishReason: 'stop', toolCalls: [] },
      ] as const,
    };
  }

  /* ── storing a turn ─────────────────────────────────────────────────────── */

  it('creates a thread on the first turn and titles it from the question', async () => {
    const { messages, rounds } = turnWithTool();
    const threadId = await persistTurn(db, {
      projectId,
      userId: author,
      question: 'how healthy is the site?',
      messages: [...messages],
      rounds: [...rounds],
      modelId: 'sarvam-105b',
      usage: { promptTokens: 900, completionTokens: 40, totalTokens: 940 },
    });

    const thread = await readableThread(db, projectId, threadId, author);
    expect(thread!.title).toBe('how healthy is the site?');
    expect(thread!.visibility).toBe('private');
    expect(thread!.createdBy).toBe(author);
  });

  it('stores every message in order, and every tool call against the message that asked', async () => {
    const { messages, rounds } = turnWithTool();
    const threadId = await persistTurn(db, {
      projectId,
      userId: author,
      question: 'how healthy is the site?',
      messages: [...messages],
      rounds: [...rounds],
      modelId: 'sarvam-105b',
      usage: { promptTokens: 900, completionTokens: 40, totalTokens: 940 },
    });

    const transcript = await threadTranscript(db, threadId);
    expect(transcript.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(transcript.map((m) => m.seq)).toEqual([1, 2, 3, 4]);

    // The audit answer: the call, its raw arguments, its cost, and the rows it
    // returned — all reachable from the assistant turn that asked for it.
    const [call] = transcript[1]!.toolCalls;
    expect(call).toMatchObject({ name: 'site_health', arguments: '{"period":28}', durationMs: 31 });
    expect(call!.result).toContain('"healthScore":73');

    // The model belongs to every assistant turn; the usage is the whole turn's
    // and lands on the answer alone, so summing the column over a thread
    // reports what it cost rather than roughly double.
    expect(transcript[0]!.modelId).toBeNull();
    expect(transcript[1]!.modelId).toBe('sarvam-105b');
    expect(transcript[1]!.promptTokens).toBeNull();
    expect(transcript[3]!.modelId).toBe('sarvam-105b');
    expect(transcript[3]!.promptTokens).toBe(900);

    const [{ total }] = await db<{ total: number }[]>`
      select coalesce(sum(prompt_tokens), 0)::int as total from driver_messages
      where thread_id = ${threadId}
    `;
    expect(total).toBe(900);
  });

  it('appends a second turn to the same thread rather than starting another', async () => {
    const first = await persistTurn(db, {
      projectId,
      userId: author,
      question: 'first question',
      messages: [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'first answer' },
      ],
      rounds: [],
    });
    const second = await persistTurn(db, {
      projectId,
      userId: author,
      threadId: first,
      question: 'second question',
      messages: [
        { role: 'user', content: 'second question' },
        { role: 'assistant', content: 'second answer' },
      ],
      rounds: [],
    });

    expect(second).toBe(first);
    const transcript = await threadTranscript(db, first);
    expect(transcript.map((m) => m.seq)).toEqual([1, 2, 3, 4]);
    expect(transcript.map((m) => m.content)).toEqual([
      'first question',
      'first answer',
      'second question',
      'second answer',
    ]);
  });

  it('stores an answerless assistant turn as null rather than an empty string', async () => {
    const threadId = await persistTurn(db, {
      projectId,
      userId: author,
      question: 'a question',
      messages: [
        { role: 'user', content: 'a question' },
        { role: 'assistant', content: '' },
      ],
      rounds: [],
    });
    const transcript = await threadTranscript(db, threadId);
    expect(transcript[1]!.content).toBeNull();
  });

  /* ── what the next turn replays ─────────────────────────────────────────── */

  it('replays the question and the answer, and none of the tool traffic', async () => {
    const { messages, rounds } = turnWithTool();
    const threadId = await persistTurn(db, {
      projectId,
      userId: author,
      question: 'how healthy is the site?',
      messages: [...messages],
      rounds: [...rounds],
    });

    const history = await loadHistory(db, threadId);
    expect(history).toEqual([
      { role: 'user', content: 'how healthy is the site?' },
      { role: 'assistant', content: 'Your health score is 73.' },
    ]);

    // The point of the exclusion, stated as an assertion: §4.7's untrusted
    // content enters as a tool result, and a result replayed every turn would
    // keep arguing its case for the rest of the conversation.
    expect(JSON.stringify(history)).not.toContain('healthScore');
    expect(history.some((m) => m.role === 'tool')).toBe(false);
  });

  it('caps the replay and starts it on a question, never on an orphaned answer', async () => {
    const [thread] = await db<{ id: string }[]>`
      insert into driver_threads (project_id, created_by, title)
      values (${projectId}, ${author}, 'long') returning id
    `;
    // One more than the cap, so the window opens mid-exchange on an answer
    // whose question falls outside it.
    const total = MAX_REPLAYED_MESSAGES + 1;
    for (let seq = 1; seq <= total; seq += 1) {
      const role = seq % 2 === 1 ? 'user' : 'assistant';
      await db`
        insert into driver_messages (thread_id, seq, role, content)
        values (${thread.id}, ${seq}, ${role}, ${`m${seq}`})
      `;
    }

    const history = await loadHistory(db, thread.id);
    expect(history.length).toBeLessThanOrEqual(MAX_REPLAYED_MESSAGES);
    expect(history[0]!.role).toBe('user');
    // The window is the tail, so the last message stored is the last replayed.
    expect(history.at(-1)!.content).toBe(`m${total}`);
  });

  /* ── who may read it ────────────────────────────────────────────────────── */

  async function threadOwnedByAuthor(visibility: 'private' | 'named' | 'organisation') {
    const [row] = await db<{ id: string }[]>`
      insert into driver_threads (project_id, created_by, title, visibility)
      values (${projectId}, ${author}, 'a thread', ${visibility}) returning id
    `;
    return row.id;
  }

  it('lets the author read their own private thread', async () => {
    const id = await threadOwnedByAuthor('private');
    expect(await readableThread(db, projectId, id, author)).not.toBeNull();
  });

  it('hides a private thread from another member of the same account', async () => {
    const id = await threadOwnedByAuthor('private');
    expect(await readableThread(db, projectId, id, colleague)).toBeNull();
  });

  it('shows an organisation thread to another member', async () => {
    const id = await threadOwnedByAuthor('organisation');
    expect(await readableThread(db, projectId, id, colleague)).not.toBeNull();
  });

  it('shows a named thread only to the people it was shared with', async () => {
    const id = await threadOwnedByAuthor('named');
    expect(await readableThread(db, projectId, id, colleague)).toBeNull();

    await shareThread(db, id, colleague, author);
    expect(await readableThread(db, projectId, id, colleague)).not.toBeNull();
    expect((await listThreadShares(db, id))[0]).toMatchObject({ userId: colleague, sharedBy: author });

    expect(await unshareThread(db, id, colleague)).toBe(true);
    expect(await readableThread(db, projectId, id, colleague)).toBeNull();
  });

  it('does not leak a thread through another project the reader belongs to', async () => {
    // The caller is a genuine member of `otherProjectId`'s route in this test's
    // terms; the thread still belongs to a different project and must not
    // resolve through it.
    const id = await threadOwnedByAuthor('organisation');
    expect(await readableThread(db, otherProjectId, id, author)).toBeNull();
  });

  it('treats visibility as the authority, not the share list', async () => {
    // The read check consults the share table only on the `named` branch. A row
    // left behind after a thread was made private again grants nothing, which
    // is what lets the list survive a round trip through `organisation`.
    const id = await threadOwnedByAuthor('private');
    await db`insert into driver_thread_shares (thread_id, user_id, shared_by) values (${id}, ${colleague}, ${author})`;
    expect(await readableThread(db, projectId, id, colleague)).toBeNull();
  });

  it('opens a private thread when someone is added to it', async () => {
    // Otherwise "share with a colleague" is a two-step act whose first step
    // silently does nothing.
    const id = await threadOwnedByAuthor('private');
    await shareThread(db, id, colleague, author);
    expect((await readableThread(db, projectId, id, author))!.visibility).toBe('named');
    expect(await readableThread(db, projectId, id, colleague)).not.toBeNull();
  });

  it('does not narrow an organisation thread by sharing with one person', async () => {
    const id = await threadOwnedByAuthor('organisation');
    await shareThread(db, id, colleague, author);
    expect((await readableThread(db, projectId, id, author))!.visibility).toBe('organisation');
  });

  it('lists only the threads a person may open', async () => {
    const mine = await threadOwnedByAuthor('private');
    const shared = await threadOwnedByAuthor('organisation');

    expect((await listReadableThreads(db, projectId, author)).map((t) => t.id).sort())
      .toEqual([mine, shared].sort());
    expect((await listReadableThreads(db, projectId, colleague)).map((t) => t.id)).toEqual([shared]);
    expect(await listReadableThreads(db, projectId, outsider)).toEqual([]);
  });

  /* ── changing a thread ──────────────────────────────────────────────────── */

  it('lets the author change visibility and title, and nobody else', async () => {
    const id = await threadOwnedByAuthor('private');

    const updated = await updateThread(db, id, author, { visibility: 'organisation', title: 'renamed' });
    expect(updated).toMatchObject({ visibility: 'organisation', title: 'renamed' });

    // A colleague can now read it, and still cannot take it away.
    expect(await readableThread(db, projectId, id, colleague)).not.toBeNull();
    expect(await updateThread(db, id, colleague, { visibility: 'private' })).toBeNull();
    expect((await readableThread(db, projectId, id, author))!.visibility).toBe('organisation');
  });

  it('changes only the field it was given', async () => {
    const id = await threadOwnedByAuthor('named');
    await updateThread(db, id, author, { title: 'just the title' });
    const thread = await readableThread(db, projectId, id, author);
    expect(thread).toMatchObject({ title: 'just the title', visibility: 'named' });
  });
});
