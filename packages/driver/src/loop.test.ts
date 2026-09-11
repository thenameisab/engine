import { describe, expect, it, vi } from 'vitest';
import type {
  LlmConversationalConnector,
  LlmMessage,
  LlmToolCall,
  LlmTurn,
  LlmTurnChunk,
} from '@engine/connectors';
import { READ_TOOLS } from './catalogue.js';
import { runTurn, toLlmTools, type TurnInput } from './loop.js';
import { buildSystemPrompt } from './prompt.js';

/**
 * The agent loop.
 *
 * The four bounds are the reason this file exists. A loop with no bounds still
 * answers the happy-path question correctly, and then spends an unbounded
 * number of rounds and an unbounded amount of a customer's time the first time
 * a model decides to keep calling tools. Each bound gets a test that proves it
 * binds, and each partial answer gets one that proves the caller can tell it
 * from a complete one.
 */

/** A connector that replays a scripted list of turns and records what it was sent. */
function scriptedConnector(turns: Partial<LlmTurn>[]): LlmConversationalConnector & {
  calls: { messages: LlmMessage[]; toolChoice: unknown; toolCount: number }[];
} {
  const calls: { messages: LlmMessage[]; toolChoice: unknown; toolCount: number }[] = [];
  let i = 0;
  return {
    engine: 'test',
    calls,
    async converse(messages, opts = {}) {
      // Structured-clone the transcript: the loop mutates its own array, and a
      // recorded reference would show the final state at every call site.
      calls.push({
        messages: JSON.parse(JSON.stringify(messages)) as LlmMessage[],
        toolChoice: opts.toolChoice,
        toolCount: opts.tools?.length ?? 0,
      });
      const turn = turns[i++] ?? { text: 'ran out of script' };
      return {
        text: turn.text ?? '',
        reasoning: turn.reasoning ?? '',
        toolCalls: turn.toolCalls ?? [],
        finishReason: turn.finishReason ?? 'stop',
        ...(turn.usage ? { usage: turn.usage } : {}),
        raw: {},
      };
    },
    async *streamConverse(): AsyncIterable<LlmTurnChunk> {
      throw new Error('the loop must not stream — see loop.ts');
    },
  };
}

function call(name: string, args = '{}', id = name): LlmToolCall {
  return { id, name, arguments: args };
}

const input: TurnInput = { systemPrompt: 'be truthful', question: 'how is search doing?' };

/** A runner that answers every tool with a marked envelope. */
const echoRunner = vi.fn(async (name: string) => `<tool_result name="${name}" state="ok">\n{}\n</tool_result>`);

describe('the happy path', () => {
  it('answers without calling a tool when the model does not ask for one', async () => {
    const connector = scriptedConnector([{ text: 'Search is fine.' }]);
    const result = await runTurn(input, { connector, runTool: echoRunner });

    expect(result.text).toBe('Search is fine.');
    expect(result.stopReason).toBe('answered');
    expect(result.partial).toBe(false);
    expect(result.rounds).toHaveLength(1);
    expect(connector.calls).toHaveLength(1);
  });

  it('runs a tool, feeds the result back, and answers on the next round', async () => {
    const connector = scriptedConnector([
      { toolCalls: [call('search_performance')] },
      { text: '1,200 clicks in the last 28 days.' },
    ]);
    const runTool = vi.fn(async () => '<tool_result name="search_performance" state="ok">\n{"clicks":1200}\n</tool_result>');

    const result = await runTurn(input, { connector, runTool });

    expect(runTool).toHaveBeenCalledWith('search_performance', '{}');
    expect(result.text).toBe('1,200 clicks in the last 28 days.');
    expect(result.stopReason).toBe('answered');
    expect(result.rounds[0]!.toolCalls).toHaveLength(1);

    // The second request carries the assistant's tool call and the tool reply,
    // in that order, which is the shape the vendor requires.
    const second = connector.calls[1]!.messages;
    expect(second.at(-2)).toMatchObject({ role: 'assistant', toolCalls: [{ id: 'search_performance' }] });
    expect(second.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'search_performance' });
  });

  it('places the system prompt first, then history, then the question', async () => {
    const history: LlmMessage[] = [
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
    ];
    const connector = scriptedConnector([{ text: 'ok' }]);
    await runTurn({ ...input, history }, { connector, runTool: echoRunner });

    expect(connector.calls[0]!.messages.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
  });

  it('returns the whole transcript, so step 4 can persist it', async () => {
    const connector = scriptedConnector([{ toolCalls: [call('site_health')] }, { text: 'Healthy.' }]);
    const result = await runTurn(input, { connector, runTool: echoRunner });

    expect(result.messages.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
  });
});

describe('bound: calls per round', () => {
  it('runs at most four and answers the rest without running them', async () => {
    const asked = [call('a', '{}', '1'), call('b', '{}', '2'), call('c', '{}', '3'), call('d', '{}', '4'), call('e', '{}', '5'), call('f', '{}', '6')];
    const connector = scriptedConnector([{ toolCalls: asked }, { text: 'done' }]);
    const runTool = vi.fn(async (name: string) => `<tool_result name="${name}" state="ok">\n{}\n</tool_result>`);

    const result = await runTurn(input, { connector, runTool });

    expect(runTool).toHaveBeenCalledTimes(4);
    const skipped = result.rounds[0]!.toolCalls.filter((c) => c.skipped);
    expect(skipped.map((c) => c.name)).toEqual(['e', 'f']);
    expect(skipped.every((c) => c.skipped === 'per-round-cap')).toBe(true);
  });

  it('still answers every call id, because the vendor rejects a request that does not', async () => {
    // This is the bug the cap would otherwise introduce: five ids on the
    // assistant message and four tool replies is a malformed conversation.
    const asked = Array.from({ length: 6 }, (_, i) => call(`t${i}`, '{}', `id${i}`));
    const connector = scriptedConnector([{ toolCalls: asked }, { text: 'done' }]);
    await runTurn(input, { connector, runTool: echoRunner });

    const second = connector.calls[1]!.messages;
    const assistant = second.find((m) => m.role === 'assistant') as Extract<LlmMessage, { role: 'assistant' }>;
    const answered = second.filter((m) => m.role === 'tool').map((m) => (m as Extract<LlmMessage, { role: 'tool' }>).toolCallId);

    expect(assistant.toolCalls!.map((c) => c.id).sort()).toEqual(answered.sort());
  });

  it('tells the model why a call did not run, so it can ask again', async () => {
    const asked = Array.from({ length: 5 }, (_, i) => call(`t${i}`, '{}', `id${i}`));
    const connector = scriptedConnector([{ toolCalls: asked }, { text: 'done' }]);
    await runTurn(input, { connector, runTool: echoRunner });

    const last = connector.calls[1]!.messages.at(-1) as Extract<LlmMessage, { role: 'tool' }>;
    expect(last.content).toContain('at most 4 tools may be called in one round');
    expect(last.content).toContain('Ask for it again in the next round');
  });

  it('runs a round concurrently rather than one call after another', async () => {
    let running = 0;
    let peak = 0;
    const runTool = vi.fn(async (name: string) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
      return `<tool_result name="${name}" state="ok">\n{}\n</tool_result>`;
    });
    const connector = scriptedConnector([
      { toolCalls: [call('a', '{}', '1'), call('b', '{}', '2'), call('c', '{}', '3')] },
      { text: 'done' },
    ]);

    await runTurn(input, { connector, runTool });
    expect(peak).toBe(3);
  });
});

describe('bound: rounds per turn', () => {
  it('stops after four rounds and forces an answer from what it gathered', async () => {
    const keepCalling = { toolCalls: [call('findings')] };
    const connector = scriptedConnector([
      keepCalling,
      keepCalling,
      keepCalling,
      keepCalling,
      { text: 'Here is what I found before running out of rounds.' },
    ]);

    const result = await runTurn(input, { connector, runTool: echoRunner });

    expect(result.stopReason).toBe('max-rounds');
    expect(result.partial).toBe(true);
    expect(result.text).toBe('Here is what I found before running out of rounds.');
    // Four tool-calling rounds, then one forced answer.
    expect(connector.calls).toHaveLength(5);
    expect(connector.calls[4]!.toolChoice).toBe('none');
  });

  it('forbids tools on the forced answer, which is what makes it terminate', async () => {
    const connector = scriptedConnector([
      { toolCalls: [call('findings')] },
      { text: 'partial answer' },
    ]);
    await runTurn(input, { connector, runTool: echoRunner, bounds: { maxRounds: 1 } });

    expect(connector.calls[0]!.toolChoice).toBe('auto');
    expect(connector.calls[0]!.toolCount).toBe(READ_TOOLS.length);
    expect(connector.calls[1]!.toolChoice).toBe('none');
    expect(connector.calls[1]!.toolCount).toBe(0);
  });

  it('reports no-answer when even the forced round produces nothing', async () => {
    const connector = scriptedConnector([{ toolCalls: [call('findings')] }, { text: '' }]);
    const result = await runTurn(input, { connector, runTool: echoRunner, bounds: { maxRounds: 1 } });

    expect(result.stopReason).toBe('no-answer');
    expect(result.partial).toBe(true);
  });
});

describe('bound: wall clock', () => {
  it('stops at the deadline and does not spend another call trying to answer', async () => {
    // The point of a deadline is not to wait longer. A forced answer round
    // would cost another five seconds on a turn that already ran out.
    let clock = 0;
    const connector = scriptedConnector([
      { toolCalls: [call('findings')] },
      { toolCalls: [call('site_health')] },
      { text: 'should never be reached' },
    ]);

    const result = await runTurn(input, {
      connector,
      runTool: echoRunner,
      bounds: { wallClockMs: 1_000 },
      now: () => (clock += 600),
    });

    expect(result.stopReason).toBe('deadline');
    expect(result.partial).toBe(true);
    expect(result.text).toBe('');
    expect(connector.calls.length).toBeLessThan(3);
  });

  it('checks the deadline before a round rather than after, so it cannot overshoot by a round', async () => {
    let clock = 0;
    const connector = scriptedConnector([{ text: 'never asked' }]);
    const result = await runTurn(input, {
      connector,
      runTool: echoRunner,
      bounds: { wallClockMs: 10 },
      now: () => (clock += 1_000),
    });

    expect(connector.calls).toHaveLength(0);
    expect(result.stopReason).toBe('deadline');
  });
});

describe('bound: tokens', () => {
  it('stops once the running total crosses the ceiling', async () => {
    const usage = { promptTokens: 5_000, completionTokens: 200, totalTokens: 5_200 };
    const connector = scriptedConnector([
      { toolCalls: [call('findings')], usage },
      { text: 'stopped early' },
    ]);

    const result = await runTurn(input, {
      connector,
      runTool: echoRunner,
      bounds: { maxTotalTokens: 5_000 },
    });

    expect(result.stopReason).toBe('token-budget');
    expect(result.usage.totalTokens).toBeGreaterThanOrEqual(5_200);
  });

  it('sums usage across rounds', async () => {
    const connector = scriptedConnector([
      { toolCalls: [call('findings')], usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } },
      { text: 'done', usage: { promptTokens: 400, completionTokens: 20, totalTokens: 420 } },
    ]);
    const result = await runTurn(input, { connector, runTool: echoRunner });

    expect(result.usage).toEqual({ promptTokens: 500, completionTokens: 30, totalTokens: 530 });
  });

  it('does not stop on a turn the vendor reported no usage for', async () => {
    // Unreported is not zero, but it is also not a reason to abandon a turn.
    const connector = scriptedConnector([{ toolCalls: [call('findings')] }, { text: 'done' }]);
    const result = await runTurn(input, { connector, runTool: echoRunner, bounds: { maxTotalTokens: 1 } });

    expect(result.stopReason).toBe('answered');
    expect(result.usage.totalTokens).toBe(0);
  });
});

describe('what the model is sent', () => {
  it('offers the whole read catalogue by default', async () => {
    const connector = scriptedConnector([{ text: 'ok' }]);
    await runTurn(input, { connector, runTool: echoRunner });
    expect(connector.calls[0]!.toolCount).toBe(19);
  });

  it('sends only the three fields the vendor defines, never tier, access or tables', async () => {
    // `tier` and `access` are ours to enforce and `tables` is provenance for
    // the reader. A model that can see a tier is a model that can reason about
    // one.
    for (const tool of toLlmTools(READ_TOOLS)) {
      expect(Object.keys(tool).sort()).toEqual(['description', 'name', 'parameters']);
    }
  });

  it('never streams — the probe measured SSE as the whole CPU cost of a turn', async () => {
    const connector = scriptedConnector([{ text: 'ok' }]);
    await expect(runTurn(input, { connector, runTool: echoRunner })).resolves.toBeTruthy();
  });
});

describe('a tool that fails does not fail the turn', () => {
  it('feeds the runner error back as a message and carries on', async () => {
    const connector = scriptedConnector([
      { toolCalls: [call('findings')] },
      { text: 'I could not read your findings.' },
    ]);
    const runTool = vi.fn(async () => '<tool_result name="findings" state="error">\n{"error":"connection reset"}\n</tool_result>');

    const result = await runTurn(input, { connector, runTool });

    expect(result.stopReason).toBe('answered');
    expect(connector.calls[1]!.messages.at(-1)).toMatchObject({ role: 'tool' });
  });

  it('propagates a model failure, because the caller degrades to the Copilot', async () => {
    const connector = scriptedConnector([]);
    connector.converse = async () => {
      throw new Error('Sarvam request failed: 503');
    };
    await expect(runTurn(input, { connector, runTool: echoRunner })).rejects.toThrow('503');
  });
});

describe('the system prompt', () => {
  const ctx = { domain: 'example.com', projectName: 'Example Co', today: '2026-09-11' };

  it('names the site, the date, and every tool the model may call', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('Example Co (example.com)');
    expect(prompt).toContain('2026-09-11');
    for (const tool of READ_TOOLS) expect(prompt, tool.name).toContain(tool.name);
  });

  it('carries the envelope rule from the module that emits the envelope', () => {
    expect(buildSystemPrompt(ctx)).toContain('</tool_result>');
  });

  it('names all four states and says why they differ', () => {
    const prompt = buildSystemPrompt(ctx);
    for (const state of ['"ok"', '"zero"', '"not-connected"', '"no-data-yet"']) {
      expect(prompt).toContain(state);
    }
    expect(prompt).toContain('no traffic when the truth');
  });

  it('states the grounding contract and that bands are not percentages', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('Every number you state must come from a tool result');
    expect(prompt).toMatch(/never as one percentage/);
  });

  it('says Driver cannot write, deploy, or send anything', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('cannot change anything, deploy anything, send email');
    expect(prompt).toContain('Fix Queue');
  });

  it('labels screen context as context, and puts it last so it cannot rewrite the rules', () => {
    const prompt = buildSystemPrompt({ ...ctx, screenContext: 'Findings: 3 open' });
    expect(prompt.indexOf('Findings: 3 open')).toBeGreaterThan(prompt.indexOf('Every number you state'));
    expect(prompt).toContain('Use it to interpret words like');
  });

  it('omits the screen section entirely when there is none', () => {
    expect(buildSystemPrompt(ctx)).not.toContain('currently looking at');
  });
});
