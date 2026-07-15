import { describe, expect, it } from 'vitest';
import { isOverLimit, PLAN_LIMITS } from './plans.js';

describe('PLAN_LIMITS', () => {
  it('matches the blueprint-pinned free/starter tier (G5)', () => {
    expect(PLAN_LIMITS.starter).toEqual({ projects: 1, keywords: 25, prompts: 10, cadence: 'weekly' });
  });
});

describe('isOverLimit', () => {
  it('is false at or under a tier\'s caps', () => {
    expect(isOverLimit({ projects: 1, keywords: 25, prompts: 10 }, 'starter')).toBe(false);
    expect(isOverLimit({ projects: 0, keywords: 0, prompts: 0 }, 'starter')).toBe(false);
  });

  it('is true once any counter exceeds the tier cap', () => {
    expect(isOverLimit({ projects: 2, keywords: 10, prompts: 5 }, 'starter')).toBe(true);
    expect(isOverLimit({ projects: 1, keywords: 26, prompts: 10 }, 'starter')).toBe(true);
  });

  it('enterprise has no effective ceiling', () => {
    expect(isOverLimit({ projects: 10_000, keywords: 10_000_000, prompts: 10_000_000 }, 'enterprise')).toBe(false);
  });
});
