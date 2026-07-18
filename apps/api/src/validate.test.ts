import { describe, expect, it } from 'vitest';
import type { CrawledPage } from '@engine/diagnosis';
import type { ActionContext } from '@engine/actions';
import type { Finding } from '@engine/core';
import {
  checkAuditBody,
  checkCrawledPage,
  checkGenerateBody,
  checkCreateKeywordConfigBody,
  checkCreateCheckoutBody,
  checkUuidParam,
} from './validate.js';

/**
 * A `CrawledPage` exactly as `@engine/crawler`'s `crawlPage` emits one — the
 * real producer. Tests mutate a clone of it, so "valid" here means "what the
 * crawler actually sends", not a shape invented to satisfy the validator.
 */
const validPage: CrawledPage = {
  url: 'https://example.com/product',
  entityId: 'ent_1',
  statusCode: 200,
  redirectChain: [],
  canonical: 'https://example.com/product',
  indexable: true,
  inSitemap: true,
  title: 'A product',
  metaDescription: 'A description of the product.',
  vitals: { lcpMs: 1200, inpMs: 90, cls: 0.02, field: true },
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
};

const validFinding: Finding = {
  id: '11111111-1111-4111-8111-111111111111',
  entityId: 'ent_1',
  source: 'technical',
  issueType: 'meta-description-missing',
  severity: 0.4,
  predictedImpact: 0.32,
  evidence: { url: 'https://example.com/product' },
  actionTemplates: [{ type: 'meta', label: 'Add a meta description', description: '…' }],
  createdAt: '2026-07-17T00:00:00.000Z',
};

const validContext: ActionContext = {
  url: 'https://example.com/product',
  target: { kind: 'edge-worker', workerName: 'engine-edge' },
  currentTitle: 'A product',
  leadHeading: 'A product',
};

/** Clone the fixture and drop a key, the way a drifting caller would. */
function pageWithout(key: keyof CrawledPage): unknown {
  const page: Record<string, unknown> = structuredClone(validPage);
  delete page[key];
  return page;
}

describe('checkCrawledPage', () => {
  it('accepts the page the crawler actually produces', () => {
    expect(checkCrawledPage(validPage, 'pages[0]')).toBeNull();
  });

  it('accepts a page omitting every optional field', () => {
    const minimal: Record<string, unknown> = structuredClone(validPage);
    for (const key of ['canonical', 'noindex', 'pageValue']) delete minimal[key];
    expect(checkCrawledPage(minimal, 'pages[0]')).toBeNull();
  });

  /**
   * The reported bug: this exact body was a 500 from `checkMeta`'s
   * `page.metaDescription.trim()`. It must now name the field instead.
   */
  it('names metaDescription — the field behind the reported 500', () => {
    expect(checkCrawledPage(pageWithout('metaDescription'), 'pages[0]')).toEqual({
      field: 'pages[0].metaDescription',
      message: 'expected a string, got missing',
    });
  });

  it.each([
    ['url', 'pages[0].url'],
    ['entityId', 'pages[0].entityId'],
    ['statusCode', 'pages[0].statusCode'],
    ['redirectChain', 'pages[0].redirectChain'],
    ['indexable', 'pages[0].indexable'],
    ['inSitemap', 'pages[0].inSitemap'],
    ['title', 'pages[0].title'],
    ['vitals', 'pages[0].vitals'],
    ['structuredData', 'pages[0].structuredData'],
    ['aiCrawlerAccess', 'pages[0].aiCrawlerAccess'],
    ['hreflang', 'pages[0].hreflang'],
    ['expectsHreflang', 'pages[0].expectsHreflang'],
  ] as const)('rejects a page missing %s', (key, field) => {
    expect(checkCrawledPage(pageWithout(key), 'pages[0]')?.field).toBe(field);
  });

  it('reports the path into a nested field, not just the page', () => {
    const page = structuredClone(validPage);
    delete (page.vitals as Partial<CrawledPage['vitals']>).lcpMs;
    expect(checkCrawledPage(page, 'pages[0]')).toEqual({
      field: 'pages[0].vitals.lcpMs',
      message: 'expected a finite number, got missing',
    });
  });

  it('reports the index of the offending structured-data block', () => {
    const page = structuredClone(validPage);
    page.structuredData = [
      { type: 'Product', valid: true, errors: [] },
      { type: 'Offer', valid: false, errors: ['bad'] },
      { valid: true, errors: [] } as unknown as CrawledPage['structuredData'][number],
    ];
    expect(checkCrawledPage(page, 'pages[0]')?.field).toBe('pages[0].structuredData[2].type');
  });

  /**
   * A partial verdict map does not throw — it reads back `undefined`, compares
   * unequal to 'blocked', and the crawler is silently audited as allowed. The
   * validator is the only thing standing between that and a missed B1.6 finding.
   */
  it('rejects a partial aiCrawlerAccess map rather than silently auditing it as allowed', () => {
    const page = structuredClone(validPage);
    delete (page.aiCrawlerAccess as Partial<CrawledPage['aiCrawlerAccess']>).ClaudeBot;
    expect(checkCrawledPage(page, 'pages[0]')).toEqual({
      field: 'pages[0].aiCrawlerAccess.ClaudeBot',
      message: 'expected one of "allowed", "blocked", got missing',
    });
  });

  it('rejects an unknown crawler verdict', () => {
    const page = structuredClone(validPage);
    page.aiCrawlerAccess.GPTBot = 'maybe' as never;
    expect(checkCrawledPage(page, 'pages[0]')?.field).toBe('pages[0].aiCrawlerAccess.GPTBot');
  });

  it('rejects a present-but-wrongly-typed optional field', () => {
    const page = structuredClone(validPage);
    page.pageValue = 'high' as never;
    expect(checkCrawledPage(page, 'pages[0]')?.field).toBe('pages[0].pageValue');
  });

  it('rejects a noindex with an unknown source', () => {
    const page = structuredClone(validPage);
    page.noindex = { source: 'guesswork' as never };
    expect(checkCrawledPage(page, 'pages[0]')?.field).toBe('pages[0].noindex.source');
  });

  it.each([[null], [[]], ['a string'], [42]])('rejects a non-object page (%p)', (value) => {
    expect(checkCrawledPage(value, 'pages[0]')?.field).toBe('pages[0]');
  });
});

describe('checkAuditBody', () => {
  it('accepts a real crawl', () => {
    expect(checkAuditBody({ pages: [validPage, validPage] })).toBeNull();
  });

  it('tolerates an absent or empty pages array, which the route already allows', () => {
    expect(checkAuditBody({})).toBeNull();
    expect(checkAuditBody({ pages: [] })).toBeNull();
  });

  it('names the offending page by index', () => {
    expect(checkAuditBody({ pages: [validPage, pageWithout('title')] })).toEqual({
      field: 'pages[1].title',
      message: 'expected a string, got missing',
    });
  });

  it('rejects pages that is not an array', () => {
    expect(checkAuditBody({ pages: { '0': validPage } })?.field).toBe('pages');
  });

  it('rejects a non-object body', () => {
    expect(checkAuditBody([validPage])?.field).toBe('body');
    expect(checkAuditBody(null)?.field).toBe('body');
  });
});

describe('checkGenerateBody', () => {
  it('accepts a well-formed finding and context', () => {
    expect(checkGenerateBody({ finding: validFinding, context: validContext })).toBeNull();
  });

  /** The reported bug: `target: undefined` reached postgres.js as UNDEFINED_VALUE. */
  it('names context.target — the field behind the reported 500', () => {
    const context: Record<string, unknown> = structuredClone(validContext);
    delete context.target;
    expect(checkGenerateBody({ finding: validFinding, context })).toEqual({
      field: 'context.target',
      message: 'expected an object, got missing',
    });
  });

  it('rejects a DeployTarget with an unknown kind', () => {
    const context = { ...validContext, target: { kind: 'carrier-pigeon' } as never };
    expect(checkGenerateBody({ finding: validFinding, context })).toEqual({
      field: 'context.target.kind',
      message:
        'expected one of "cms-plugin", "edge-worker", "github-pr", "gbp-api", got a string',
    });
  });

  it.each([
    [{ kind: 'edge-worker' }, 'context.target.workerName'],
    [{ kind: 'cms-plugin', siteId: 's1' }, 'context.target.plugin'],
    [{ kind: 'cms-plugin', plugin: 'wordpress' }, 'context.target.siteId'],
    [{ kind: 'github-pr', repo: 'o/r' }, 'context.target.branch'],
    [{ kind: 'github-pr', repo: 'o/r', branch: 'main' }, 'context.target.path'],
    [{ kind: 'gbp-api' }, 'context.target.locationId'],
  ])('rejects a %p target missing its variant field', (target, field) => {
    const context = { ...validContext, target: target as never };
    expect(checkGenerateBody({ finding: validFinding, context })?.field).toBe(field);
  });

  it('accepts every well-formed DeployTarget variant', () => {
    const targets: ActionContext['target'][] = [
      { kind: 'edge-worker', workerName: 'w' },
      { kind: 'cms-plugin', plugin: 'wordpress', siteId: 's1' },
      { kind: 'cms-plugin', plugin: 'shopify', siteId: 's2' },
      { kind: 'github-pr', repo: 'o/r', branch: 'main', path: 'content/pricing.mdx' },
      { kind: 'gbp-api', locationId: 'loc_1' },
    ];
    for (const target of targets) {
      expect(checkGenerateBody({ finding: validFinding, context: { ...validContext, target } })).toBeNull();
    }
  });

  it('rejects a context missing url', () => {
    const context: Record<string, unknown> = structuredClone(validContext);
    delete context.url;
    expect(checkGenerateBody({ finding: validFinding, context })?.field).toBe('context.url');
  });

  /** `finding.id` becomes actions.finding_id — undefined is the same 500 as target. */
  it('rejects a finding missing id', () => {
    const finding: Record<string, unknown> = structuredClone(validFinding);
    delete finding.id;
    expect(checkGenerateBody({ finding, context: validContext })?.field).toBe('finding.id');
  });

  it('rejects a finding missing actionTemplates, which generateActions iterates', () => {
    const finding: Record<string, unknown> = structuredClone(validFinding);
    delete finding.actionTemplates;
    expect(checkGenerateBody({ finding, context: validContext })?.field).toBe('finding.actionTemplates');
  });

  it('rejects a finding missing evidence, which the robots generator reads', () => {
    const finding: Record<string, unknown> = structuredClone(validFinding);
    delete finding.evidence;
    expect(checkGenerateBody({ finding, context: validContext })?.field).toBe('finding.evidence');
  });

  it('names the offending action template by index', () => {
    const finding = structuredClone(validFinding);
    finding.actionTemplates = [
      { type: 'meta', label: 'l', description: 'd' },
      { type: 'telepathy' as never, label: 'l', description: 'd' },
    ];
    expect(checkGenerateBody({ finding, context: validContext })?.field).toBe('finding.actionTemplates[1].type');
  });

  /**
   * `severity`/`predictedImpact`/`source`/`createdAt` are Finding contract fields
   * this route never reads. Requiring them would reject bodies that work fine.
   */
  it('does not require Finding fields the route never reads', () => {
    const finding: Record<string, unknown> = structuredClone(validFinding);
    for (const key of ['severity', 'predictedImpact', 'source', 'createdAt', 'entityId']) delete finding[key];
    expect(checkGenerateBody({ finding, context: validContext })).toBeNull();
  });

  it('does not require the genuinely optional context fields', () => {
    expect(
      checkGenerateBody({
        finding: validFinding,
        context: { url: 'https://example.com', target: validContext.target },
      }),
    ).toBeNull();
  });

  it('rejects a present-but-malformed entity', () => {
    const context = { ...validContext, entity: { schemaType: 'Product' } as never };
    expect(checkGenerateBody({ finding: validFinding, context })?.field).toBe('context.entity.name');
  });

  it('rejects a missing finding or context outright', () => {
    expect(checkGenerateBody({ context: validContext })?.field).toBe('finding');
    expect(checkGenerateBody({ finding: validFinding })?.field).toBe('context');
  });
});

describe('checkCreateKeywordConfigBody', () => {
  const valid = {
    keyword: 'home loans',
    geoCountry: 'IN',
    device: 'desktop',
    language: 'en',
    engine: 'google',
  };

  it('accepts a well-formed body', () => {
    expect(checkCreateKeywordConfigBody(valid)).toBeNull();
  });

  it('accepts the optional fields when present', () => {
    expect(
      checkCreateKeywordConfigBody({ ...valid, geoCity: 'Mumbai', geoPostcode: '400001', cadence: 'daily' }),
    ).toBeNull();
  });

  /** device/engine/cadence are `check` constraints in migration 0001 — an
   * unvalidated bad value would 500 as a Postgres constraint violation. */
  it('rejects an out-of-range device, engine, or cadence, naming the field', () => {
    expect(checkCreateKeywordConfigBody({ ...valid, device: 'watch' })?.field).toBe('device');
    expect(checkCreateKeywordConfigBody({ ...valid, engine: 'duckduckgo' })?.field).toBe('engine');
    expect(checkCreateKeywordConfigBody({ ...valid, cadence: 'hourly' })?.field).toBe('cadence');
  });

  it('rejects a missing keyword or geoCountry', () => {
    const { keyword: _keyword, ...withoutKeyword } = valid;
    expect(checkCreateKeywordConfigBody(withoutKeyword)?.field).toBe('keyword');
    const { geoCountry: _geoCountry, ...withoutCountry } = valid;
    expect(checkCreateKeywordConfigBody(withoutCountry)?.field).toBe('geoCountry');
  });
});

describe('checkCreateCheckoutBody', () => {
  const valid = {
    tier: 'growth',
    successUrl: 'https://app.example.com/billing/success',
    cancelUrl: 'https://app.example.com/billing/cancel',
  };

  it('accepts a well-formed body', () => {
    expect(checkCreateCheckoutBody(valid)).toBeNull();
  });

  it('accepts an optional customerEmail', () => {
    expect(checkCreateCheckoutBody({ ...valid, customerEmail: 'buyer@example.com' })).toBeNull();
  });

  it('rejects an unrecognized tier', () => {
    expect(checkCreateCheckoutBody({ ...valid, tier: 'ultra' })?.field).toBe('tier');
  });

  it('rejects a non-URL successUrl/cancelUrl', () => {
    expect(checkCreateCheckoutBody({ ...valid, successUrl: 'not a url' })?.field).toBe('successUrl');
  });

  /** The WHATWG parser accepts any scheme as syntactically valid; restrict to http(s). */
  it('rejects a non-http(s) scheme, e.g. javascript:', () => {
    expect(checkCreateCheckoutBody({ ...valid, cancelUrl: 'javascript:alert(1)' })?.field).toBe('cancelUrl');
  });

  it('rejects a missing tier/successUrl/cancelUrl', () => {
    const { tier: _tier, ...withoutTier } = valid;
    expect(checkCreateCheckoutBody(withoutTier)?.field).toBe('tier');
    const { successUrl: _successUrl, ...withoutSuccess } = valid;
    expect(checkCreateCheckoutBody(withoutSuccess)?.field).toBe('successUrl');
  });
});

describe('checkUuidParam', () => {
  it('accepts a well-formed uuid', () => {
    expect(checkUuidParam('550e8400-e29b-41d4-a716-446655440000', 'accountId')).toBeNull();
  });

  it('rejects a non-uuid path param', () => {
    expect(checkUuidParam('not-a-uuid', 'accountId')?.field).toBe('accountId');
  });

  it('rejects an empty string', () => {
    expect(checkUuidParam('', 'accountId')?.field).toBe('accountId');
  });
});
