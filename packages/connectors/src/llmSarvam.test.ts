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
