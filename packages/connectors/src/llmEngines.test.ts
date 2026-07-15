import { describe, it, expect, vi } from 'vitest';
import type { PromptQuery } from './llmEngine.js';
import { OpenAIConnector } from './llmOpenAI.js';
import { GeminiConnector, parseGeminiResponse } from './llmGemini.js';

const query: PromptQuery = {
  prompt: 'What are the best running shoes?',
  entityId: 'ent_acme',
  citationTargets: ['acme.example', 'Acme'],
};

describe('OpenAIConnector', () => {
  it('polls n times and extracts a citation from the answer text', async () => {
    const answer = { choices: [{ message: { content: 'Try Acme shoes: https://acme.example/shoes' } }] };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(answer), { status: 200 }));
    const connector = new OpenAIConnector({
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      rawSink: () => 'raw_ref',
      now: () => new Date('2026-07-15T00:00:00.000Z'),
    });

    const result = await connector.poll(query, 3);

    expect(result.engine).toBe('openai');
    expect(result.method).toBe('api');
    expect(result.samples).toHaveLength(3);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer sk-test' });
    expect(result.samples[0]!.citation.cited).toBe(true);
    expect(result.samples[0]!.citation.sourcesCited).toContain('https://acme.example/shoes');
  });

  it('throws on a non-OK response', async () => {
    const fetchImpl = vi.fn(async () => new Response('unauthorized', { status: 401 }));
    const connector = new OpenAIConnector({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(connector.poll(query, 1)).rejects.toThrow('OpenAI request failed: 401');
  });

  it('requires an api key', () => {
    expect(() => new OpenAIConnector({ apiKey: '' })).toThrow('requires an apiKey');
  });
});

describe('parseGeminiResponse', () => {
  it('extracts text and grounding source URIs', () => {
    const raw = {
      candidates: [
        {
          content: { parts: [{ text: 'Acme is ' }, { text: 'great.' }] },
          groundingMetadata: {
            groundingChunks: [{ web: { uri: 'https://acme.example/a' } }, { web: { uri: 'https://x.com/b' } }],
          },
        },
      ],
    };
    expect(parseGeminiResponse(raw)).toEqual({
      text: 'Acme is great.',
      sources: ['https://acme.example/a', 'https://x.com/b'],
    });
  });
});

describe('GeminiConnector', () => {
  it('enables grounding, polls, and cites from grounding metadata', async () => {
    const raw = {
      candidates: [
        {
          content: { parts: [{ text: 'The best is X.' }] },
          groundingMetadata: { groundingChunks: [{ web: { uri: 'https://acme.example/guide' } }] },
        },
      ],
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(raw), { status: 200 }));
    const connector = new GeminiConnector({
      apiKey: 'gk-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      rawSink: () => 'raw_ref',
      now: () => new Date('2026-07-15T00:00:00.000Z'),
    });

    const result = await connector.poll(query, 2);

    expect(result.engine).toBe('gemini');
    expect(result.samples).toHaveLength(2);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toContain('gemini-2.0-flash:generateContent?key=gk-test');
    expect(JSON.parse((init as RequestInit).body as string).tools).toEqual([{ google_search: {} }]);
    // Cited via a grounding source even though the answer text has no URL.
    expect(result.samples[0]!.citation.cited).toBe(true);
    expect(result.samples[0]!.citation.sourcesCited).toContain('https://acme.example/guide');
  });

  it('omits the grounding tool when grounding is disabled', async () => {
    const raw = { candidates: [{ content: { parts: [{ text: 'no sources' }] } }] };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(raw), { status: 200 }));
    const connector = new GeminiConnector({
      apiKey: 'gk',
      grounding: false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await connector.poll(query, 1);
    expect(JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string).tools).toBeUndefined();
  });
});
