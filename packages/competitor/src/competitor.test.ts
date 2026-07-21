import { describe, it, expect } from 'vitest';
import { computeGaps, ENTITY_GAP_MIN_DELTA } from './gaps.js';
import { runCompetitorAudit } from './audit.js';
import { actionTemplatesFor, findingSourceFor } from './actions.js';
import type { CompetitorFacts, GapType } from './types.js';

function facts(over: Partial<CompetitorFacts> = {}): CompetitorFacts {
  return {
    entityId: 'self',
    canonicalName: 'Acme Corp',
    keywords: ['crm software'],
    prompts: ['best crm'],
    topics: ['crm'],
    referringDomains: ['forbes.com'],
    entityStrength: 0.5,
    ...over,
  };
}

describe('computeGaps — membership dimensions', () => {
  const self = facts({ keywords: ['crm software'], prompts: [], topics: [], referringDomains: [] });
  const c1 = facts({ entityId: 'c1', keywords: ['crm software', 'sales pipeline'] });
  const c2 = facts({ entityId: 'c2', keywords: ['sales pipeline', 'lead scoring'] });

  it('flags only keywords self lacks', () => {
    const { byType } = computeGaps(self, [c1, c2]);
    const items = byType['keyword-gap'].map((g) => g.item).sort();
    expect(items).toEqual(['lead scoring', 'sales pipeline']);
  });

  it('weights impact by how many competitors hold the gap', () => {
    const { byType } = computeGaps(self, [c1, c2]);
    const pipeline = byType['keyword-gap'].find((g) => g.item === 'sales pipeline')!;
    const lead = byType['keyword-gap'].find((g) => g.item === 'lead scoring')!;
    expect(pipeline.heldByCount).toBe(2);
    expect(pipeline.impact).toBe(1); // 2 of 2 competitors
    expect(lead.heldByCount).toBe(1);
    expect(lead.impact).toBe(0.5); // 1 of 2
  });

  it('normalizes case + whitespace so a self-held item is not a gap', () => {
    const s = facts({ keywords: ['  CRM Software '] });
    const comp = facts({ entityId: 'c1', keywords: ['crm software'] });
    const { byType } = computeGaps(s, [comp]);
    expect(byType['keyword-gap']).toHaveLength(0);
  });
});

describe('computeGaps — entity strength differential', () => {
  it('flags a competitor meaningfully stronger than self', () => {
    const self = facts({ entityStrength: 0.4 });
    const strong = facts({ entityId: 'c1', canonicalName: 'Globex', entityStrength: 0.9 });
    const { byType } = computeGaps(self, [strong]);
    expect(byType['entity-gap']).toHaveLength(1);
    expect(byType['entity-gap'][0].item).toBe('Globex');
    expect(byType['entity-gap'][0].impact).toBeCloseTo(0.5);
  });

  it('ignores competitors within the delta floor', () => {
    const self = facts({ entityStrength: 0.5 });
    const near = facts({ entityId: 'c1', entityStrength: 0.5 + ENTITY_GAP_MIN_DELTA / 2 });
    expect(computeGaps(self, [near]).byType['entity-gap']).toHaveLength(0);
  });

  it('treats null self strength as 0 (they are understood, you are not)', () => {
    const self = facts({ entityStrength: null });
    const comp = facts({ entityId: 'c1', canonicalName: 'Globex', entityStrength: 0.8 });
    expect(computeGaps(self, [comp]).byType['entity-gap'][0].impact).toBeCloseTo(0.8);
  });

  it('skips competitors with no strength computed yet', () => {
    const self = facts({ entityStrength: 0.2 });
    const comp = facts({ entityId: 'c1', entityStrength: null });
    expect(computeGaps(self, [comp]).byType['entity-gap']).toHaveLength(0);
  });
});

describe('computeGaps — ranking', () => {
  it('sorts biggest impact first across all dimensions', () => {
    const self = facts({ keywords: [], prompts: [], topics: [], referringDomains: [], entityStrength: 0.5 });
    const c1 = facts({ entityId: 'c1', keywords: ['a'], prompts: ['p'], topics: ['t'], referringDomains: ['d.com'] });
    const { gaps } = computeGaps(self, [c1]);
    for (let i = 1; i < gaps.length; i++) expect(gaps[i - 1].impact).toBeGreaterThanOrEqual(gaps[i].impact);
  });
});

describe('runCompetitorAudit', () => {
  const self = facts({ entityId: 'self', keywords: [], prompts: [], topics: [], referringDomains: [], entityStrength: 0.3 });
  const comp = facts({
    entityId: 'c1',
    canonicalName: 'Globex',
    keywords: ['sales pipeline'],
    prompts: ['best pipeline tool'],
    topics: ['pipelines'],
    referringDomains: ['forbes.com'],
    entityStrength: 0.9,
  });

  it('emits one Finding per gap with a deterministic id and mapped action', () => {
    const now = () => '2026-07-21T00:00:00.000Z';
    const a = runCompetitorAudit(self, [comp], { now });
    const b = runCompetitorAudit(self, [comp], { now });
    expect(a.findings.map((f) => f.id)).toEqual(b.findings.map((f) => f.id)); // reproducible
    for (const f of a.findings) {
      expect(f.createdAt).toBe('2026-07-21T00:00:00.000Z');
      expect(f.actionTemplates.length).toBeGreaterThan(0);
    }
  });

  it('files the entity gap under source "entity", membership gaps under "content"', () => {
    const { findings } = runCompetitorAudit(self, [comp]);
    const entityFinding = findings.find((f) => f.issueType === 'entity-gap')!;
    const keywordFinding = findings.find((f) => f.issueType === 'keyword-gap')!;
    expect(entityFinding.source).toBe('entity');
    expect(keywordFinding.source).toBe('content');
  });

  it('minImpactForFinding filters low-impact gaps out of the Fix Queue', () => {
    const self2 = facts({ entityId: 'self', keywords: [], prompts: [], topics: [], referringDomains: [], entityStrength: 0.5 });
    // 'shared' held by both (impact 1.0); 'solo' held by one (impact 0.5).
    const c1 = facts({ entityId: 'c1', keywords: ['shared', 'solo'], prompts: [], topics: [], referringDomains: [], entityStrength: 0.5 });
    const c2 = facts({ entityId: 'c2', keywords: ['shared'], prompts: [], topics: [], referringDomains: [], entityStrength: 0.5 });
    const all = runCompetitorAudit(self2, [c1, c2]);
    const filtered = runCompetitorAudit(self2, [c1, c2], { minImpactForFinding: 1 });
    expect(all.findings).toHaveLength(2);
    expect(filtered.findings).toHaveLength(1); // only the impact-1.0 'shared' gap
    expect(filtered.findings[0].evidence).toMatchObject({ item: 'shared' });
  });
});

describe('actions map', () => {
  it('every gap type has a template and a source', () => {
    const types: GapType[] = ['keyword-gap', 'citation-gap', 'content-gap', 'entity-gap', 'backlink-gap'];
    for (const t of types) {
      expect(actionTemplatesFor(t).length).toBeGreaterThan(0);
      expect(['content', 'entity']).toContain(findingSourceFor(t));
    }
  });
});
