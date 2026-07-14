import { describe, it, expect } from 'vitest';
import {
  wilsonInterval,
  citationBandFromSamples,
  buildCitationMeasurement,
  reconcileBands,
  type CitationSample,
} from './sampling.js';

const sample = (cited: boolean): CitationSample => ({ cited });

describe('wilsonInterval', () => {
  it('returns an uninformative band for n=0 without dividing by zero', () => {
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, point: 0, high: 1 });
  });

  it('keeps bounds inside [0,1] even at the extremes', () => {
    const allCited = wilsonInterval(5, 5);
    expect(allCited.point).toBe(1);
    expect(allCited.high).toBeLessThanOrEqual(1);
    expect(allCited.low).toBeGreaterThan(0); // Wilson never collapses to a point

    const noneCited = wilsonInterval(0, 5);
    expect(noneCited.point).toBe(0);
    expect(noneCited.low).toBeGreaterThanOrEqual(0);
    expect(noneCited.high).toBeLessThan(1);
  });

  it('widens the band as n shrinks for the same proportion', () => {
    const wide = wilsonInterval(1, 3); // p=0.33, n=3
    const narrow = wilsonInterval(10, 30); // p=0.33, n=30
    expect(wide.point).toBeCloseTo(narrow.point, 6);
    expect(wide.high - wide.low).toBeGreaterThan(narrow.high - narrow.low);
  });

  it('matches the known Wilson interval for 8/10 at 95%', () => {
    // Textbook value: 8/10 -> ~[0.490, 0.943]
    const band = wilsonInterval(8, 10);
    expect(band.point).toBeCloseTo(0.8, 6);
    expect(band.low).toBeCloseTo(0.4902, 3);
    expect(band.high).toBeCloseTo(0.9433, 3);
  });

  it('clamps successes that exceed n', () => {
    expect(wilsonInterval(7, 5).point).toBe(1);
  });
});

describe('citationBandFromSamples', () => {
  it('counts cited samples as the proportion point', () => {
    const band = citationBandFromSamples([
      sample(true),
      sample(true),
      sample(false),
      sample(true),
    ]);
    expect(band.point).toBeCloseTo(0.75, 6);
  });

  it('is uninformative for an empty batch', () => {
    expect(citationBandFromSamples([])).toEqual({ low: 0, point: 0, high: 1 });
  });
});

describe('buildCitationMeasurement', () => {
  it('assembles a stored measurement with band, n, and method', () => {
    const m = buildCitationMeasurement({
      engine: 'perplexity',
      prompt: 'best project management tool',
      samples: [sample(true), sample(false), sample(true)],
      method: 'api',
      measuredAt: '2026-07-14T00:00:00.000Z',
    });
    expect(m.engine).toBe('perplexity');
    expect(m.nSamples).toBe(3);
    expect(m.method).toBe('api');
    expect(m.citationRate.point).toBeCloseTo(2 / 3, 6);
    // band must carry real width -- never a point estimate
    expect(m.citationRate.high - m.citationRate.low).toBeGreaterThan(0);
  });
});

describe('reconcileBands', () => {
  it('pulls the point toward the tighter (better-sampled) band', () => {
    const api = { low: 0.58, point: 0.6, high: 0.62 }; // tight
    const consumer = { low: 0.2, point: 0.4, high: 0.6 }; // wide
    const r = reconcileBands(api, consumer);
    expect(r.point).toBeGreaterThan(0.5); // dragged toward the tight api band
    expect(r.point).toBeLessThan(0.6);
  });

  it('never understates uncertainty (width >= the wider input)', () => {
    const api = { low: 0.58, point: 0.6, high: 0.62 };
    const consumer = { low: 0.2, point: 0.4, high: 0.6 };
    const r = reconcileBands(api, consumer);
    expect(r.high - r.low).toBeCloseTo(0.4, 6); // = consumer width, the wider one
  });
});
