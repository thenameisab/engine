import { describe, it, expect, vi } from 'vitest';
import type { SerpQuery } from './serp.js';
import {
  SerperConnector,
  mapSerperResponse,
  detectSerperFeatures,
  serperRequestBody,
  type SerperResponse,
} from './serpSerper.js';

const query: SerpQuery = {
  keyword: 'best running shoes',
  geo: { country: 'US', city: 'Austin,Texas,United States' },
  device: 'desktop',
  language: 'en',
  engine: 'google',
};

/** A realistic slice of a Serper.dev /search response. */
const fixture: SerperResponse = {
  searchParameters: { q: 'best running shoes', gl: 'us', hl: 'en' },
  answerBox: { snippet: 'The best running shoes are...' },
  organic: [
    { title: 'Best Running Shoes 2026', link: 'https://runnersworld.com/best', position: 1 },
    { title: 'Top 10 Running Shoes', link: 'https://nytimes.com/wirecutter', position: 2 },
    { title: 'no position', link: 'https://example.com/x' } as { title: string; link: string },
  ],
  peopleAlsoAsk: [{ question: 'Which running shoe is best?' }],
  places: [{ title: 'Local Running Store' }],
  aiOverview: { text: 'AI overview content' },
};

describe('serperRequestBody', () => {
  it('maps geo/device/language onto Serper params', () => {
    expect(serperRequestBody(query)).toEqual({
      q: 'best running shoes',
      gl: 'us',
      hl: 'en',
      location: 'Austin,Texas,United States',
    });
  });

  it('adds device=mobile only for mobile queries', () => {
    expect(serperRequestBody({ ...query, device: 'mobile' })).toMatchObject({ device: 'mobile' });
    expect(serperRequestBody({ ...query, device: 'desktop' })).not.toHaveProperty('device');
  });
});

describe('detectSerperFeatures', () => {
  it('detects the features present in the response', () => {
    expect(detectSerperFeatures(fixture).sort()).toEqual(
      ['ai_overview', 'featured_snippet', 'local_pack', 'people_also_ask'].sort(),
    );
  });

  it('returns no features for a bare organic-only response', () => {
    expect(detectSerperFeatures({ organic: [{ title: 't', link: 'u', position: 1 }] })).toEqual([]);
  });
});

describe('mapSerperResponse', () => {
  it('maps organic results and drops entries missing a position/link', () => {
    const result = mapSerperResponse(query, fixture, { rawSnapshotRef: 'ref_1', polledAt: '2026-07-15T00:00:00.000Z' });
    expect(result.organic).toEqual([
      { position: 1, url: 'https://runnersworld.com/best', title: 'Best Running Shoes 2026' },
      { position: 2, url: 'https://nytimes.com/wirecutter', title: 'Top 10 Running Shoes' },
    ]);
    expect(result.features).toContain('ai_overview');
    expect(result.rawSnapshotRef).toBe('ref_1');
    expect(result.query).toBe(query);
  });
});

describe('SerperConnector.fetch', () => {
  it('POSTs to Serper with the API key header and maps the response', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(fixture), { status: 200 }));
    const connector = new SerperConnector({
      apiKey: 'serper_test_key',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      rawSink: () => 'ref_raw',
      now: () => new Date('2026-07-15T12:00:00.000Z'),
    });

    const result = await connector.fetch(query);

    expect(connector.vendor).toBe('serper');
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://google.serper.dev/search');
    expect((init as RequestInit).headers).toMatchObject({ 'X-API-KEY': 'serper_test_key' });
    expect(result.organic).toHaveLength(2);
    expect(result.rawSnapshotRef).toBe('ref_raw');
    expect(result.polledAt).toBe('2026-07-15T12:00:00.000Z');
  });

  it('throws on a non-OK response', async () => {
    const fetchImpl = vi.fn(async () => new Response('rate limited', { status: 429 }));
    const connector = new SerperConnector({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(connector.fetch(query)).rejects.toThrow('Serper request failed: 429');
  });

  it('rejects non-google engines (Serper is Google-only)', async () => {
    const connector = new SerperConnector({ apiKey: 'k', fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch });
    await expect(connector.fetch({ ...query, engine: 'bing' })).rejects.toThrow("only supports the 'google' engine");
  });

  it('requires an api key', () => {
    expect(() => new SerperConnector({ apiKey: '' })).toThrow('requires an apiKey');
  });
});
