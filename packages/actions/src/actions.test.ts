import { describe, it, expect } from 'vitest';
import type { Action, Finding } from '@engine/core';
import type { ActionContext } from './context.js';
import { BuildEnv, buildAction, canTransition, transition } from './build.js';
import { buildJsonLd, generateSchemaAction } from './schema.js';
import { proposeTitle, proposeDescription, TITLE_MAX } from './meta.js';
import { unblockCrawlers } from './robots.js';
import { resolveRedirectPair, generateRedirectAction } from './redirect.js';
import { buildHreflangTags, generateHreflangAction } from './hreflang.js';
import { generateActions } from './generate.js';

const ENV: BuildEnv = { now: () => '2026-07-15T00:00:00.000Z', makeId: () => 'act_fixed' };

function ctx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    url: 'https://acme.com/widget',
    target: { kind: 'edge-worker', workerName: 'acme-edge' },
    entity: { schemaType: 'Product', name: 'Acme Widget', description: 'A great widget.' },
    leadHeading: 'The Acme Widget',
    ...overrides,
  };
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'fnd_1',
    entityId: 'ent_widget',
    source: 'technical',
    issueType: 'schema-missing',
    severity: 0.7,
    predictedImpact: 0.6,
    evidence: { url: 'https://acme.com/widget' },
    actionTemplates: [],
    createdAt: '2026-07-15T00:00:00.000Z',
    ...overrides,
  };
}

describe('buildJsonLd', () => {
  it('produces valid, parseable schema.org JSON-LD with entity properties', () => {
    const jsonld = buildJsonLd({ schemaType: 'Product', name: 'Acme Widget', properties: { sku: 'W-1' } });
    const parsed = JSON.parse(jsonld);
    expect(parsed['@context']).toBe('https://schema.org');
    expect(parsed['@type']).toBe('Product');
    expect(parsed.name).toBe('Acme Widget');
    expect(parsed.sku).toBe('W-1');
  });
});

describe('schema action', () => {
  it('generates a proposed json-ld diff', () => {
    const a = generateSchemaAction('fnd_1', ctx(), ENV)!;
    expect(a.type).toBe('schema');
    expect(a.status).toBe('proposed');
    expect(a.diff.format).toBe('json-ld');
    expect(JSON.parse(a.diff.after).name).toBe('Acme Widget');
  });

  it('returns null when no entity facts are available', () => {
    expect(generateSchemaAction('fnd_1', ctx({ entity: undefined }), ENV)).toBeNull();
  });
});

describe('meta proposals', () => {
  it('joins heading and entity name within the title budget', () => {
    const t = proposeTitle(ctx());
    expect(t).toBe('The Acme Widget — Acme Widget');
    expect(t.length).toBeLessThanOrEqual(TITLE_MAX);
  });

  it('truncates a long title with an ellipsis', () => {
    const t = proposeTitle(ctx({ leadHeading: 'x'.repeat(100), entity: undefined }));
    expect(t.length).toBeLessThanOrEqual(TITLE_MAX);
    expect(t.endsWith('…')).toBe(true);
  });

  it('derives a description from the entity description', () => {
    expect(proposeDescription(ctx())).toBe('A great widget.');
  });
});

describe('unblockCrawlers', () => {
  it('appends explicit allow blocks when the bot is unmentioned', () => {
    const out = unblockCrawlers('User-agent: *\nDisallow:\n', ['GPTBot']);
    expect(out).toMatch(/User-agent: GPTBot\nAllow: \//);
  });

  it('flips a Disallow: / under a blocked agent to Allow: /', () => {
    const out = unblockCrawlers('User-agent: GPTBot\nDisallow: /\n', ['GPTBot']);
    expect(out).toMatch(/User-agent: GPTBot\nAllow: \//);
    expect(out).not.toMatch(/Disallow: \/\s*$/);
  });

  it('leaves other agents untouched', () => {
    const out = unblockCrawlers('User-agent: BadBot\nDisallow: /\n', ['GPTBot']);
    expect(out).toMatch(/User-agent: BadBot\nDisallow: \//);
  });
});

describe('resolveRedirectPair', () => {
  it('collapses a redirect chain to a single hop from the original entry point to the final url', () => {
    const pair = resolveRedirectPair({
      issueType: 'redirect-chain',
      evidence: { url: 'https://acme.com/final', chain: ['https://acme.com/old', 'https://acme.com/mid'] },
    });
    expect(pair).toEqual({ from: 'https://acme.com/old', to: 'https://acme.com/final' });
  });

  it('consolidates a canonical conflict into the declared canonical', () => {
    const pair = resolveRedirectPair({
      issueType: 'canonical-conflict',
      evidence: { url: 'https://acme.com/dup', canonical: 'https://acme.com/original' },
    });
    expect(pair).toEqual({ from: 'https://acme.com/dup', to: 'https://acme.com/original' });
  });

  it('returns null for an unrelated issue type', () => {
    expect(resolveRedirectPair({ issueType: 'schema-missing', evidence: {} })).toBeNull();
  });

  it('returns null when the chain is empty or the pair is a no-op', () => {
    expect(resolveRedirectPair({ issueType: 'redirect-chain', evidence: { url: 'https://a.com', chain: [] } })).toBeNull();
    expect(
      resolveRedirectPair({ issueType: 'canonical-conflict', evidence: { url: 'https://a.com', canonical: 'https://a.com' } }),
    ).toBeNull();
  });
});

describe('generateRedirectAction', () => {
  it('generates a proposed redirect diff for a redirect-chain finding', () => {
    const f = finding({
      issueType: 'redirect-chain',
      evidence: { url: 'https://acme.com/final', chain: ['https://acme.com/old'] },
    });
    const a = generateRedirectAction(f, ctx(), ENV)!;
    expect(a.type).toBe('redirect');
    expect(a.status).toBe('proposed');
    expect(a.diff).toEqual({ before: 'https://acme.com/old', after: 'https://acme.com/final', format: 'text' });
  });

  it('returns null when the finding carries no resolvable redirect pair', () => {
    expect(generateRedirectAction(finding({ issueType: 'schema-missing' }), ctx(), ENV)).toBeNull();
  });
});

describe('buildHreflangTags', () => {
  it('emits one link tag per alternate', () => {
    const out = buildHreflangTags([
      { lang: 'en', href: 'https://acme.com/en/widget' },
      { lang: 'fr', href: 'https://acme.com/fr/widget' },
    ]);
    expect(out).toContain('<link rel="alternate" hreflang="en" href="https://acme.com/en/widget">');
    expect(out).toContain('<link rel="alternate" hreflang="fr" href="https://acme.com/fr/widget">');
  });

  it('escapes attribute-sensitive characters', () => {
    const out = buildHreflangTags([{ lang: 'en', href: 'https://acme.com/widget?a=1&b="x"' }]);
    expect(out).toContain('href="https://acme.com/widget?a=1&amp;b=&quot;x&quot;"');
  });
});

describe('generateHreflangAction', () => {
  it('generates a proposed meta/hreflang diff from the supplied alternates', () => {
    const a = generateHreflangAction(
      'fnd_1',
      ctx({ hreflangAlternates: [{ lang: 'en', href: 'https://acme.com/en/widget' }] }),
      ENV,
    )!;
    expect(a.type).toBe('meta');
    expect(a.diff.field).toBe('hreflang');
    expect(a.diff.after).toContain('hreflang="en"');
  });

  it('returns null when the caller supplied no alternates', () => {
    expect(generateHreflangAction('fnd_1', ctx({ hreflangAlternates: undefined }), ENV)).toBeNull();
    expect(generateHreflangAction('fnd_1', ctx({ hreflangAlternates: [] }), ENV)).toBeNull();
  });
});

describe('generateActions dispatcher', () => {
  it('emits a schema action for a schema finding', () => {
    const f = finding({ actionTemplates: [{ type: 'schema', label: 'Generate JSON-LD', description: '' }] });
    const actions = generateActions(f, ctx(), ENV);
    expect(actions.map((a) => a.type)).toEqual(['schema']);
  });

  it('routes a meta-title-missing finding to only a title action', () => {
    const f = finding({
      issueType: 'meta-title-missing',
      actionTemplates: [{ type: 'meta', label: 'Regenerate title', description: '' }],
    });
    const actions = generateActions(f, ctx({ currentTitle: '', currentMetaDescription: 'present' }), ENV);
    expect(actions).toHaveLength(1);
    expect(actions[0].diff.field).toBe('title');
    expect(actions[0].diff.after).toContain('Acme Widget');
  });

  it('routes a meta-description-missing finding to only a description action', () => {
    const f = finding({
      issueType: 'meta-description-missing',
      actionTemplates: [{ type: 'meta', label: 'Regenerate meta description', description: '' }],
    });
    const actions = generateActions(f, ctx({ currentTitle: 'present', currentMetaDescription: '' }), ENV);
    expect(actions).toHaveLength(1);
    expect(actions[0].diff.field).toBe('description');
  });

  it('does not duplicate title/description across two separate findings for the same page', () => {
    // The bug this guards: dispatching by ctx state alone (rather than by
    // finding.issueType) made each of these two findings independently
    // re-check *both* ctx fields, so processing both in one pass emitted the
    // title action twice and the description action twice.
    const titleFinding = finding({
      issueType: 'meta-title-missing',
      actionTemplates: [{ type: 'meta', label: 'Regenerate title', description: '' }],
    });
    const descriptionFinding = finding({
      issueType: 'meta-description-missing',
      actionTemplates: [{ type: 'meta', label: 'Regenerate meta description', description: '' }],
    });
    const pageCtx = ctx({ currentTitle: '', currentMetaDescription: '' });
    const actions = [...generateActions(titleFinding, pageCtx, ENV), ...generateActions(descriptionFinding, pageCtx, ENV)];
    expect(actions.map((a) => a.diff.field).sort()).toEqual(['description', 'title']);
  });

  it('emits nothing for an unrecognized meta issue type', () => {
    const f = finding({ actionTemplates: [{ type: 'meta', label: 'Regenerate title', description: '' }] });
    expect(generateActions(f, ctx({ currentTitle: '', currentMetaDescription: '' }), ENV)).toEqual([]);
  });

  it('dispatches a hreflang-missing finding to the hreflang generator, not title/description', () => {
    const f = finding({
      issueType: 'hreflang-missing',
      actionTemplates: [{ type: 'meta', label: 'Generate hreflang', description: '' }],
    });
    const actions = generateActions(
      f,
      ctx({ hreflangAlternates: [{ lang: 'en', href: 'https://acme.com/en/widget' }] }),
      ENV,
    );
    expect(actions).toHaveLength(1);
    expect(actions[0].diff.field).toBe('hreflang');
  });

  it('pulls blocked crawlers from finding evidence for a robots fix', () => {
    const f = finding({
      evidence: { url: 'https://acme.com/widget', blocked: ['GPTBot', 'ClaudeBot'] },
      actionTemplates: [{ type: 'robots', label: 'Allow AI crawlers', description: '' }],
    });
    const actions = generateActions(f, ctx({ currentRobotsTxt: 'User-agent: *\nDisallow: /\n' }), ENV);
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('robots');
    expect(actions[0].diff.after).toMatch(/GPTBot/);
    expect(actions[0].diff.after).toMatch(/ClaudeBot/);
  });

  it('emits a redirect action for a redirect-chain finding', () => {
    const f = finding({
      issueType: 'redirect-chain',
      evidence: { url: 'https://acme.com/final', chain: ['https://acme.com/old'] },
      actionTemplates: [{ type: 'redirect', label: 'Collapse redirect chain', description: '' }],
    });
    const actions = generateActions(f, ctx(), ENV);
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('redirect');
    expect(actions[0].diff.after).toBe('https://acme.com/final');
  });

  it('yields no actions for a finding with no templates (non-executable diagnosis)', () => {
    expect(generateActions(finding({ actionTemplates: [] }), ctx(), ENV)).toEqual([]);
  });
});

describe('Fix Queue lifecycle (build.ts)', () => {
  const base: Action = buildAction({
    findingId: 'fnd_1',
    type: 'schema',
    target: { kind: 'edge-worker', workerName: 'w' },
    diff: { before: '', after: '{}', format: 'json-ld' },
    env: ENV,
  });

  it('starts proposed with an opening audit entry', () => {
    expect(base.status).toBe('proposed');
    expect(base.auditLog).toHaveLength(1);
    expect(base.auditLog[0].event).toBe('proposed');
  });

  it('allows the legal proposed→approved→deployed→verified path', () => {
    const approved = transition(base, 'approved', ENV, 'alice');
    const deployed = transition(approved, 'deployed', ENV);
    const verified = transition(deployed, 'verified', ENV);
    expect(verified.status).toBe('verified');
    expect(verified.auditLog.map((e) => e.event)).toEqual(['proposed', 'approved', 'deployed', 'verified']);
    expect(verified.auditLog[1].actor).toBe('alice');
  });

  it('permits rollback from deployed and from verified', () => {
    expect(canTransition('deployed', 'rolled_back')).toBe(true);
    expect(canTransition('verified', 'rolled_back')).toBe(true);
  });

  it('rejects illegal transitions (skipping approval, verifying undeployed)', () => {
    expect(() => transition(base, 'deployed', ENV)).toThrow(/Illegal/);
    expect(() => transition(base, 'verified', ENV)).toThrow(/Illegal/);
    expect(canTransition('rolled_back', 'deployed')).toBe(false);
  });

  it('does not mutate the input action on transition', () => {
    transition(base, 'approved', ENV);
    expect(base.status).toBe('proposed');
    expect(base.auditLog).toHaveLength(1);
  });
});
