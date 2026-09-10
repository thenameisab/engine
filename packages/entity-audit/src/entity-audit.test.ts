import { describe, it, expect } from 'vitest';
import { runEntityAudit } from './audit.js';
import { inspectEntity } from './rules.js';
import { registrableDomain, corroborationScore, distinctSourceDomains } from './corroboration.js';
import { findEntityBlock, sameAsOf } from './schema.js';
import type { EntityGraphFacts } from './types.js';

function entity(over: Partial<EntityGraphFacts> = {}): EntityGraphFacts {
  return {
    id: 'e1',
    canonicalName: 'Acme Corp',
    wikidataId: 'Q42',
    urls: ['https://twitter.com/acme', 'https://linkedin.com/company/acme'],
    siteDomain: 'acme.com',
    mentions: ['https://techcrunch.com/acme', 'https://forbes.com/acme'],
    citations: ['https://wikipedia.org/Acme'],
    schema: [
      {
        '@context': 'https://schema.org',
        '@type': 'Organization',
        name: 'Acme Corp',
        sameAs: ['https://twitter.com/acme', 'https://linkedin.com/company/acme'],
      },
    ],
    ...over,
  };
}

describe('registrableDomain', () => {
  it('strips scheme, path, and www', () => {
    expect(registrableDomain('https://www.example.com/x?y=1')).toBe('example.com');
  });
  it('collapses subdomains to the last two labels', () => {
    expect(registrableDomain('blog.acme.co')).toBe('acme.co');
  });
  it('returns null for empty input', () => {
    expect(registrableDomain('  ')).toBeNull();
  });
  it('strips a port, which is not part of the domain', () => {
    // Left in, `acme.com:8443` and `acme.com` count as two distinct sources.
    expect(registrableDomain('https://acme.com:8443/x')).toBe('acme.com');
    expect(registrableDomain('acme.com:8443')).toBe('acme.com');
  });
});

describe('corroboration', () => {
  it('dedupes sources to distinct domains', () => {
    const set = distinctSourceDomains(['https://x.com/a', 'https://x.com/b'], ['https://y.com']);
    expect(set.size).toBe(2);
  });
  it('saturates at the target', () => {
    expect(corroborationScore(10)).toBe(1);
    expect(corroborationScore(0)).toBe(0);
  });
});

describe('schema inspection', () => {
  it('finds the entity block by name and org type', () => {
    const block = findEntityBlock(entity().schema, 'acme corp');
    expect(block).not.toBeNull();
    expect(sameAsOf(block!)).toHaveLength(2);
  });
  it('returns null when no block names the entity', () => {
    expect(findEntityBlock([{ '@type': 'WebPage', name: 'Home' }], 'Acme Corp')).toBeNull();
  });
});

describe('inspectEntity', () => {
  it('a fully-mapped entity has no issues and high strength', () => {
    const { issues, strength } = inspectEntity(entity());
    expect(issues).toHaveLength(0);
    expect(strength.score).toBeGreaterThan(0.8);
    expect(strength.components.wikidata).toBe(1);
    expect(strength.components.schema).toBe(1);
  });

  it('flags a missing Wikidata mapping', () => {
    const { issues } = inspectEntity(entity({ wikidataId: null }));
    expect(issues.map((i) => i.type)).toContain('missing-wikidata-mapping');
  });

  it('flags missing entity schema and does not double-count sameAs', () => {
    const { issues } = inspectEntity(entity({ schema: [] }));
    const types = issues.map((i) => i.type);
    expect(types).toContain('missing-entity-schema');
    expect(types).not.toContain('inconsistent-sameas');
  });

  it('flags inconsistent sameAs when a known profile is omitted on-site', () => {
    const e = entity({
      schema: [{ '@type': 'Organization', name: 'Acme Corp', sameAs: ['https://twitter.com/acme'] }],
    });
    const { issues } = inspectEntity(e);
    const same = issues.find((i) => i.type === 'inconsistent-sameas');
    expect(same).toBeDefined();
    expect((same!.evidence as { consistency: number }).consistency).toBeCloseTo(0.5);
  });

  it('flags weak corroboration when few distinct sources exist', () => {
    const { issues, strength } = inspectEntity(entity({ mentions: [], citations: [], urls: [] }));
    expect(issues.map((i) => i.type)).toContain('weak-corroboration');
    expect(strength.components.corroboration).toBeLessThan(0.5);
  });
});

describe('runEntityAudit', () => {
  it('emits source=entity findings sorted by impact, with strengths for every entity', () => {
    const result = runEntityAudit([entity({ wikidataId: null, schema: [] }), entity({ id: 'e2' })], {
      now: () => '2026-07-21T00:00:00.000Z',
    });
    expect(result.strengths).toHaveLength(2);
    expect(result.findings.every((f) => f.source === 'entity')).toBe(true);
    // Sorted by predictedImpact descending.
    for (let i = 1; i < result.findings.length; i++) {
      expect(result.findings[i - 1].predictedImpact).toBeGreaterThanOrEqual(result.findings[i].predictedImpact);
    }
    // Findings carry executable schema/content templates.
    const missingSchema = result.findings.find((f) => f.issueType === 'missing-entity-schema');
    expect(missingSchema?.actionTemplates[0].type).toBe('schema');
  });

  it('is deterministic: same input -> same finding ids', () => {
    const a = runEntityAudit([entity({ wikidataId: null })]);
    const b = runEntityAudit([entity({ wikidataId: null })]);
    expect(a.findings.map((f) => f.id)).toEqual(b.findings.map((f) => f.id));
  });
});

describe('sameAs consistency and the entity\'s own site', () => {
  const withSiteUrl = { urls: ['https://acme.com', 'https://twitter.com/acme', 'https://linkedin.com/company/acme'] };

  it('does not demand that a site list itself in its own sameAs', () => {
    // The crawler now records the origin that served the entity's pages onto
    // `entities.urls`. `sameAs` is for the entity's *other* homes — schema.org
    // states the site itself with `url` — so counting the site as a missing
    // profile would flag every correctly marked-up page.
    const { issues, strength } = inspectEntity(entity({ ...withSiteUrl, siteDomain: 'acme.com' }));
    expect(strength.components.sameAsConsistency).toBe(1);
    expect(issues.map((i) => i.type)).not.toContain('inconsistent-sameas');
  });

  it('still reports a genuinely omitted profile', () => {
    const { issues, strength } = inspectEntity(
      entity({
        urls: ['https://acme.com', 'https://twitter.com/acme', 'https://linkedin.com/company/acme'],
        siteDomain: 'acme.com',
        schema: [
          {
            '@context': 'https://schema.org',
            '@type': 'Organization',
            name: 'Acme Corp',
            sameAs: ['https://twitter.com/acme'],
          },
        ],
      }),
    );
    expect(strength.components.sameAsConsistency).toBe(0.5);
    const issue = issues.find((i) => i.type === 'inconsistent-sameas');
    expect(issue).toBeDefined();
    // The evidence names the profiles the reader is expected to add, and the
    // site is not one of them.
    expect(issue?.evidence.knownProfiles).toEqual(['twitter.com', 'linkedin.com']);
  });

  it('scores a full 1 only because there is nothing to compare, when urls is empty', () => {
    // The state every production row was in before the crawler wrote to it:
    // no known profiles, so no inconsistency is detectable. Recorded so the
    // free 1.0 is a documented consequence rather than a silent one.
    const { strength } = inspectEntity(entity({ urls: [], siteDomain: 'acme.com' }));
    expect(strength.components.sameAsConsistency).toBe(1);
  });
});
