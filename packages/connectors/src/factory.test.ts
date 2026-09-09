import { describe, it, expect } from 'vitest';
import { createSerpConnector, createLlmConnectors, createStreamingLlmConnector } from './factory.js';
import { LLM_MODEL_CHOICES, DEFAULT_LLM_MODEL_ID, isKnownLlmModel } from './llmModels.js';

describe('createSerpConnector', () => {
  it('builds a Serper connector when the key is present', () => {
    const c = createSerpConnector({ SERPER_API_KEY: 'serper_x' });
    expect(c?.vendor).toBe('serper');
  });

  it('returns null when no SERP key is configured', () => {
    expect(createSerpConnector({})).toBeNull();
  });

  it('returns null for a not-yet-built vendor rather than throwing', () => {
    expect(createSerpConnector({ SERP_PROVIDER: 'dataforseo', SERPER_API_KEY: 'x' })).toBeNull();
  });
});

describe('createLlmConnectors', () => {
  it('includes only engines whose key is present', () => {
    expect(createLlmConnectors({}).map((c) => c.engine)).toEqual([]);
    expect(createLlmConnectors({ OPENAI_API_KEY: 'k' }).map((c) => c.engine)).toEqual(['openai']);
    expect(createLlmConnectors({ OPENAI_API_KEY: 'k', GEMINI_API_KEY: 'g' }).map((c) => c.engine)).toEqual([
      'openai',
      'gemini',
    ]);
    expect(createLlmConnectors({ SARVAM_API_KEY: 's' }).map((c) => c.engine)).toEqual(['sarvam']);
  });
});

describe('createStreamingLlmConnector', () => {
  it('is null with no Sarvam key, because no other adapter streams', () => {
    // OpenAI and Gemini are wired for batch polling but implement no `stream`,
    // so a deployment with only those keys has nothing to stream from — and
    // saying so beats handing back a connector whose stream method is absent.
    expect(createStreamingLlmConnector({ OPENAI_API_KEY: 'x', GEMINI_API_KEY: 'y' })).toBeNull();
  });

  it('uses the caller’s model and that model’s own token budget', () => {
    const connector = createStreamingLlmConnector({ SARVAM_API_KEY: 'k' }, 'sarvam-105b-conversations');
    expect(connector).not.toBeNull();
    // The budget travels with the model: this one rejects anything over 8192.
    expect((connector as unknown as { model: string; maxTokens: number }).model).toBe('sarvam-105b-conversations');
    expect((connector as unknown as { model: string; maxTokens: number }).maxTokens).toBe(8192);
  });

  it('falls back to SARVAM_MODEL when the caller names none', () => {
    const connector = createStreamingLlmConnector({ SARVAM_API_KEY: 'k', SARVAM_MODEL: 'sarvam-105b' });
    expect((connector as unknown as { model: string }).model).toBe('sarvam-105b');
  });
});

describe('LLM_MODEL_CHOICES', () => {
  it('offers only ids the account can actually reach', () => {
    // Step 1 established that every GLM name this key was asked for is
    // refused by the vendor. The registry is the list that answers, so a
    // picker built from it cannot offer a model that 400s.
    expect(LLM_MODEL_CHOICES.map((m) => m.id)).toEqual(['sarvam-105b', 'sarvam-105b-conversations']);
  });

  it('describes every model, so no option is offered without a byline', () => {
    for (const m of LLM_MODEL_CHOICES) {
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.byline.length).toBeGreaterThan(0);
      expect(m.byline).not.toContain('PLACEHOLDER');
      expect(m.maxTokens).toBeGreaterThan(0);
    }
  });

  it('defaults to a model that is in the list', () => {
    expect(isKnownLlmModel(DEFAULT_LLM_MODEL_ID)).toBe(true);
  });

  it('rejects an unknown id, which is what keeps it out of a vendor request', () => {
    // The vendor's own rejection enumerates every model on the account, so an
    // unvalidated id must never be forwarded.
    expect(isKnownLlmModel('glm-5.2')).toBe(false);
    expect(isKnownLlmModel('')).toBe(false);
  });
});
