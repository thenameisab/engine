import { describe, it, expect } from 'vitest';
import type { CitationMeasurement } from '@engine/core';
import { organicSov, ctrForPosition, DEFAULT_CTR_CURVE } from './organic.js';
import { aiSov } from './ai.js';
import { localSov } from './local.js';
import { unifiedVisibilityScore, DEFAULT_CHANNEL_MIX } from './unified.js';

const cm = (
  point: number,
  low: number,
  high: number,
  extra: Partial<CitationMeasurement> = {},
): CitationMeasurement => ({
  engine: 'chatgpt',
  prompt: 'best crm for startups',
  nSamples: 5,
  citationRate: { low, point, high },
  method: 'api',
  measuredAt: '2026-07-14T00:00:00.000Z',
  ...extra,
});

describe('organicSov', () => {
  it('is 0 for an empty set', () => {
    expect(organicSov([])).toBe(0);
  });

  it('is 100 when every tracked keyword ranks #1', () => {
    const rows = [
      { keyword: 'a', position: 1, volume: 100 },
      { keyword: 'b', position: 1, volume: 50 },
    ];
    expect(organicSov(rows)).toBeCloseTo(100, 6);
  });

  it('is 0 when the domain ranks nowhere', () => {
    const rows = [{ keyword: 'a', position: null, volume: 100 }];
    expect(organicSov(rows)).toBe(0);
  });

  it('weights by volume, not keyword count', () => {
    // High-volume keyword at #1, low-volume keyword absent -> near 100.
    const rows = [
      { keyword: 'big', position: 1, volume: 10_000 },
      { keyword: 'small', position: null, volume: 1 },
    ];
    expect(organicSov(rows)).toBeGreaterThan(99);
  });

  it('treats positions past the curve tail as no visibility', () => {
    expect(ctrForPosition(999)).toBe(0);
    expect(ctrForPosition(1)).toBe(DEFAULT_CTR_CURVE[0]);
  });
});

describe('aiSov', () => {
  it('is a zero band for no measurements', () => {
    expect(aiSov([])).toEqual({ low: 0, point: 0, high: 0 });
  });

  it('averages bounds independently and scales to 0-100, preserving width', () => {
    const band = aiSov([cm(0.4, 0.3, 0.5), cm(0.6, 0.5, 0.7)]);
    expect(band.point).toBeCloseTo(50, 6);
    expect(band.low).toBeCloseTo(40, 6);
    expect(band.high).toBeCloseTo(60, 6);
    expect(band.high - band.low).toBeGreaterThan(0); // uncertainty not hidden
  });

  it('honors weights and drops zero-weight rows', () => {
    const band = aiSov(
      [cm(0.2, 0.2, 0.2), cm(0.8, 0.8, 0.8)],
      (_m, i) => (i === 0 ? 0 : 1),
    );
    expect(band.point).toBeCloseTo(80, 6);
  });
});

describe('localSov', () => {
  it('is 100 when every query holds the top pack slot', () => {
    const rows = [{ keyword: 'plumber near me', packPosition: 1, volume: 500 }];
    expect(localSov(rows)).toBeCloseTo(100, 6);
  });

  it('is 0 when absent from every pack', () => {
    const rows = [{ keyword: 'plumber near me', packPosition: null, volume: 500 }];
    expect(localSov(rows)).toBe(0);
  });
});

describe('unifiedVisibilityScore', () => {
  it('blends surfaces by normalized channel mix', () => {
    const result = unifiedVisibilityScore(
      { organic: 80, ai: { low: 40, point: 50, high: 60 }, local: 20 },
      { organic: 0.6, ai: 0.3, local: 0.1 },
    );
    // 0.6*80 + 0.3*50 + 0.1*20 = 48 + 15 + 2 = 65
    expect(result.band.point).toBeCloseTo(65, 6);
  });

  it('propagates only the AI band width, scaled by AI weight', () => {
    const result = unifiedVisibilityScore(
      { organic: 80, ai: { low: 40, point: 50, high: 60 }, local: 20 },
      { organic: 0.6, ai: 0.3, local: 0.1 },
    );
    // AI band width 20 * ai weight 0.3 = 6 total width, symmetric about point.
    expect(result.band.high - result.band.low).toBeCloseTo(6, 6);
    expect(result.band.low).toBeCloseTo(62, 6);
    expect(result.band.high).toBeCloseTo(68, 6);
  });

  it('normalizes an un-normalized mix', () => {
    const result = unifiedVisibilityScore(
      { organic: 100, ai: { low: 0, point: 0, high: 0 }, local: 0 },
      { organic: 3, ai: 1, local: 1 }, // -> 0.6 / 0.2 / 0.2
    );
    expect(result.weights.organic).toBeCloseTo(0.6, 6);
    expect(result.band.point).toBeCloseTo(60, 6);
  });

  it('returns a zero score for an empty mix without dividing by zero', () => {
    const result = unifiedVisibilityScore(
      { organic: 80, ai: { low: 40, point: 50, high: 60 }, local: 20 },
      { organic: 0, ai: 0, local: 0 },
    );
    expect(result.band).toEqual({ low: 0, point: 0, high: 0 });
  });

  it('exposes a decomposition that sums to the point score', () => {
    const result = unifiedVisibilityScore(
      { organic: 80, ai: { low: 40, point: 50, high: 60 }, local: 20 },
      DEFAULT_CHANNEL_MIX,
    );
    const { organic, ai, local } = result.decomposition;
    const sum = organic.contribution + ai.contribution + local.contribution;
    expect(sum).toBeCloseTo(result.band.point, 6);
  });
});
