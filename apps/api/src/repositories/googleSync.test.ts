import { describe, expect, it } from 'vitest';
import { dayOffset, defaultWindow, widenForBackfill, chunk, gscDailyRows, ga4DailyRows, BATCH_ROWS } from './googleSync.js';

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

describe('widenForBackfill', () => {
  const window = { from: '2026-08-10', to: '2026-09-06' };

  it('reaches back a second period when nothing is stored yet', () => {
    const { window: widened, backfilled } = widenForBackfill(window, null);
    expect(backfilled).toBe(true);
    expect(widened).toEqual({ from: '2026-07-13', to: '2026-09-06' });
  });

  it('reaches back when stored rows start inside the previous period', () => {
    // Production on 2026-09-09: rows from 2026-08-10 only.
    expect(widenForBackfill(window, '2026-08-10').backfilled).toBe(true);
  });

  it('leaves the window alone once the previous period is covered', () => {
    expect(widenForBackfill(window, '2026-07-13')).toEqual({ window, backfilled: false });
    expect(widenForBackfill(window, '2026-01-01').backfilled).toBe(false);
  });
});

describe('chunk', () => {
  it('splits into statements of at most the batch size', () => {
    const rows = Array.from({ length: 1201 }, (_, i) => i);
    const batches = chunk(rows, BATCH_ROWS);
    expect(batches.map((b) => b.length)).toEqual([500, 500, 201]);
    expect(chunk([], BATCH_ROWS)).toEqual([]);
  });
});

describe('gscDailyRows', () => {
  it('names dimensions, drops rows with a missing key, and keeps the last of a repeated key', () => {
    const rows = gscDailyRows(
      [
        { keys: ['2026-09-01', 'tartan'], clicks: 3, impressions: 40, ctr: 0.075, position: 3.2 },
        { keys: ['2026-09-01'], clicks: 1, impressions: 1, ctr: 1, position: 1 },
        { keys: ['2026-09-01', 'tartan'], clicks: 4, impressions: 41, ctr: 0.1, position: 3.1 },
      ],
      'query',
      'p1',
    );
    expect(rows).toEqual([
      { project_id: 'p1', date: '2026-09-01', key: 'tartan', clicks: 4, impressions: 41, ctr: 0.1, position: 3.1 },
    ]);
  });

  it('shapes property totals with no key', () => {
    const rows = gscDailyRows([{ keys: ['2026-09-01'], clicks: 19, impressions: 400, ctr: 0.05, position: 14.4 }], null, 'p1');
    expect(rows).toEqual([{ project_id: 'p1', date: '2026-09-01', clicks: 19, impressions: 400, ctr: 0.05, position: 14.4 }]);
    expect('key' in rows[0]).toBe(false);
  });
});

describe('ga4DailyRows', () => {
  it("converts GA4's YYYYMMDD dates, defaults an empty channel, and skips malformed dates", () => {
    const report = {
      dimensionHeaders: ['date', 'sessionDefaultChannelGroup', 'sessionSource'],
      metricHeaders: ['sessions', 'engagedSessions', 'conversions', 'totalRevenue'],
      rows: [
        { dimensionValues: ['20260901', 'AI Assistant', 'chatgpt.com'], metricValues: [5, 3, 1, 0] },
        { dimensionValues: ['20260901', '', 'x'], metricValues: [1, 0, 0, 0] },
        { dimensionValues: ['(other)', 'Direct', '(direct)'], metricValues: [9, 9, 9, 9] },
      ],
      rowCount: 3,
    };
    const rows = ga4DailyRows(report, 'p1');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      project_id: 'p1',
      date: '2026-09-01',
      channel_group: 'AI Assistant',
      source: 'chatgpt.com',
      sessions: 5,
      engaged_sessions: 3,
      conversions: 1,
      revenue: 0,
    });
    expect(rows[1].channel_group).toBe('(not set)');
  });
});
