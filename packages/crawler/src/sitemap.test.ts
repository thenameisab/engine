import { describe, it, expect } from 'vitest';
import { parseSitemapXml, normalizeUrl, extractSitemapDeclarations, fetchSitemapUrls } from './sitemap.js';

describe('parseSitemapXml', () => {
  it('parses a leaf urlset', () => {
    const xml = `<urlset><url><loc>https://example.com/a</loc></url><url><loc>https://example.com/b</loc></url></urlset>`;
    expect(parseSitemapXml(xml)).toEqual({
      kind: 'urlset',
      locs: ['https://example.com/a', 'https://example.com/b'],
    });
  });

  it('detects a sitemap index', () => {
    const xml = `<sitemapindex><sitemap><loc>https://example.com/sitemap-1.xml</loc></sitemap></sitemapindex>`;
    expect(parseSitemapXml(xml)).toEqual({ kind: 'sitemapindex', locs: ['https://example.com/sitemap-1.xml'] });
  });
});

describe('normalizeUrl', () => {
  it('strips a trailing slash and hash, keeps query', () => {
    expect(normalizeUrl('https://example.com/a/?x=1#frag')).toBe('https://example.com/a?x=1');
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com/');
  });
});

describe('extractSitemapDeclarations', () => {
  it('finds Sitemap: lines case-insensitively', () => {
    const txt = 'User-agent: *\nSitemap: https://example.com/sitemap.xml\n';
    expect(extractSitemapDeclarations(txt)).toEqual(['https://example.com/sitemap.xml']);
  });
});

describe('fetchSitemapUrls', () => {
  it('follows a sitemap index one level deep and merges leaf urlsets', async () => {
    const responses: Record<string, string> = {
      'https://example.com/index.xml': `<sitemapindex><sitemap><loc>https://example.com/s1.xml</loc></sitemap><sitemap><loc>https://example.com/s2.xml</loc></sitemap></sitemapindex>`,
      'https://example.com/s1.xml': `<urlset><url><loc>https://example.com/a</loc></url></urlset>`,
      'https://example.com/s2.xml': `<urlset><url><loc>https://example.com/b/</loc></url></urlset>`,
    };
    const fakeFetch = (async (url: string) => ({
      ok: url in responses,
      text: async () => responses[url] ?? '',
    })) as unknown as typeof fetch;

    const urls = await fetchSitemapUrls('https://example.com/index.xml', fakeFetch);
    expect(urls).toEqual(new Set(['https://example.com/a', 'https://example.com/b']));
  });

  it('skips sitemaps that fail to fetch instead of throwing', async () => {
    const fakeFetch = (async () => ({ ok: false, text: async () => '' })) as unknown as typeof fetch;
    const urls = await fetchSitemapUrls('https://example.com/missing.xml', fakeFetch);
    expect(urls.size).toBe(0);
  });
});
