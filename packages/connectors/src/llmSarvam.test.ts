import { describe, it, expect, vi } from 'vitest';
import type { PromptQuery } from './llmEngine.js';
import { SarvamConnector } from './llmSarvam.js';

const query: PromptQuery = {
  prompt: 'Who provides income verification APIs in India?',
  entityId: 'ent_acme',
  citationTargets: ['acme.example', 'Acme'],
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('SarvamConnector', () => {
  it('polls n times, sends the key in api-subscription-key, and extracts a citation', async () => {
    const answer = {
      choices: [{ finish_reason: 'stop', message: { content: 'Acme does: https://acme.example/api' } }],
    };
    const fetchImpl = vi.fn(async () => response(answer));
    const connector = new SarvamConnector({
      apiKey: 'sub-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      rawSink: () => 'raw_ref',
      now: () => new Date('2026-09-09T00:00:00.000Z'),
    });

    const result = await connector.poll(query, 3);

    expect(result.engine).toBe('sarvam');
    expect(result.method).toBe('api');
    expect(result.samples).toHaveLength(3);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.sarvam.ai/v1/chat/completions');
    expect((init as RequestInit).headers).toMatchObject({ 'api-subscription-key': 'sub-test' });
    expect(result.samples[0]!.citation.cited).toBe(true);
    expect(result.samples[0]!.citation.sourcesCited).toContain('https://acme.example/api');
  });

  it('defaults to sarvam-105b and a budget large enough for the reasoning pass', async () => {
    const fetchImpl = vi.fn(async () => response({ choices: [{ message: { content: 'ok' } }] }));
    const connector = new SarvamConnector({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });
    await connector.poll(query, 1);
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.model).toBe('sarvam-105b');
    expect(body.max_tokens).toBe(16000);
  });

  it('uses the configured model, so a newer Sarvam model needs no code change', async () => {
    const fetchImpl = vi.fn(async () => response({ choices: [{ message: { content: 'ok' } }] }));
    const connector = new SarvamConnector({
      apiKey: 'k',
      model: 'sarvam-105b-conversations',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await connector.poll(query, 1);
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.model).toBe('sarvam-105b-conversations');
  });

  /**
   * The reasoning model's failure mode: 200 OK, no answer text, because the
   * token budget ran out while it was still thinking. Recorded silently, this
   * is a sample that cited nobody.
   */
  it('refuses a truncated reply with no answer text instead of recording an uncited sample', async () => {
    const truncated = {
      choices: [{ finish_reason: 'length', message: { content: null, reasoning_content: 'thinking…' } }],
    };
    const fetchImpl = vi.fn(async () => response(truncated));
    const connector = new SarvamConnector({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(connector.poll(query, 1)).rejects.toThrow('truncated at 16000 tokens');
  });

  it('accepts an empty answer that was not truncated', async () => {
    const fetchImpl = vi.fn(async () => response({ choices: [{ finish_reason: 'stop', message: { content: '' } }] }));
    const connector = new SarvamConnector({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await connector.poll(query, 1);
    expect(result.samples[0]!.citation.cited).toBe(false);
  });

  it('throws on a non-OK response', async () => {
    const fetchImpl = vi.fn(async () => new Response('unauthorized', { status: 401 }));
    const connector = new SarvamConnector({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(connector.poll(query, 1)).rejects.toThrow('Sarvam request failed: 401');
  });

  it('requires an api key', () => {
    expect(() => new SarvamConnector({ apiKey: '' })).toThrow('requires an apiKey');
  });
});

/** An SSE response body built from OpenAI-shaped delta events. */
function streamResponse(events: unknown[], status = 200): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n`).join('') + 'data: [DONE]\n';
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
}

function delta(d: { content?: string | null; reasoning_content?: string | null }, finish?: string) {
  return { choices: [{ delta: d, finish_reason: finish ?? null }] };
}

async function drain(iter: AsyncIterable<{ type: string; delta: string }>) {
  const chunks: { type: string; delta: string }[] = [];
  for await (const c of iter) chunks.push(c);
  return chunks;
}

describe('SarvamConnector.stream', () => {
  it('separates the reasoning phase from the answer', async () => {
    // This model reasons before it answers, out of one token budget. The two
    // are tagged differently because the UI has to show the thinking phase —
    // measured against the live vendor it is most of the wait (first thinking
    // token ~0.9s, first answer token ~3.2s).
    const fetchImpl = vi.fn(async () =>
      streamResponse([
        delta({ reasoning_content: 'Let me think' }),
        delta({ reasoning_content: ' about APIs.' }),
        delta({ content: 'Acme' }),
        delta({ content: ' provides one.' }, 'stop'),
      ]),
    );
    const connector = new SarvamConnector({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(await drain(connector.stream('who?'))).toEqual([
      { type: 'thinking', delta: 'Let me think' },
      { type: 'thinking', delta: ' about APIs.' },
      { type: 'text', delta: 'Acme' },
      { type: 'text', delta: ' provides one.' },
    ]);
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1].body)).stream).toBe(true);
  });

  it('sends the key in api-subscription-key, like the batch path', async () => {
    const fetchImpl = vi.fn(async () => streamResponse([delta({ content: 'hi' }, 'stop')]));
    const connector = new SarvamConnector({ apiKey: 'secret-key', fetchImpl: fetchImpl as unknown as typeof fetch });
    await drain(connector.stream('hello'));
    expect(fetchImpl.mock.calls[0][1].headers['api-subscription-key']).toBe('secret-key');
  });

  it('ignores the empty first delta the vendor opens with', async () => {
    // Measured: the real first event carries `content: ""` and
    // `reasoning_content: null`. Forwarding it would emit an empty text chunk
    // and end the thinking state before a single answer character existed.
    const fetchImpl = vi.fn(async () =>
      streamResponse([delta({ content: '', reasoning_content: null }), delta({ content: 'real' }, 'stop')]),
    );
    const connector = new SarvamConnector({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await drain(connector.stream('q'))).toEqual([{ type: 'text', delta: 'real' }]);
  });

  it('reports a stream truncated while the model was still reasoning', async () => {
    // The reasoning-budget trap in streamed form: plenty of thinking, no
    // answer, `finish_reason: 'length'`. Ending quietly would look like a
    // model that had nothing to say.
    const fetchImpl = vi.fn(async () =>
      streamResponse([delta({ reasoning_content: 'thinking hard' }), delta({}, 'length')]),
    );
    const connector = new SarvamConnector({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(drain(connector.stream('q'))).rejects.toThrow(/truncated at 16000 tokens/);
  });

  it('does not call a truncated stream an error when an answer did arrive', async () => {
    const fetchImpl = vi.fn(async () =>
      streamResponse([delta({ content: 'a partial answer' }), delta({}, 'length')]),
    );
    const connector = new SarvamConnector({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await drain(connector.stream('q'))).toEqual([{ type: 'text', delta: 'a partial answer' }]);
  });

  it('surfaces a vendor rejection with its status and body', async () => {
    const fetchImpl = vi.fn(async () => new Response('max_tokens exceeds the maximum output length', { status: 400 }));
    const connector = new SarvamConnector({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(drain(connector.stream('q'))).rejects.toThrow(/400 max_tokens exceeds/);
  });

  it('sends the per-model token budget it was built with', async () => {
    // `sarvam-105b-conversations` rejects anything above 8192 outright, so the
    // budget is a per-model fact, not one shared default.
    const fetchImpl = vi.fn(async () => streamResponse([delta({ content: 'hi' }, 'stop')]));
    const connector = new SarvamConnector({
      apiKey: 'k',
      model: 'sarvam-105b-conversations',
      maxTokens: 8192,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await drain(connector.stream('q'));
    const sent = JSON.parse(String(fetchImpl.mock.calls[0][1].body));
    expect(sent.max_tokens).toBe(8192);
    expect(sent.model).toBe('sarvam-105b-conversations');
  });
});

describe('SarvamConnector reports its model', () => {
  it('names the model on the result, so a sample records its instrument', async () => {
    // `engine` is the vendor and cannot tell two Sarvam models apart. Measured
    // 2026-09-09, they disagree about whether to name companies at all, so a
    // band pooled across them measures the instrument, not the brand.
    const fetchImpl = vi.fn(async () =>
      response({ choices: [{ finish_reason: 'stop', message: { content: 'Acme does.' } }] }),
    );
    const connector = new SarvamConnector({
      apiKey: 'k',
      model: 'sarvam-105b-conversations',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await connector.poll(query, 1);
    expect(result.engine).toBe('sarvam');
    expect(result.model).toBe('sarvam-105b-conversations');
  });

  it('reports the default model when the caller named none', async () => {
    const fetchImpl = vi.fn(async () =>
      response({ choices: [{ finish_reason: 'stop', message: { content: 'Acme does.' } }] }),
    );
    const connector = new SarvamConnector({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });
    expect((await connector.poll(query, 1)).model).toBe('sarvam-105b');
  });
});
