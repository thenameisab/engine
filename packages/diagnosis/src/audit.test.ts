import { describe, it, expect } from 'vitest';
import type { CrawledPage } from './page.js';
import { runAudit } from './audit.js';
import { detectIssues, CWV_POOR } from './rules.js';
import {
  actionTemplatesFor,
  hasValidActionMapping,
  nonExecutableReasonFor,
  type IssueType,
} from './actions.js';

/** A fully healthy page; tests break exactly one thing at a time from here. */
function cleanPage(overrides: Partial<CrawledPage> = {}): CrawledPage {
  return {
    url: 'https://example.com/product/widget',
    entityId: 'ent_widget',
    statusCode: 200,
    redirectChain: [],
    canonical: 'https://example.com/product/widget',
    indexable: true,
    inSitemap: true,
    title: 'Widget — Example',
    metaDescription: 'The best widget you can buy.',
    vitals: { lcpMs: 1800, inpMs: 120, cls: 0.02, field: true },
    structuredData: [{ type: 'Product', valid: true, errors: [] }],
    aiCrawlerAccess: {
      GPTBot: 'allowed',
      ClaudeBot: 'allowed',
      PerplexityBot: 'allowed',
      'Google-Extended': 'allowed',
    },
    hreflang: [],
    expectsHreflang: false,
    pageValue: 0.8,
    ...overrides,
  };
}

const ALL_ISSUE_TYPES: IssueType[] = [
  'schema-missing',
  'schema-invalid',
  'meta-title-missing',
  'meta-description-missing',
  'ai-crawler-blocked',
  'redirect-chain',
  'canonical-conflict',
  'hreflang-missing',
  'cwv-poor',
  'noindex-unexpected',
  'not-in-sitemap',
];

describe('§7 action mapping contract', () => {
  it('every issue type has a valid action mapping (template or documented reason)', () => {
    for (const type of ALL_ISSUE_TYPES) {
      expect(hasValidActionMapping(type)).toBe(true);
    }
  });

  it('non-executable issue types carry a documented reason and no template', () => {
    for (const type of ALL_ISSUE_TYPES) {
      if (actionTemplatesFor(type).length === 0) {
        expect(nonExecutableReasonFor(type)).toBeTruthy();
      }
    }
  });
});

describe('detectors', () => {
  it('a clean page produces no issues', () => {
    expect(detectIssues(cleanPage())).toEqual([]);
  });

  it('flags missing schema', () => {
    const issues = detectIssues(cleanPage({ structuredData: [] }));
    expect(issues.map((i) => i.type)).toContain('schema-missing');
  });

  it('flags invalid schema with the validator errors as evidence', () => {
    const issues = detectIssues(
      cleanPage({ structuredData: [{ type: 'Product', valid: false, errors: ['missing price'] }] }),
    );
    const invalid = issues.find((i) => i.type === 'schema-invalid');
    expect(invalid).toBeDefined();
    expect(JSON.stringify(invalid!.evidence)).toContain('missing price');
  });

  it('flags missing title and meta description independently', () => {
    expect(detectIssues(cleanPage({ title: '   ' })).map((i) => i.type)).toContain('meta-title-missing');
    expect(detectIssues(cleanPage({ metaDescription: '' })).map((i) => i.type)).toContain(
      'meta-description-missing',
    );
  });

  it('flags a blocked AI crawler and names which one', () => {
    const issues = detectIssues(
      cleanPage({
        aiCrawlerAccess: {
          GPTBot: 'blocked',
          ClaudeBot: 'allowed',
          PerplexityBot: 'allowed',
          'Google-Extended': 'allowed',
        },
      }),
    );
    const issue = issues.find((i) => i.type === 'ai-crawler-blocked');
    expect(issue).toBeDefined();
    expect((issue!.evidence as { blocked: string[] }).blocked).toEqual(['GPTBot']);
  });

  it('flags a redirect chain of more than one hop but not a single hop', () => {
    expect(detectIssues(cleanPage({ redirectChain: ['a', 'b'] })).map((i) => i.type)).toContain(
      'redirect-chain',
    );
    expect(detectIssues(cleanPage({ redirectChain: ['a'] })).map((i) => i.type)).not.toContain(
      'redirect-chain',
    );
  });

  it('flags a canonical pointing away from an indexable page', () => {
    const issues = detectIssues(cleanPage({ canonical: 'https://example.com/other' }));
    expect(issues.map((i) => i.type)).toContain('canonical-conflict');
  });

  it('does not flag a self-canonical or absent canonical', () => {
    expect(detectIssues(cleanPage({ canonical: undefined })).map((i) => i.type)).not.toContain(
      'canonical-conflict',
    );
  });

  it('flags a missing hreflang only when the page expects one', () => {
    expect(detectIssues(cleanPage({ expectsHreflang: true, hreflang: [] })).map((i) => i.type)).toContain(
      'hreflang-missing',
    );
    expect(detectIssues(cleanPage({ expectsHreflang: false, hreflang: [] })).map((i) => i.type)).not.toContain(
      'hreflang-missing',
    );
  });

  it('flags poor Core Web Vitals at the threshold', () => {
    const issues = detectIssues(cleanPage({ vitals: { lcpMs: CWV_POOR.lcpMs, inpMs: 120, cls: 0.02, field: true } }));
    const cwv = issues.find((i) => i.type === 'cwv-poor');
    expect(cwv).toBeDefined();
    expect((cwv!.evidence as { poor: string[] }).poor).toEqual(['LCP']);
  });

  it('flags an indexable page missing from the sitemap', () => {
    expect(detectIssues(cleanPage({ inSitemap: false })).map((i) => i.type)).toContain('not-in-sitemap');
  });

  it('flags an unexpected noindex on an indexable page', () => {
    const issues = detectIssues(cleanPage({ noindex: { source: 'meta' } }));
    expect(issues.map((i) => i.type)).toContain('noindex-unexpected');
  });
});

describe('runAudit', () => {
  it('emits scored findings, all carrying a valid action mapping', () => {
    const { findings } = runAudit([cleanPage({ structuredData: [], title: '' })]);
    expect(findings.length).toBe(2);
    for (const f of findings) {
      expect(f.source).toBe('technical');
      expect(f.severity).toBeGreaterThan(0);
      // Every finding either has a template or a documented reason in evidence.
      const documented =
        f.actionTemplates.length > 0 ||
        Boolean((f.evidence as { nonExecutableReason?: string }).nonExecutableReason);
      expect(documented).toBe(true);
    }
  });

  it('sorts findings by predicted impact, high first', () => {
    const { findings } = runAudit([
      cleanPage({ structuredData: [], metaDescription: '', pageValue: 0.9 }),
    ]);
    for (let i = 1; i < findings.length; i++) {
      expect(findings[i - 1].predictedImpact).toBeGreaterThanOrEqual(findings[i].predictedImpact);
    }
  });

  it('weights predicted impact by page value', () => {
    const high = runAudit([cleanPage({ structuredData: [], pageValue: 1 })]).findings[0];
    const low = runAudit([cleanPage({ structuredData: [], pageValue: 0.1 })]).findings[0];
    expect(high.predictedImpact).toBeGreaterThan(low.predictedImpact);
  });

  it('a clean crawl scores 100 with zero findings', () => {
    const result = runAudit([
      cleanPage(),
      cleanPage({ url: 'https://example.com/b', entityId: 'ent_b', canonical: 'https://example.com/b' }),
    ]);
    expect(result.findings).toEqual([]);
    expect(result.healthScore).toBe(100);
    expect(result.autoFixableCount).toBe(0);
    expect(result.pagesAudited).toBe(2);
  });

  it('a broken crawl scores below 100 and counts auto-fixable findings', () => {
    const result = runAudit([
      cleanPage({
        structuredData: [],
        title: '',
        aiCrawlerAccess: {
          GPTBot: 'blocked',
          ClaudeBot: 'blocked',
          PerplexityBot: 'allowed',
          'Google-Extended': 'allowed',
        },
      }),
    ]);
    expect(result.healthScore).toBeLessThan(100);
    // schema-missing, meta-title-missing, ai-crawler-blocked all carry templates.
    expect(result.autoFixableCount).toBe(3);
  });

  it('is reproducible with injected clock and ids', () => {
    const opts = { now: () => '2026-07-14T00:00:00.000Z', makeId: () => 'fixed' };
    const a = runAudit([cleanPage({ structuredData: [] })], opts);
    const b = runAudit([cleanPage({ structuredData: [] })], opts);
    expect(a).toEqual(b);
    expect(a.findings[0].createdAt).toBe('2026-07-14T00:00:00.000Z');
  });

  it('generates stable, distinct default ids per (page, issue-type)', () => {
    const { findings } = runAudit([cleanPage({ structuredData: [], title: '' })]);
    const ids = findings.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith('fnd_'))).toBe(true);
  });
});
