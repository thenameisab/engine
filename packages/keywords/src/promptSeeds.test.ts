import { describe, it, expect } from 'vitest';
import { generatePromptSeeds } from './promptSeeds.js';

describe('generatePromptSeeds', () => {
  it('substitutes the topic into every template', () => {
    const seeds = generatePromptSeeds('home loans');
    expect(seeds.length).toBeGreaterThan(0);
    for (const s of seeds) expect(s).toContain('home loans');
  });

  it('returns nothing for a blank topic rather than templates with a hole in them', () => {
    expect(generatePromptSeeds('   ')).toEqual([]);
  });
});
