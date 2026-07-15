import { describe, it, expect } from 'vitest';
import { createSerpConnector, createLlmConnectors } from './factory.js';

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
  });
});
