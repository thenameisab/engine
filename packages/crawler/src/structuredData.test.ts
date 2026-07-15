import { describe, it, expect } from 'vitest';
import { extractStructuredData } from './structuredData.js';

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
