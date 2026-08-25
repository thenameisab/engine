import { describe, expect, it } from 'vitest';
import { dayOffset, defaultWindow } from './googleSync.js';

/**
 * The date-window logic, which is where a sync quietly goes wrong.
 *
 * A window that ends today stores GSC rows Google has not finished revising; a
 * window that starts yesterday stores almost nothing. Neither failure raises an
 * error — the numbers are just wrong — so the arithmetic is pinned here.
 */
describe('dayOffset', () => {
  it('walks back and forward in whole UTC days', () => {
    const ref = new Date('2026-08-24T14:33:00Z');
    expect(dayOffset(ref, 0)).toBe('2026-08-24');
    expect(dayOffset(ref, -1)).toBe('2026-08-23');
    expect(dayOffset(ref, -3)).toBe('2026-08-21');
    expect(dayOffset(ref, 1)).toBe('2026-08-25');
  });

  it('crosses a month boundary', () => {
    expect(dayOffset(new Date('2026-09-02T00:00:00Z'), -3)).toBe('2026-08-30');
  });

  it('crosses a year boundary', () => {
    expect(dayOffset(new Date('2027-01-01T00:00:00Z'), -1)).toBe('2026-12-31');
  });

  it('handles a leap day', () => {
    expect(dayOffset(new Date('2028-03-01T00:00:00Z'), -1)).toBe('2028-02-29');
  });

  it('does not let a late-UTC time bleed into the next day', () => {
    // 23:59Z is still the same UTC day; a local-time implementation would slip.
    expect(dayOffset(new Date('2026-08-24T23:59:59Z'), 0)).toBe('2026-08-24');
  });
});

describe('defaultWindow', () => {
  const now = new Date('2026-08-24T06:00:00Z');

  it('ends GSC three days back, because Search Console data lags and is revised', () => {
    const { from, to } = defaultWindow('gsc', now);
    expect(to).toBe('2026-08-21');
    // 28 days inclusive of both ends: 2026-07-25 .. 2026-08-21.
    expect(from).toBe('2026-07-25');
  });

  it('ends GA4 one day back, since it has no comparable revision lag', () => {
    const { to } = defaultWindow('ga4', now);
    expect(to).toBe('2026-08-23');
  });

  it('covers exactly the requested number of days, both bounds inclusive', () => {
    const { from, to } = defaultWindow('ga4', now, 7);
    expect(to).toBe('2026-08-23');
    expect(from).toBe('2026-08-17');
    const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
    expect(days).toBe(7);
  });

  it('covers exactly windowDays for every provider and span', () => {
    for (const provider of ['gsc', 'ga4', 'gbp'] as const) {
      for (const span of [1, 2, 7, 28, 90]) {
        const { from, to } = defaultWindow(provider, now, span);
        const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
        expect(days).toBe(span);
      }
    }
  });

  it('clamps a nonsensical span to a single day rather than inverting the range', () => {
    const { from, to } = defaultWindow('ga4', now, 0);
    expect(from).toBe(to);
  });

  it('never produces an inverted range', () => {
    for (const provider of ['gsc', 'ga4', 'gbp'] as const) {
      for (const days of [1, 7, 28, 365]) {
        const { from, to } = defaultWindow(provider, now, days);
        expect(from <= to).toBe(true);
      }
    }
  });

  it('produces dates Postgres accepts as a date literal', () => {
    const { from, to } = defaultWindow('gsc', now);
    expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
