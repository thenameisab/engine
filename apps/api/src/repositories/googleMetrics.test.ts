import { describe, expect, it } from 'vitest';
import {
  brandTerms,
  isBrandQuery,
  periodsEndingAt,
  withinReach,
  topByClicks,
  classifyAiSource,
  foldChannels,
  channelLabel,
  AI_CHANNEL_KEY,
  type SearchQueryRow,
} from './googleMetrics.js';

/**
 * Fixtures are real rows from a real property (tartanhq.com, August to
 * September 2026), reduced. The rules below decide what a customer sees, so
 * they are tested against the shapes Google actually returns, not invented
 * ones.
 */

describe('periodsEndingAt', () => {
  it('builds two adjacent 28-day periods ending on the latest stored day', () => {
    const { current, previous } = periodsEndingAt('2026-09-06');
    expect(current).toEqual({ from: '2026-08-10', to: '2026-09-06' });
    expect(previous).toEqual({ from: '2026-07-13', to: '2026-08-09' });
  });
});

describe('brandTerms / isBrandQuery', () => {
  const terms = brandTerms('tartanhq.com', ['TartanHQ']);

  it('derives one term from the domain label and the entity name when they agree', () => {
    expect(terms).toEqual(['tartanhq']);
  });

  it('drops labels too short to be a safe match', () => {
    expect(brandTerms('hq.io', ['HQ'])).toEqual([]);
  });

  it('flags the exact brand, the spaced form, the shortened form and the domain', () => {
    for (const q of ['tartanhq', 'tartan hq', 'tartan', 'tartanhq.com', 'tartan hq gurgaon', 'tartanhq career']) {
      expect(isBrandQuery(q, terms), q).toBe(true);
    }
  });

  it('does not flag the queries the site should be winning on merit', () => {
    for (const q of ['income verification api', 'context layer for ai agents', 'digital cpv', 'pan api', 'taartan']) {
      expect(isBrandQuery(q, terms), q).toBe(false);
    }
  });
});

const row = (query: string, clicks: number, impressions: number, position: number, brand = false): SearchQueryRow => ({
  query,
  clicks,
  impressions,
  ctr: impressions ? clicks / impressions : 0,
  position,
  brand,
});

describe('withinReach', () => {
  const rows = [
    row('tartanhq', 209, 735, 3.7, true),
    row('income verification api', 0, 57, 13.3),
    row('context layer for ai agents', 1, 16, 24.1),
    row('digital cpv', 1, 14, 6.1),
    row('pan api', 1, 1, 12.0),
    row('tartan careers', 8, 13, 1.1, true),
    row('yes for loan', 1, 1, 1.0),
  ];

  it('keeps non-brand queries on page one or two with real impressions, by impressions', () => {
    expect(withinReach(rows).map((r) => r.query)).toEqual(['income verification api', 'digital cpv']);
  });

  it('excludes brand queries, page three and beyond, and single-impression noise', () => {
    const kept = withinReach(rows).map((r) => r.query);
    expect(kept).not.toContain('tartanhq');
    expect(kept).not.toContain('context layer for ai agents');
    expect(kept).not.toContain('pan api');
  });
});

describe('topByClicks', () => {
  it('orders by clicks then impressions and caps the list', () => {
    const rows = [row('a', 1, 50, 5), row('b', 5, 10, 2), row('c', 1, 90, 8)];
    expect(topByClicks(rows, 2).map((r) => r.query)).toEqual(['b', 'c']);
  });
});

describe('classifyAiSource', () => {
  it("trusts GA4's own AI Assistant channel", () => {
    expect(classifyAiSource('AI Assistant', 'chatgpt.com')).toBe('ga4');
    expect(classifyAiSource('AI Assistant', 'claude.ai')).toBe('ga4');
  });

  it('supplements it for assistants GA4 leaves unassigned, and says so', () => {
    expect(classifyAiSource('Unassigned', 'copilot.com')).toBe('engine');
    expect(classifyAiSource('Referral', 'www.perplexity.ai/')).toBe('engine');
  });

  it('never classifies a search engine or a plain referrer as an AI assistant', () => {
    expect(classifyAiSource('Organic Search', 'bing')).toBeNull();
    expect(classifyAiSource('Organic Search', 'google')).toBeNull();
    expect(classifyAiSource('Referral', 'blog.google')).toBeNull();
    expect(classifyAiSource('Unassigned', 'eliteai.tools')).toBeNull();
  });
});

describe('foldChannels', () => {
  const rows = [
    { channel_group: 'Cross-network', source: 'google', sessions: '4357', engaged_sessions: '1037', conversions: '279' },
    { channel_group: 'Organic Search', source: 'google', sessions: '1153', engaged_sessions: '651', conversions: '117' },
    { channel_group: 'Organic Search', source: 'bing', sessions: '48', engaged_sessions: '17', conversions: '4' },
    { channel_group: 'AI Assistant', source: 'chatgpt.com', sessions: '88', engaged_sessions: '52', conversions: '29' },
    { channel_group: 'AI Assistant', source: 'claude.ai', sessions: '7', engaged_sessions: '0', conversions: '0' },
    { channel_group: 'Unassigned', source: 'copilot.com', sessions: '1', engaged_sessions: '0', conversions: '0' },
    { channel_group: 'Unassigned', source: 'eliteai.tools', sessions: '159', engaged_sessions: '143', conversions: '2' },
  ];

  it('sums sources into channels and pulls every AI assistant into one channel', () => {
    const { channels } = foldChannels(rows);
    const ai = channels.find((c) => c.key === AI_CHANNEL_KEY)!;
    expect(ai.label).toBe('AI assistants');
    expect(ai.sessions).toBe(96);
    expect(ai.keyEvents).toBe(29);
    const organic = channels.find((c) => c.key === 'Organic Search')!;
    expect(organic.sessions).toBe(1201);
    // copilot.com left Unassigned; eliteai.tools stayed.
    expect(channels.find((c) => c.key === 'Unassigned')!.sessions).toBe(159);
  });

  it('sorts channels by sessions and parses the strings Postgres returns for sums', () => {
    const { channels } = foldChannels(rows);
    expect(channels[0].key).toBe('Cross-network');
    expect(typeof channels[0].sessions).toBe('number');
  });

  it('lists each assistant with who classified it', () => {
    const { aiAssistants } = foldChannels(rows);
    expect(aiAssistants.map((a) => [a.source, a.classifiedBy])).toEqual([
      ['chatgpt.com', 'ga4'],
      ['claude.ai', 'ga4'],
      ['copilot.com', 'engine'],
    ]);
  });
});

describe('channelLabel', () => {
  it("renames the two GA4 groups customers misread and keeps the rest as GA4 names them", () => {
    expect(channelLabel('Cross-network')).toBe('Google Ads (cross-network)');
    expect(channelLabel('Unassigned')).toBe('Unclassified');
    expect(channelLabel('Organic Search')).toBe('Organic Search');
  });
});
