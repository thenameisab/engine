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
