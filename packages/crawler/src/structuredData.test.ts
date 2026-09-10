import { describe, it, expect } from 'vitest';
import { extractStructuredData, parseJsonLdNodes } from './structuredData.js';

describe('extractStructuredData', () => {
  it('validates a well-formed Organization block', () => {
    const blocks = extractStructuredData([
      JSON.stringify({ '@context': 'https://schema.org', '@type': 'Organization', name: 'Acme', url: 'https://acme.example' }),
    ]);
    expect(blocks).toEqual([{ type: 'Organization', valid: true, errors: [] }]);
  });

  it('flags missing required properties', () => {
    const blocks = extractStructuredData([
      JSON.stringify({ '@context': 'https://schema.org', '@type': 'Organization' }),
    ]);
    expect(blocks[0]!.valid).toBe(false);
    expect(blocks[0]!.errors).toContain("missing required property 'name'");
    expect(blocks[0]!.errors).toContain("missing required property 'url'");
  });

  it('reports invalid JSON as an Unknown invalid block instead of dropping it', () => {
    const blocks = extractStructuredData(['{ not valid json']);
    expect(blocks).toEqual([{ type: 'Unknown', valid: false, errors: ['invalid JSON'] }]);
  });

  it('flattens @graph containers into individual nodes', () => {
    const blocks = extractStructuredData([
      JSON.stringify({
        '@context': 'https://schema.org',
        '@graph': [
          { '@type': 'WebSite', name: 'Acme', url: 'https://acme.example' },
          { '@type': 'Person', name: 'Jane' },
        ],
      }),
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks.map((b) => b.type)).toEqual(['WebSite', 'Person']);
    expect(blocks.every((b) => b.valid)).toBe(true);
  });

  it('handles an empty script list', () => {
    expect(extractStructuredData([])).toEqual([]);
  });
});

describe('parseJsonLdNodes', () => {
  it('returns the node content, not a verdict on it', () => {
    // `extractStructuredData` answers B1.4 and throws the content away. The
    // B3 entity audit needs the content: whether a block names the entity,
    // and which profiles its sameAs lists.
    const org = { '@context': 'https://schema.org', '@type': 'Organization', name: 'Acme', sameAs: ['https://x.com/acme'] };
    expect(parseJsonLdNodes([JSON.stringify(org)])).toEqual([org]);
  });

  it('flattens @graph containers the same way validation does', () => {
    const doc = {
      '@context': 'https://schema.org',
      '@graph': [{ '@type': 'Organization', name: 'Acme' }, { '@type': 'WebSite', name: 'Acme' }],
    };
    const nodes = parseJsonLdNodes([JSON.stringify(doc)]) as Record<string, unknown>[];
    expect(nodes.map((n) => n['@type'])).toEqual(['Organization', 'WebSite']);
    // @context is inherited by @graph members, as it is for validation.
    expect(nodes[0]!['@context']).toBe('https://schema.org');
  });

  it('skips a block that will not parse', () => {
    // Already reported as an invalid block by extractStructuredData; there is
    // nothing here to read.
    expect(parseJsonLdNodes(['{ not valid json '])).toEqual([]);
  });
});
