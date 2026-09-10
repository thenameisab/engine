import { describe, it, expect } from 'vitest';
import { extractUrls, hostOf, normalizeDomain, buildCitationEvent } from './llmCitation.js';

describe('extractUrls', () => {
  it('pulls urls and trims trailing punctuation', () => {
    expect(extractUrls('See https://acme.example/page, and (https://other.com).')).toEqual([
      'https://acme.example/page',
      'https://other.com',
    ]);
  });
});

describe('hostOf / normalizeDomain', () => {
  it('strips www and lowercases', () => {
    expect(hostOf('https://WWW.Acme.Example/x')).toBe('acme.example');
    expect(normalizeDomain('https://www.Acme.example/blog')).toBe('acme.example');
  });
});

describe('buildCitationEvent', () => {
  it('marks cited when a source host matches a domain target', () => {
    const ev = buildCitationEvent('Per https://acme.example/guide it is best.', [], ['acme.example']);
    expect(ev.cited).toBe(true);
    expect(ev.sourcesCited).toContain('https://acme.example/guide');
    expect(ev.sentiment).toBeNull();
    expect(ev.accuracy).toBeNull();
  });

  it('matches a subdomain of a domain target', () => {
    const ev = buildCitationEvent('', ['https://blog.acme.example/post'], ['acme.example']);
    expect(ev.cited).toBe(true);
  });

  it('marks cited when a brand-name target appears in the text', () => {
    const ev = buildCitationEvent('Acme makes the best widgets.', [], ['Acme']);
    expect(ev.cited).toBe(true);
  });

  it('merges grounding sources with text urls, deduped', () => {
    const ev = buildCitationEvent('Text cites https://a.com/x', ['https://a.com/x', 'https://b.com/y'], []);
    expect(ev.sourcesCited.sort()).toEqual(['https://a.com/x', 'https://b.com/y']);
  });

  it('is not cited when neither domain nor name targets match', () => {
    const ev = buildCitationEvent('Some answer citing https://competitor.com.', [], ['acme.example', 'Acme']);
    expect(ev.cited).toBe(false);
  });

  it('cannot assert citation without targets, but still returns sources', () => {
    const ev = buildCitationEvent('https://acme.example is great', [], undefined);
    expect(ev.cited).toBe(false);
    expect(ev.sourcesCited).toEqual(['https://acme.example']);
  });
});

describe('buildCitationEvent: the two halves of "cited"', () => {
  it('reports a name match as named, not linked', () => {
    // The only outcome a non-browsing engine can produce. Reporting it as a
    // citation would claim the model sent someone to the site.
    const e = buildCitationEvent('Acme is a good option.', [], ['acme.example', 'Acme']);
    expect(e.cited).toBe(true);
    expect(e.citedByName).toBe(true);
    expect(e.citedByDomain).toBe(false);
  });

  it('reports a domain match as linked', () => {
    const e = buildCitationEvent('See https://acme.example/pricing', [], ['acme.example']);
    expect(e.cited).toBe(true);
    expect(e.citedByDomain).toBe(true);
    expect(e.citedByName).toBe(false);
  });

  it('can be both at once', () => {
    const e = buildCitationEvent('Acme — https://acme.example', [], ['acme.example', 'Acme']);
    expect(e.citedByName).toBe(true);
    expect(e.citedByDomain).toBe(true);
    expect(e.cited).toBe(true);
  });

  it('is neither when the brand is absent, even with other sources', () => {
    const e = buildCitationEvent('Try https://other.example', [], ['acme.example', 'Acme']);
    expect(e.cited).toBe(false);
    expect(e.citedByName).toBe(false);
    expect(e.citedByDomain).toBe(false);
    expect(e.sourcesCited).toEqual(['https://other.example']);
  });

  it('is neither when there are no targets to judge against', () => {
    const e = buildCitationEvent('Acme is great, https://acme.example', [], undefined);
    expect(e.cited).toBe(false);
    expect(e.citedByName).toBe(false);
    expect(e.citedByDomain).toBe(false);
  });

  it('keeps `cited` the union of the two, so the score reads the same number', () => {
    for (const text of ['Acme wins', 'https://acme.example', 'nothing here']) {
      const e = buildCitationEvent(text, [], ['acme.example', 'Acme']);
      expect(e.cited).toBe(e.citedByName || e.citedByDomain);
    }
  });
});
