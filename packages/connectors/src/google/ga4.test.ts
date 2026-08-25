import { describe, it, expect } from 'vitest';
import { listGa4Properties, getGa4Property, runGa4Report, namedGa4Row, ga4ChannelReport } from './ga4.js';

function stubFetch(bodies: unknown[]) {
  const calls: { url: string; body?: unknown }[] = [];
  let i = 0;
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const body = bodies[Math.min(i, bodies.length - 1)];
    i++;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('listGa4Properties', () => {
  it('flattens the account tree into a flat property list in one call', async () => {
    const { impl, calls } = stubFetch([
      {
        accountSummaries: [
          {
            account: 'accounts/1',
            propertySummaries: [
              { property: 'properties/111', displayName: 'Main site' },
              { property: 'properties/222', displayName: 'Shop' },
            ],
          },
          { account: 'accounts/2', propertySummaries: [{ property: 'properties/333', displayName: 'Client A' }] },
        ],
      },
    ]);
    const { properties, truncated } = await listGa4Properties('token', impl);
    expect(properties).toEqual([
      { name: 'properties/111', displayName: 'Main site' },
      { name: 'properties/222', displayName: 'Shop' },
      { name: 'properties/333', displayName: 'Client A' },
    ]);
    expect(truncated).toBe(false);
    // One request, not one per account.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/accountSummaries');
  });

  it('follows nextPageToken', async () => {
    const { impl, calls } = stubFetch([
      { accountSummaries: [{ propertySummaries: [{ property: 'properties/1' }] }], nextPageToken: 'p2' },
      { accountSummaries: [{ propertySummaries: [{ property: 'properties/2' }] }] },
    ]);
    const { properties } = await listGa4Properties('token', impl);
    expect(properties.map((p) => p.name)).toEqual(['properties/1', 'properties/2']);
    expect(calls[1].url).toContain('pageToken=p2');
  });

  it('handles an account with no properties, and a user with no accounts', async () => {
    expect((await listGa4Properties('t', stubFetch([{ accountSummaries: [{ account: 'accounts/1' }] }]).impl)).properties).toEqual(
      [],
    );
    expect((await listGa4Properties('t', stubFetch([{}]).impl)).properties).toEqual([]);
  });

  it('falls back to the resource name when a property has no display name', async () => {
    const { impl } = stubFetch([{ accountSummaries: [{ propertySummaries: [{ property: 'properties/9' }] }] }]);
    expect((await listGa4Properties('t', impl)).properties[0].displayName).toBe('properties/9');
  });
});

describe('getGa4Property', () => {
  it('reads the timezone a reports dates are expressed in', async () => {
    const { impl, calls } = stubFetch([
      { name: 'properties/111', displayName: 'Main', timeZone: 'Asia/Singapore', currencyCode: 'SGD' },
    ]);
    const prop = await getGa4Property('token', 'properties/111', impl);
    expect(prop.timeZone).toBe('Asia/Singapore');
    expect(prop.currencyCode).toBe('SGD');
    expect(calls[0].url).toContain('analyticsadmin.googleapis.com/v1beta/properties/111');
  });
});

describe('runGa4Report', () => {
  it('posts dimensions and metrics in Googles wrapped shape, to the Data API', async () => {
    const { impl, calls } = stubFetch([{ rows: [] }]);
    await runGa4Report(
      'token',
      'properties/111',
      { startDate: '2026-08-01', endDate: '2026-08-07', dimensions: ['date'], metrics: ['sessions'] },
      impl,
    );
    expect(calls[0].url).toBe('https://analyticsdata.googleapis.com/v1beta/properties/111:runReport');
    expect(calls[0].body).toMatchObject({
      dateRanges: [{ startDate: '2026-08-01', endDate: '2026-08-07' }],
      dimensions: [{ name: 'date' }],
      metrics: [{ name: 'sessions' }],
    });
  });

  it('parses string metric values into numbers', async () => {
    const { impl } = stubFetch([
      {
        dimensionHeaders: [{ name: 'date' }],
        metricHeaders: [{ name: 'sessions' }, { name: 'totalRevenue' }],
        rows: [{ dimensionValues: [{ value: '20260801' }], metricValues: [{ value: '1234' }, { value: '99.5' }] }],
        rowCount: 1,
      },
    ]);
    const report = await runGa4Report(
      'token',
      'properties/1',
      { startDate: 'a', endDate: 'b', dimensions: ['date'], metrics: ['sessions', 'totalRevenue'] },
      impl,
    );
    expect(report.rows[0].metricValues).toEqual([1234, 99.5]);
    // Numbers, not strings — the difference between summing and concatenating.
    expect(typeof report.rows[0].metricValues[0]).toBe('number');
  });

  it('turns an unparseable metric into 0 rather than NaN', async () => {
    const { impl } = stubFetch([
      {
        metricHeaders: [{ name: 'sessions' }],
        rows: [{ dimensionValues: [], metricValues: [{ value: 'n/a' }] }],
      },
    ]);
    const report = await runGa4Report('t', 'properties/1', { startDate: 'a', endDate: 'b', dimensions: [], metrics: ['sessions'] }, impl);
    expect(report.rows[0].metricValues[0]).toBe(0);
    expect(Number.isNaN(report.rows[0].metricValues[0])).toBe(false);
  });

  it('sends limit and offset as strings, as the Data API requires', async () => {
    const { impl, calls } = stubFetch([{ rows: [] }]);
    await runGa4Report(
      'token',
      'properties/1',
      { startDate: 'a', endDate: 'b', dimensions: [], metrics: [], limit: 500, offset: 100 },
      impl,
    );
    expect((calls[0].body as { limit: unknown; offset: unknown }).limit).toBe('500');
    expect((calls[0].body as { offset: unknown }).offset).toBe('100');
  });

  it('caps limit at the API ceiling', async () => {
    const { impl, calls } = stubFetch([{ rows: [] }]);
    await runGa4Report('t', 'properties/1', { startDate: 'a', endDate: 'b', dimensions: [], metrics: [], limit: 999_999 }, impl);
    expect((calls[0].body as { limit: string }).limit).toBe('100000');
  });

  it('falls back to the row count when Google omits rowCount', async () => {
    const { impl } = stubFetch([{ rows: [{ dimensionValues: [], metricValues: [] }] }]);
    const report = await runGa4Report('t', 'properties/1', { startDate: 'a', endDate: 'b', dimensions: [], metrics: [] }, impl);
    expect(report.rowCount).toBe(1);
  });

  it('returns an empty report for a range with no data', async () => {
    const { impl } = stubFetch([{}]);
    const report = await runGa4Report('t', 'properties/1', { startDate: 'a', endDate: 'b', dimensions: [], metrics: [] }, impl);
    expect(report.rows).toEqual([]);
    expect(report.rowCount).toBe(0);
  });
});

describe('namedGa4Row', () => {
  it('names dimensions and metrics off the report headers', async () => {
    const { impl } = stubFetch([
      {
        dimensionHeaders: [{ name: 'date' }, { name: 'sessionDefaultChannelGroup' }],
        metricHeaders: [{ name: 'sessions' }],
        rows: [{ dimensionValues: [{ value: '20260801' }, { value: 'Organic Search' }], metricValues: [{ value: '42' }] }],
      },
    ]);
    const report = await runGa4Report(
      't',
      'properties/1',
      { startDate: 'a', endDate: 'b', dimensions: ['date', 'sessionDefaultChannelGroup'], metrics: ['sessions'] },
      impl,
    );
    expect(namedGa4Row(report.rows[0], report)).toEqual({
      date: '20260801',
      sessionDefaultChannelGroup: 'Organic Search',
      sessions: 42,
    });
  });
});

describe('ga4ChannelReport', () => {
  it('requests the channel and source breakdown attribution needs', async () => {
    const { impl, calls } = stubFetch([{ rows: [] }]);
    await ga4ChannelReport('token', 'properties/1', '2026-08-01', '2026-08-31', impl);
    const body = calls[0].body as { dimensions: { name: string }[]; metrics: { name: string }[] };
    expect(body.dimensions.map((d) => d.name)).toEqual(['date', 'sessionDefaultChannelGroup', 'sessionSource']);
    expect(body.metrics.map((m) => m.name)).toContain('sessions');
    expect(body.metrics.map((m) => m.name)).toContain('totalRevenue');
  });
});
