import { describe, it, expect } from 'vitest';
import {
  ToolCallAccumulator,
  readWireToolCalls,
  toWireMessage,
  toWireToolChoice,
  toWireTools,
} from './llmTools.js';

describe('the OpenAI-shaped wire format', () => {
  it('sends each role in the shape the vendor expects', () => {
    expect(toWireMessage({ role: 'system', content: 'be brief' })).toEqual({ role: 'system', content: 'be brief' });
    expect(toWireMessage({ role: 'user', content: 'who?' })).toEqual({ role: 'user', content: 'who?' });
    expect(toWireMessage({ role: 'tool', toolCallId: 'call_1', content: '{"rows":2}' })).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: '{"rows":2}',
    });
  });

  it('carries an assistant turn that asked for tools, with no text of its own', () => {
    expect(
      toWireMessage({
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'call_1', name: 'site_health', arguments: '{}' }],
      }),
    ).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'site_health', arguments: '{}' } }],
    });
  });

  it('omits tool_calls entirely when a turn called nothing', () => {
    // Not `tool_calls: []`. Some Chat Completions servers reject the empty
    // array outright, and it says something different from a turn that made
    // no calls.
    expect(toWireMessage({ role: 'assistant', content: 'here you go', toolCalls: [] })).toEqual({
      role: 'assistant',
      content: 'here you go',
    });
  });

  it('wraps each tool in the function envelope', () => {
    expect(
      toWireTools([{ name: 'top_queries', description: 'Queries that bring people here', parameters: { type: 'object' } }]),
    ).toEqual([
      {
        type: 'function',
        function: { name: 'top_queries', description: 'Queries that bring people here', parameters: { type: 'object' } },
      },
    ]);
  });

  it('sends a tool choice as an enum or as one forced function', () => {
    expect(toWireToolChoice('auto')).toBe('auto');
    expect(toWireToolChoice('required')).toBe('required');
    // Forcing one tool is also how structured output is obtained on this
    // vendor: force a tool whose parameters are the schema you want back.
    expect(toWireToolChoice({ name: 'site_health' })).toEqual({ type: 'function', function: { name: 'site_health' } });
  });
});

describe('reading tool calls off a completed message', () => {
  it('reads id, name and the arguments verbatim, unparsed', () => {
    expect(
      readWireToolCalls([{ id: 'call_9', function: { name: 'findings', arguments: '{"severity":"high"}' } }]),
    ).toEqual([{ id: 'call_9', name: 'findings', arguments: '{"severity":"high"}' }]);
  });

  it('defaults absent arguments to an empty object', () => {
    // A tool with no required parameters is legitimately called with none,
    // and the vendor omits the field rather than sending `{}`.
    expect(readWireToolCalls([{ id: 'c', function: { name: 'site_health' } }])[0]!.arguments).toBe('{}');
  });

  it('drops a call that names nothing to run', () => {
    expect(readWireToolCalls([{ id: 'c', function: { arguments: '{}' } }])).toEqual([]);
    expect(readWireToolCalls(undefined)).toEqual([]);
  });

  it('invents an id only when the vendor sent none', () => {
    expect(readWireToolCalls([{ function: { name: 'site_health' } }])[0]!.id).toBe('call_0');
  });
});

describe('ToolCallAccumulator', () => {
  it('stitches one call together from the fragments it arrives in', () => {
    const acc = new ToolCallAccumulator();
    acc.absorb({ index: 0, id: 'call_1', function: { name: 'top_queries', arguments: '{"per' } });
    acc.absorb({ index: 0, function: { arguments: 'iod":' } });
    acc.absorb({ index: 0, function: { arguments: '"28d"}' } });
    expect(acc.drain()).toEqual([{ id: 'call_1', name: 'top_queries', arguments: '{"period":"28d"}' }]);
  });

  it('keeps two interleaved calls apart by index, not by arrival order', () => {
    // This is the case the parallel-tool-call probe exists to answer. Keyed
    // from the start so whatever the probe finds changes nothing here: a
    // fragment stream that interleaves two calls is stitched correctly, and
    // one that never interleaves is the same code path.
    const acc = new ToolCallAccumulator();
    acc.absorb({ index: 0, id: 'a', function: { name: 'top_queries', arguments: '{"a"' } });
    acc.absorb({ index: 1, id: 'b', function: { name: 'top_pages', arguments: '{"b"' } });
    acc.absorb({ index: 0, function: { arguments: ':1}' } });
    acc.absorb({ index: 1, function: { arguments: ':2}' } });
    expect(acc.drain()).toEqual([
      { id: 'a', name: 'top_queries', arguments: '{"a":1}' },
      { id: 'b', name: 'top_pages', arguments: '{"b":2}' },
    ]);
  });

  it('announces a call once, as soon as its name is known', () => {
    // The name is what lets a screen say which tool is running. It arrives
    // well before the arguments finish, and announcing it on every later
    // fragment would say it four times.
    const acc = new ToolCallAccumulator();
    expect(acc.absorb({ index: 0, id: 'a', function: { name: 'site_health' } })).toEqual({
      id: 'a',
      name: 'site_health',
    });
    expect(acc.absorb({ index: 0, function: { arguments: '{}' } })).toBeNull();
    expect(acc.absorb({ index: 1, id: 'b', function: { name: 'fix_queue' } })).toEqual({ id: 'b', name: 'fix_queue' });
  });

  it('stitches a name that itself arrives in two fragments', () => {
    const acc = new ToolCallAccumulator();
    expect(acc.absorb({ index: 0, id: 'a', function: { name: 'top_' } })).toEqual({ id: 'a', name: 'top_' });
    acc.absorb({ index: 0, function: { name: 'queries' } });
    expect(acc.drain()[0]!.name).toBe('top_queries');
  });

  it('treats a fragment with no index as the first call', () => {
    const acc = new ToolCallAccumulator();
    acc.absorb({ id: 'a', function: { name: 'site_health', arguments: '{}' } });
    expect(acc.drain()).toEqual([{ id: 'a', name: 'site_health', arguments: '{}' }]);
  });

  it('drops an index that never produced a name, and defaults empty arguments', () => {
    const acc = new ToolCallAccumulator();
    acc.absorb({ index: 0, function: { arguments: '{}' } });
    acc.absorb({ index: 1, id: 'b', function: { name: 'site_health' } });
    expect(acc.drain()).toEqual([{ id: 'b', name: 'site_health', arguments: '{}' }]);
  });
});
