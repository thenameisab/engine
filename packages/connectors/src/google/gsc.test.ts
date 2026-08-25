import { describe, it, expect } from 'vitest';
import {
  listGscProperties,
  canReadGscProperty,
  queryGscSearchAnalytics,
  queryGscAll,
  namedGscRow,
  type GscDimension,
} from './gsc.js';

/** A stub fetch returning a queue of JSON bodies, recording every request. */
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

describe('listGscProperties', () => {
  it('returns domain and URL-prefix properties verbatim', async () => {
    const { impl } = stubFetch([
      {
        siteEntry: [
          { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
          { siteUrl: 'https://shop.example.com/', permissionLevel: 'siteFullUser' },
        ],
      },
    ]);
    const props = await listGscProperties('token', impl);
    expect(props).toEqual([
      { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
      { siteUrl: 'https://shop.example.com/', permissionLevel: 'siteFullUser' },
    ]);
  });

  it('returns an empty list when the account has no properties', async () => {
    const { impl } = stubFetch([{}]);
    expect(await listGscProperties('token', impl)).toEqual([]);
  });

  it('drops entries with no siteUrl rather than emitting a broken id', async () => {
    const { impl } = stubFetch([{ siteEntry: [{ permissionLevel: 'siteOwner' }, { siteUrl: 'sc-domain:a.com' }] }]);
    const props = await listGscProperties('token', impl);
    expect(props).toHaveLength(1);
    expect(props[0].siteUrl).toBe('sc-domain:a.com');
  });

  it('treats a missing permissionLevel as unverified, the safe assumption', async () => {
    const { impl } = stubFetch([{ siteEntry: [{ siteUrl: 'sc-domain:a.com' }] }]);
    expect((await listGscProperties('token', impl))[0].permissionLevel).toBe('siteUnverifiedUser');
  });
});

describe('canReadGscProperty', () => {
  it('excludes only unverified users', () => {
    expect(canReadGscProperty('siteOwner')).toBe(true);
    expect(canReadGscProperty('siteFullUser')).toBe(true);
    expect(canReadGscProperty('siteRestrictedUser')).toBe(true);
    expect(canReadGscProperty('siteUnverifiedUser')).toBe(false);
  });
});

describe('queryGscSearchAnalytics', () => {
  it('URL-encodes the siteUrl into the path', async () => {
    const { impl, calls } = stubFetch([{ rows: [] }]);
    await queryGscSearchAnalytics(
      'token',
      'sc-domain:example.com',
      { startDate: '2026-08-01', endDate: '2026-08-07', dimensions: ['date'] },
      impl,
    );
    expect(calls[0].url).toContain('/sites/sc-domain%3Aexample.com/searchAnalytics/query');
  });

  it('defaults to web search type and a 1000-row limit', async () => {
    const { impl, calls } = stubFetch([{ rows: [] }]);
    await queryGscSearchAnalytics(
      'token',
      's',
      { startDate: '2026-08-01', endDate: '2026-08-07', dimensions: ['query'] },
      impl,
    );
    expect(calls[0].body).toMatchObject({ type: 'web', rowLimit: 1000, startRow: 0 });
  });

  it('caps rowLimit at Googles 25,000 ceiling rather than being rejected', async () => {
    const { impl, calls } = stubFetch([{ rows: [] }]);
    await queryGscSearchAnalytics(
      'token',
      's',
      { startDate: 'a', endDate: 'b', dimensions: ['query'], rowLimit: 999_999 },
      impl,
    );
    expect((calls[0].body as { rowLimit: number }).rowLimit).toBe(25_000);
  });

  it('maps rows and defaults omitted metrics to zero', async () => {
    const { impl } = stubFetch([
      {
        rows: [
          { keys: ['2026-08-01', 'engine seo'], clicks: 12, impressions: 340, ctr: 0.0353, position: 8.4 },
          // Google omits `clicks` entirely on a zero-click row. That is a real row.
          { keys: ['2026-08-01', 'engine geo'], impressions: 90, position: 22.1 },
        ],
      },
    ]);
    const rows = await queryGscSearchAnalytics(
      'token',
      's',
      { startDate: 'a', endDate: 'b', dimensions: ['date', 'query'] },
      impl,
    );
    expect(rows[0]).toEqual({ keys: ['2026-08-01', 'engine seo'], clicks: 12, impressions: 340, ctr: 0.0353, position: 8.4 });
    expect(rows[1]).toEqual({ keys: ['2026-08-01', 'engine geo'], clicks: 0, impressions: 90, ctr: 0, position: 22.1 });
  });

  it('returns an empty list when the range has no data', async () => {
    const { impl } = stubFetch([{}]);
    expect(await queryGscSearchAnalytics('t', 's', { startDate: 'a', endDate: 'b', dimensions: [] }, impl)).toEqual([]);
  });
});

describe('queryGscAll', () => {
  it('stops on a short page, without a wasted extra request', async () => {
    const { impl, calls } = stubFetch([{ rows: [{ keys: ['a'], clicks: 1, impressions: 1, ctr: 1, position: 1 }] }]);
    const result = await queryGscAll(
      'token',
      's',
      { startDate: 'a', endDate: 'b', dimensions: ['query'], rowLimit: 10 },
      impl,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.truncated).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('pages by startRow until a short page arrives', async () => {
    const full = Array.from({ length: 2 }, (_, i) => ({ keys: [`k${i}`], clicks: 1, impressions: 1, ctr: 1, position: 1 }));
    const { impl, calls } = stubFetch([{ rows: full }, { rows: full }, { rows: [full[0]] }]);
    const result = await queryGscAll(
      'token',
      's',
      { startDate: 'a', endDate: 'b', dimensions: ['query'], rowLimit: 2 },
      impl,
    );
    expect(result.rows).toHaveLength(5);
    expect(result.truncated).toBe(false);
    expect(calls.map((c) => (c.body as { startRow: number }).startRow)).toEqual([0, 2, 4]);
  });

  it('reports truncation at maxRows instead of paging without bound', async () => {
    const page = [{ keys: ['k'], clicks: 1, impressions: 1, ctr: 1, position: 1 }];
    const { impl } = stubFetch([{ rows: page }]);
    const result = await queryGscAll(
      'token',
      's',
      { startDate: 'a', endDate: 'b', dimensions: ['query'], rowLimit: 1 },
      impl,
      3,
    );
    expect(result.truncated).toBe(true);
    expect(result.rows).toHaveLength(3);
  });
});

describe('namedGscRow', () => {
  it('names values by the requested dimension order', () => {
    const dimensions: GscDimension[] = ['date', 'query', 'page'];
    const named = namedGscRow(
      { keys: ['2026-08-01', 'engine seo', 'https://example.com/a'], clicks: 1, impressions: 2, ctr: 0.5, position: 3 },
      dimensions,
    );
    expect(named).toEqual({ date: '2026-08-01', query: 'engine seo', page: 'https://example.com/a' });
  });

  it('fills a missing key with an empty string rather than undefined', () => {
    expect(namedGscRow({ keys: ['2026-08-01'], clicks: 0, impressions: 0, ctr: 0, position: 0 }, ['date', 'query'])).toEqual({
      date: '2026-08-01',
      query: '',
    });
  });
});
