import { describe, it, expect } from 'vitest';
import {
  registrableDomain,
  authorityScore,
  buildDomainIntel,
  citationOpportunities,
  sentimentSummary,
  missingProfiles,
  AUTHORITY_SATURATION,
  OPPORTUNITY_MIN_AUTHORITY,
} from './intel.js';
import { runOffsiteAudit } from './audit.js';
import type { CitationObservation } from './types.js';

function obs(over: Partial<CitationObservation> = {}): CitationObservation {
  return { entityId: 'self', citedDomains: [], engine: 'openai', sentiment: null, ...over };
}

describe('registrableDomain', () => {
  it('strips scheme, path, query, and www', () => {
    expect(registrableDomain('https://www.g2.com/products/acme?x=1')).toBe('g2.com');
  });
  it('collapses subdomains to the last two labels', () => {
    expect(registrableDomain('reviews.capterra.com')).toBe('capterra.com');
  });
  it('returns null for empty input', () => {
    expect(registrableDomain('   ')).toBeNull();
  });
});

describe('authorityScore', () => {
  it('saturates at AUTHORITY_SATURATION distinct entities', () => {
    expect(authorityScore(0)).toBe(0);
    expect(authorityScore(AUTHORITY_SATURATION)).toBe(1);
    expect(authorityScore(AUTHORITY_SATURATION + 3)).toBe(1);
    expect(authorityScore(1)).toBeCloseTo(1 / AUTHORITY_SATURATION);
  });
});

describe('buildDomainIntel', () => {
  const observations = [
    obs({ entityId: 'self', citedDomains: ['https://wikipedia.org/Acme'] }),
    obs({ entityId: 'c1', citedDomains: ['https://g2.com/x', 'https://forbes.com/y'] }),
    obs({ entityId: 'c2', citedDomains: ['https://g2.com/z'] }),
    obs({ entityId: 'c3', citedDomains: ['https://g2.com/w'] }),
  ];

  it('aggregates count + distinct entities per domain', () => {
    const intel = buildDomainIntel(observations, 'self');
    const g2 = intel.find((d) => d.domain === 'g2.com')!;
    expect(g2.citationCount).toBe(3);
    expect(g2.distinctEntities).toBe(3);
    expect(g2.selfPresent).toBe(false);
  });

  it('marks a domain the self-entity cited as selfPresent', () => {
    const intel = buildDomainIntel(observations, 'self');
    expect(intel.find((d) => d.domain === 'wikipedia.org')!.selfPresent).toBe(true);
  });

  it('counts a domain once per observation even if repeated in that answer', () => {
    const intel = buildDomainIntel([obs({ entityId: 'c1', citedDomains: ['g2.com/a', 'www.g2.com/b'] })], 'self');
    expect(intel.find((d) => d.domain === 'g2.com')!.citationCount).toBe(1);
  });
});

describe('citationOpportunities', () => {
  it('flags high-authority domains the self-entity is absent from, not ones it is on', () => {
    const observations = [
      obs({ entityId: 'self', citedDomains: ['self-present.com'] }),
      ...Array.from({ length: AUTHORITY_SATURATION }, (_, i) => obs({ entityId: `c${i}`, citedDomains: ['self-present.com', 'gap.com'] })),
    ];
    const opps = citationOpportunities(buildDomainIntel(observations, 'self'));
    const domains = opps.map((o) => o.domain);
    expect(domains).toContain('gap.com');
    expect(domains).not.toContain('self-present.com'); // self already present
  });

  it('ignores domains below the authority floor', () => {
    const observations = [obs({ entityId: 'c1', citedDomains: ['rare.com'] })]; // 1 entity -> authority 0.2
    expect(authorityScore(1)).toBeLessThan(OPPORTUNITY_MIN_AUTHORITY);
    expect(citationOpportunities(buildDomainIntel(observations, 'self'))).toHaveLength(0);
  });
});

describe('sentimentSummary', () => {
  it('flags a cluster when negatives clear both count and share thresholds', () => {
    const observations = [
      obs({ sentiment: 'negative' }),
      obs({ sentiment: 'negative' }),
      obs({ sentiment: 'positive' }),
    ];
    const s = sentimentSummary(observations, 'self');
    expect(s.negative).toBe(2);
    expect(s.isCluster).toBe(true);
  });
  it('does not flag a single negative', () => {
    expect(sentimentSummary([obs({ sentiment: 'negative' }), obs({ sentiment: 'positive' })], 'self').isCluster).toBe(false);
  });
});

describe('missingProfiles', () => {
  it('returns known profile domains absent from the entity mentions', () => {
    const missing = missingProfiles(['g2.com', 'capterra.com', 'justdial.com'], ['https://www.g2.com/products/acme']);
    expect(missing).toEqual(['capterra.com', 'justdial.com']);
  });
});

describe('runOffsiteAudit', () => {
  const observations = [
    obs({ entityId: 'self', citedDomains: ['ownblog.com'], sentiment: 'negative' }),
    obs({ entityId: 'self', citedDomains: ['ownblog.com'], sentiment: 'negative' }),
    ...Array.from({ length: AUTHORITY_SATURATION }, (_, i) => obs({ entityId: `c${i}`, citedDomains: ['g2.com'] })),
  ];

  it('emits opportunity + profile + negative-cluster findings, ranked, reproducibly', () => {
    const now = () => '2026-07-21T00:00:00.000Z';
    const input = { selfEntityId: 'self', observations, knownProfileDomains: ['g2.com', 'capterra.com'], selfMentionUrls: ['https://g2.com/self'] };
    const a = runOffsiteAudit(input, { now });
    const b = runOffsiteAudit(input, { now });
    expect(a.findings.map((f) => f.id)).toEqual(b.findings.map((f) => f.id));

    const types = a.findings.map((f) => f.issueType);
    expect(types).toContain('absent-from-citation-domain'); // g2.com, self absent
    expect(types).toContain('incomplete-third-party-profile'); // capterra.com missing
    expect(types).toContain('negative-mention-cluster');
    for (let i = 1; i < a.findings.length; i++) {
      expect(a.findings[i - 1].predictedImpact).toBeGreaterThanOrEqual(a.findings[i].predictedImpact);
    }
    for (const f of a.findings) {
      expect(f.source).toBe('content');
      expect(f.actionTemplates.length).toBeGreaterThan(0);
    }
  });
});
