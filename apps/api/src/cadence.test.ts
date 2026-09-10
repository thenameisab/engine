import { describe, expect, it } from 'vitest';
import { CADENCE_DEFAULTS, CADENCE_WINDOW_HOURS, effectiveCadence } from '@engine/core';

describe('cadence policy', () => {
  it('gives the free tier the slow rhythm and every paid tier the fast one', () => {
    expect(CADENCE_DEFAULTS.free).toEqual({ rankPoll: 'weekly', aiPoll: 'monthly', crawl: 'monthly' });
    for (const tier of ['starter', 'growth', 'agency', 'enterprise'] as const) {
      expect(CADENCE_DEFAULTS[tier]).toEqual({ rankPoll: 'daily', aiPoll: 'weekly', crawl: 'weekly' });
    }
  });

  it('lets an override pin one field and leaves the others on the plan default', () => {
    const e = effectiveCadence('free', { rankPoll: null, aiPoll: 'weekly', crawl: null });
    expect(e.policy).toEqual({ rankPoll: 'weekly', aiPoll: 'weekly', crawl: 'monthly' });
    expect(e.source).toEqual({ rankPoll: 'plan-default', aiPoll: 'override', crawl: 'plan-default' });
    expect(e.tier).toBe('free');
  });

  it('treats no override row and an all-null row the same', () => {
    expect(effectiveCadence('growth', null)).toEqual(effectiveCadence('growth', { rankPoll: null, aiPoll: null, crawl: null }));
  });

  it('keeps every window short of its nominal period, so cron drift cannot skip a beat', () => {
    expect(CADENCE_WINDOW_HOURS.daily).toBeLessThan(24);
    expect(CADENCE_WINDOW_HOURS.weekly).toBeLessThan(7 * 24);
    expect(CADENCE_WINDOW_HOURS.monthly).toBeLessThan(30 * 24);
    expect(CADENCE_WINDOW_HOURS.weekly).toBeGreaterThan(6 * 24);
    expect(CADENCE_WINDOW_HOURS.monthly).toBeGreaterThan(28 * 24);
  });
});
