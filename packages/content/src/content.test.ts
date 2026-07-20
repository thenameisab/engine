import { describe, it, expect } from 'vitest';
import type { CrawledPage } from '@engine/diagnosis';
import { answerFirstScore, selfContainmentScore, eeatScore, entityCoverageScore, extractabilityScore } from './score.js';
import { detectContentIssues } from './rules.js';
import { runContentAudit } from './audit.js';

function page(overrides: Partial<CrawledPage> = {}): CrawledPage {
  return {
    url: 'https://acme.com/guide',
    entityId: 'ent_1',
    statusCode: 200,
    redirectChain: [],
    indexable: true,
    inSitemap: true,
    title: 'A guide',
    metaDescription: 'A guide description.',
    vitals: { lcpMs: 1200, inpMs: 90, cls: 0.02, field: true },
    structuredData: [],
    aiCrawlerAccess: { GPTBot: 'allowed', ClaudeBot: 'allowed', PerplexityBot: 'allowed', 'Google-Extended': 'allowed' },
    hreflang: [],
    expectsHreflang: false,
    pageValue: 0.8,
    ...overrides,
  };
}

const GOOD_LEAD =
  'Engine unifies SEO and GEO measurement into one Fix Queue that deploys, verifies, and rolls back changes automatically. ' +
  'It replaces manual audits with a system that finds problems and fixes them without a developer ticket, closing the loop between diagnosis and execution end to end.';

describe('answerFirstScore', () => {
  it('scores well for a reasonable-length lead with an H1 and no filler', () => {
    const p = page({ headings: [{ level: 1, text: 'What is Engine' }], bodyText: GOOD_LEAD });
    expect(answerFirstScore(p)).toBeGreaterThan(0.8);
  });

  it('scores zero with no headings at all', () => {
    const p = page({ headings: [], bodyText: GOOD_LEAD });
    expect(answerFirstScore(p)).toBe(0);
  });

  it('penalizes filler openers', () => {
    const filler = 'Welcome to our guide! ' + GOOD_LEAD;
    const p = page({ headings: [{ level: 1, text: 'What is Engine' }], bodyText: filler });
    expect(answerFirstScore(p)).toBeLessThan(answerFirstScore(page({ headings: [{ level: 1, text: 'x' }], bodyText: GOOD_LEAD })));
  });
});

describe('selfContainmentScore', () => {
  it('scores well when paragraphs stand alone', () => {
    const body = [
      'Engine deploys fixes automatically through a verified Fix Queue.',
      'Every deployed action carries an immutable audit log entry.',
    ].join('\n\n');
    const p = page({ bodyText: body });
    expect(selfContainmentScore(p)).toBe(1);
  });

  it('penalizes paragraphs that open with a dangling reference pronoun', () => {
    const body = [
      'Engine deploys fixes automatically through a verified Fix Queue system built for scale.',
      'This makes it easier for teams to trust the automation without a human bottleneck.',
    ].join('\n\n');
    const p = page({ bodyText: body });
    expect(selfContainmentScore(p)).toBe(0.5);
  });

  it('returns 0 with no body text', () => {
    expect(selfContainmentScore(page({ bodyText: undefined }))).toBe(0);
  });
});

describe('eeatScore', () => {
  it('detects a byline and a date signal', () => {
    const p = page({ bodyText: 'By Jane Doe. Published on July 1, 2026. ' + GOOD_LEAD });
    expect(eeatScore(p)).toBeCloseTo(2 / 3, 5);
  });

  it('detects authorship-carrying structured data', () => {
    const p = page({
      bodyText: GOOD_LEAD,
      structuredData: [{ type: 'Article', valid: true, errors: [] }],
    });
    expect(eeatScore(p)).toBeCloseTo(1 / 3, 5);
  });

  it('scores 0 with no signals at all', () => {
    expect(eeatScore(page({ bodyText: GOOD_LEAD }))).toBe(0);
  });
});

describe('extractabilityScore', () => {
  it('returns null for a page with no captured content', () => {
    expect(extractabilityScore(page({ bodyText: undefined }))).toBeNull();
  });

  it('combines all three dimensions into one 0-100 score, entity coverage disclosed as not-measured when no entity is supplied', () => {
    const p = page({ headings: [{ level: 1, text: 'What is Engine' }], bodyText: 'By Jane Doe. Published. ' + GOOD_LEAD });
    const result = extractabilityScore(p)!;
    expect(result.score).toBeGreaterThan(0);
    expect(result.entityCoverage).toBe('not-measured');
    expect(Object.keys(result.breakdown).sort()).toEqual(['answerFirst', 'eeat', 'selfContainment']);
  });

  it('folds in a real entityCoverage number when entity facts are supplied', () => {
    const p = page({ headings: [{ level: 1, text: 'What is Engine' }], bodyText: 'By Jane Doe. Published. ' + GOOD_LEAD });
    const result = extractabilityScore(p, { canonicalName: 'Engine', keywords: ['Fix Queue'] })!;
    expect(result.entityCoverage).toBe(1);
  });
});

describe('entityCoverageScore', () => {
  it('scores the fraction of the entity\'s name + keywords found on the page', () => {
    const p = page({ title: 'About Engine', bodyText: 'Engine ships a real Fix Queue for every customer.' });
    expect(
      entityCoverageScore(p, { canonicalName: 'Engine', keywords: ['Fix Queue', 'Unified Visibility Score'] }),
    ).toBeCloseTo(2 / 3, 5);
  });

  it('matches case-insensitively', () => {
    const p = page({ bodyText: 'this page never says the brand name explicitly' });
    expect(entityCoverageScore(p, { canonicalName: 'ACME', keywords: [] })).toBe(0);
    const p2 = page({ bodyText: 'Acme is a great company.' });
    expect(entityCoverageScore(p2, { canonicalName: 'ACME', keywords: [] })).toBe(1);
  });

  it('returns null when the entity has no name or keywords to check against', () => {
    expect(entityCoverageScore(page({ bodyText: 'x' }), { canonicalName: '', keywords: [] })).toBeNull();
  });
});

describe('detectContentIssues', () => {
  it('fires no issues for a page that scores well on every dimension', () => {
    const p = page({
      headings: [{ level: 1, text: 'What is Engine' }],
      bodyText: 'By Jane Doe. Published on July 1, 2026. ' + GOOD_LEAD,
    });
    const { issues } = detectContentIssues(p);
    expect(issues).toEqual([]);
  });

  it('fires weak-eeat for a page with no authorship/date/schema signals', () => {
    const p = page({ headings: [{ level: 1, text: 'What is Engine' }], bodyText: GOOD_LEAD });
    const { issues } = detectContentIssues(p);
    expect(issues.map((i) => i.type)).toContain('weak-eeat');
  });

  it('fires nothing and reports no score for a page with no captured content', () => {
    const { issues, score } = detectContentIssues(page({ bodyText: undefined }));
    expect(issues).toEqual([]);
    expect(score).toBeNull();
  });

  it('fires weak-entity-coverage when entity facts are supplied and the page never mentions them', () => {
    const p = page({
      headings: [{ level: 1, text: 'What is Engine' }],
      bodyText: 'By Jane Doe. Published on July 1, 2026. ' + GOOD_LEAD,
    });
    const { issues } = detectContentIssues(p, { canonicalName: 'Widgetco', keywords: ['unrelated widget term'] });
    expect(issues.map((i) => i.type)).toContain('weak-entity-coverage');
  });

  it('does not fire weak-entity-coverage when no entity facts are supplied at all', () => {
    const p = page({
      headings: [{ level: 1, text: 'What is Engine' }],
      bodyText: 'By Jane Doe. Published on July 1, 2026. ' + GOOD_LEAD,
    });
    const { issues } = detectContentIssues(p);
    expect(issues.map((i) => i.type)).not.toContain('weak-entity-coverage');
  });
});

describe('runContentAudit', () => {
  const ENV = { now: () => '2026-07-20T00:00:00.000Z', makeId: () => 'fnd_c_fixed' };

  it('emits findings with source "content" and a "content" action template', () => {
    const pages = [page({ headings: [{ level: 1, text: 'What is Engine' }], bodyText: GOOD_LEAD })];
    const result = runContentAudit(pages, ENV);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings[0].source).toBe('content');
    expect(result.findings[0].actionTemplates[0].type).toBe('content');
  });

  it('counts pages with no captured content separately, without scoring or findings for them', () => {
    const pages = [page({ bodyText: undefined }), page({ url: 'https://acme.com/other', bodyText: undefined })];
    const result = runContentAudit(pages, ENV);
    expect(result.findings).toEqual([]);
    expect(result.pageScores).toEqual([]);
    expect(result.pagesWithoutContent).toBe(2);
  });

  it('is deterministic and reproducible given injected clock/id', () => {
    const pages = [page({ headings: [{ level: 1, text: 'x' }], bodyText: GOOD_LEAD })];
    const a = runContentAudit(pages, ENV);
    const b = runContentAudit(pages, ENV);
    expect(a.findings).toEqual(b.findings);
  });

  it('looks up entity facts per page by entityId and scores coverage against them', () => {
    const pages = [
      page({
        entityId: 'ent_1',
        headings: [{ level: 1, text: 'What is Engine' }],
        bodyText: 'By Jane Doe. Published on July 1, 2026. ' + GOOD_LEAD,
      }),
    ];
    const entities = new Map([['ent_1', { canonicalName: 'Engine', keywords: ['Fix Queue'] }]]);
    const result = runContentAudit(pages, { ...ENV, entities });
    expect(result.pageScores[0].score.entityCoverage).toBe(1);
    expect(result.findings.map((f) => f.issueType)).not.toContain('weak-entity-coverage');
  });
});
