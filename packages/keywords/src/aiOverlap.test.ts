import { describe, it, expect } from 'vitest';
import { hasAiOverlap } from './aiOverlap.js';

describe('hasAiOverlap', () => {
  it('flags a SERP carrying an AI Overview', () => {
    expect(hasAiOverlap(['ai_overview', 'people_also_ask'])).toBe(true);
  });

  it('flags AI Mode too', () => {
    expect(hasAiOverlap(['ai_mode'])).toBe(true);
  });

  it('does not flag a SERP with no AI-generated surface', () => {
    expect(hasAiOverlap(['featured_snippet', 'local_pack'])).toBe(false);
    expect(hasAiOverlap([])).toBe(false);
  });
});
