import { describe, it, expect, vi } from 'vitest';
import type { PromptQuery } from './llmEngine.js';
import { OpenAIConnector } from './llmOpenAI.js';
import { GeminiConnector, parseGeminiResponse } from './llmGemini.js';
import { createConversationalLlmConnector, DRIVER_MIN_CONTEXT_TOKENS } from './factory.js';
import { LLM_MODEL_CHOICES, MODEL_SURFACES, SURFACE_MIN_CONTEXT, modelIdsBySurface, modelsForSurface } from './llmModels.js';
import { llmModelsWithContext } from './llmModels.js';

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

describe('createConversationalLlmConnector', () => {
  it('is null when no key is wired, so a deployment without Sarvam has no Driver', () => {
    expect(createConversationalLlmConnector({})).toBeNull();
  });

  it('is null when nothing on the account clears the context the surface asked for', () => {
    expect(createConversationalLlmConnector({ SARVAM_API_KEY: 'k' }, 1_000_000)).toBeNull();
  });

  it('takes the largest model that clears the requirement, ignoring SARVAM_MODEL', () => {
    // Not the customer's pick and not the deployment default — that override
    // names the citation poll's instrument, which is the 32K conversational
    // model. A model too small for a twenty-tool catalogue does not answer
    // more briefly, it fails part-way through a conversation.
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] })));
    vi.stubGlobal('fetch', fetchImpl);
    try {
      const c = createConversationalLlmConnector({ SARVAM_API_KEY: 'k', SARVAM_MODEL: 'sarvam-105b-conversations' })!;
      expect(c.engine).toBe('sarvam');
      return c.converse([{ role: 'user', content: 'q' }]).then(() => {
        const body = JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body));
        expect(body.model).toBe('sarvam-105b');
        expect(body.max_tokens).toBe(16000);
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('llmModelsWithContext', () => {
  it('keeps only the models big enough, largest first', () => {
    expect(llmModelsWithContext(DRIVER_MIN_CONTEXT_TOKENS).map((m) => m.id)).toEqual(['sarvam-105b']);
    expect(llmModelsWithContext(0).map((m) => m.contextTokens)).toEqual([128_000, 32_000]);
  });
});

describe('model surfaces', () => {
  it('offers Driver only the models with enough context for its catalogue', () => {
    // §9a decision 5's rule, not a hardcoded list of which model suits which
    // screen: a model declares its window once and the surface states what it
    // needs. Today that excludes the 32K conversational model, which would
    // reach 47% of its window on round four of a single turn.
    expect(modelsForSurface('driver').map((m) => m.id)).toEqual(['sarvam-105b']);
  });

  it('offers every model to the two one-shot surfaces, where the choice is about waiting', () => {
    expect(modelsForSurface('prompt').map((m) => m.id)).toEqual(LLM_MODEL_CHOICES.map((m) => m.id));
    expect(modelsForSurface('ask').map((m) => m.id)).toEqual(LLM_MODEL_CHOICES.map((m) => m.id));
  });

  it('sends one map covering every surface, so no screen has to guess', () => {
    const map = modelIdsBySurface();
    expect(Object.keys(map).sort()).toEqual([...MODEL_SURFACES].sort());
    for (const surface of MODEL_SURFACES) expect(map[surface].length).toBeGreaterThan(0);
  });

  it('keeps the connector and the list Settings shows on the same number', () => {
    // Settings offering a model the loop then refuses is worse than offering
    // none: the customer picks it, every question fails, and nothing says why.
    expect(DRIVER_MIN_CONTEXT_TOKENS).toBe(SURFACE_MIN_CONTEXT.driver);
  });
});

describe('the customer’s model pick, within what the surface can run', () => {
  function modelSent(env: Record<string, string | undefined>, pick?: string): string {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] })));
    vi.stubGlobal('fetch', fetchImpl);
    try {
      const c = createConversationalLlmConnector(env, DRIVER_MIN_CONTEXT_TOKENS, pick)!;
      return c.converse([{ role: 'user', content: 'q' }]).then(() =>
        String(JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body)).model),
      ) as unknown as string;
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it('ignores a pick the surface cannot run rather than failing the question', () => {
    // The filter is applied before the pick is consulted, never after. A model
    // too small for the catalogue does not answer more briefly — it fails
    // part-way through a conversation, after the customer has waited.
    return expect(modelSent({ SARVAM_API_KEY: 'k' }, 'sarvam-105b-conversations'))
      .resolves.toBe('sarvam-105b');
  });

  it('honours a pick that clears the requirement', () => {
    return expect(modelSent({ SARVAM_API_KEY: 'k' }, 'sarvam-105b')).resolves.toBe('sarvam-105b');
  });
});
