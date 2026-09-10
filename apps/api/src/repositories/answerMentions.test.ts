import { describe, expect, it } from 'vitest';
import { brandKey, extractionPrompt, matchKnownBrands, mineMentions, parseExtractedNames, type KnownBrand } from './answerMentions.js';

const brands: KnownBrand[] = [
  { entityId: 'e-self', name: 'TartanHQ', isSelf: true },
  { entityId: 'e-1', name: 'Workato', isSelf: false },
  { entityId: 'e-2', name: 'HR', isSelf: false },
];

describe('matchKnownBrands', () => {
  it('matches tracked names case-insensitively at word boundaries', () => {
    const text = 'For enterprise integration, TARTANHQ and Workato are common picks; workatoish is not a product.';
    expect(matchKnownBrands(text, brands).map((m) => m.brand)).toEqual(['TartanHQ', 'Workato']);
    expect(matchKnownBrands(text, brands)[0]).toMatchObject({ isSelf: true, matchedEntityId: 'e-self', source: 'known' });
  });

  it('does not match a name inside another word, and skips names shorter than three characters', () => {
    expect(matchKnownBrands('tartanhqs are great; HR teams agree', brands)).toEqual([]);
  });
});

describe('parseExtractedNames', () => {
  it('reads a bare JSON array', () => {
    expect(parseExtractedNames('["Workato", "Zapier", "Boomi"]')).toEqual(['Workato', 'Zapier', 'Boomi']);
  });

  it('finds the array inside prose or a code fence, and de-duplicates by key', () => {
    expect(parseExtractedNames('Sure! Here it is:\n```json\n["Zapier", "zapier", " Make "]\n```')).toEqual(['Zapier', 'Make']);
  });

  it('treats anything that is not a list of strings as "named none"', () => {
    expect(parseExtractedNames('none')).toEqual([]);
    expect(parseExtractedNames('{"names": 3}')).toEqual([]);
    expect(parseExtractedNames('[1, 2, 3]')).toEqual([]);
    expect(parseExtractedNames('[')).toEqual([]);
  });

  it('caps the list and drops absurd entries', () => {
    const many = JSON.stringify(Array.from({ length: 30 }, (_, i) => `Brand ${i}`));
    expect(parseExtractedNames(many)).toHaveLength(20);
    expect(parseExtractedNames(JSON.stringify(['x', 'a'.repeat(81), 'Ok Co']))).toEqual(['Ok Co']);
  });
});

describe('mineMentions', () => {
  it('runs both passes and folds an extracted spelling into the tracked brand', async () => {
    const asked: string[] = [];
    const completer = {
      async complete(prompt: string) {
        asked.push(prompt);
        return '["Tartan HQ", "Zapier", "Workato"]';
      },
    };
    const mentions = await mineMentions('TartanHQ and Workato and Zapier all do this.', brands, completer);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toBe(extractionPrompt('TartanHQ and Workato and Zapier all do this.'));
    expect(mentions.map((m) => [m.brand, m.source, m.matchedEntityId])).toEqual([
      ['TartanHQ', 'known', 'e-self'],
      ['Workato', 'known', 'e-1'],
      ['Zapier', 'extracted', null],
    ]);
  });

  it('is deterministic only when no extractor is available', async () => {
    const mentions = await mineMentions('Workato is one option.', brands, null);
    expect(mentions).toEqual([{ brand: 'Workato', isSelf: false, matchedEntityId: 'e-1', source: 'known' }]);
  });

  it('asks nothing about an empty answer', async () => {
    let calls = 0;
    const completer = { complete: async () => (calls++, '[]') };
    expect(await mineMentions('   ', brands, completer)).toEqual([]);
    expect(calls).toBe(0);
  });
});

describe('brandKey', () => {
  it('lower-cases and collapses whitespace', () => {
    expect(brandKey('  Tartan   HQ ')).toBe('tartan hq');
  });
});
