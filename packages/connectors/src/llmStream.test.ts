import { describe, it, expect } from 'vitest';
import { parseSseJson } from './llmStream.js';

/**
 * The SSE parser, with the chunk boundaries that break naive versions.
 *
 * Worth its own tests because the failure is silent: a parser that splits each
 * network chunk on newlines and parses what it finds drops the tail of every
 * event that straddles a boundary, which shows up as an answer missing random
 * words rather than as an error.
 */

/** A stream that delivers exactly these byte chunks, in order. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

async function collect(chunks: string[]): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const event of parseSseJson(streamOf(chunks))) out.push(event);
  return out;
}

describe('parseSseJson', () => {
  it('parses one event per data line', async () => {
    expect(await collect(['data: {"n":1}\n', 'data: {"n":2}\n'])).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('reassembles a data line split across chunks', async () => {
    // The whole point: `{"n":1}` arrives in three pieces and must still parse
    // exactly once.
    expect(await collect(['data: {"n', '":1}', '\ndata: {"n":2}\n'])).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('reassembles a line whose newline arrives in a later chunk', async () => {
    expect(await collect(['data: {"n":1}', '\n'])).toEqual([{ n: 1 }]);
  });

  it('handles several events inside one chunk', async () => {
    expect(await collect(['data: {"a":1}\ndata: {"a":2}\ndata: {"a":3}\n'])).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
  });

  it('stops at the [DONE] sentinel and does not try to parse it', async () => {
    expect(await collect(['data: {"n":1}\n', 'data: [DONE]\n', 'data: {"n":2}\n'])).toEqual([{ n: 1 }]);
  });

  it('skips a malformed event rather than abandoning the stream', async () => {
    // One bad event in a long answer must not cost the rest of the answer.
    expect(await collect(['data: {"n":1}\n', 'data: not json\n', 'data: {"n":2}\n'])).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('ignores non-data lines', async () => {
    expect(await collect([': keepalive\n', 'event: message\n', 'data: {"n":1}\n', '\n'])).toEqual([{ n: 1 }]);
  });

  it('drops an incomplete trailing line rather than parsing a fragment', async () => {
    // A stream cut mid-event yields nothing for that event; half a JSON object
    // is not a partial answer, it is not an answer.
    expect(await collect(['data: {"n":1}\n', 'data: {"n":'])).toEqual([{ n: 1 }]);
  });

  it('stops early when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const out: unknown[] = [];
    for await (const e of parseSseJson(streamOf(['data: {"n":1}\n']), controller.signal)) out.push(e);
    expect(out).toEqual([]);
  });
});
