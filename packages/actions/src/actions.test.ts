import { describe, it, expect } from 'vitest';
import type { Action, Finding } from '@engine/core';
import type { ActionContext } from './context.js';
import { BuildEnv, buildAction, canTransition, isSkipped, requiresHumanReview, reviewMarked, transition } from './build.js';
import { buildJsonLd, generateSchemaAction } from './schema.js';
import { proposeTitle, proposeDescription, TITLE_MAX, DESC_MAX, isProposal } from './meta.js';
import { unblockCrawlers } from './robots.js';
import { resolveRedirectPair, generateRedirectAction } from './redirect.js';
import { buildHreflangTags, generateHreflangAction } from './hreflang.js';
import { generateInternalLinkAction } from './internalLink.js';
import { generateActions } from './generate.js';

const ENV: BuildEnv = { now: () => '2026-07-15T00:00:00.000Z', makeId: () => 'act_fixed' };

function ctx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    url: 'https://acme.com/widget',
    target: { kind: 'edge-worker', workerName: 'acme-edge' },
    entity: { schemaType: 'Product', name: 'Acme Widget', description: 'A great widget for people who like widgets.' },
    leadHeading: 'The Acme Widget',
    currentBodyText: 'The Acme Widget grinds coffee in under ten seconds. It fits a standard kitchen counter and comes with a two-year warranty.',
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
    const a = generateSchemaAction('fnd_1', ctx(), ENV);
    if (isSkipped(a)) throw new Error(a.reason);
    expect(a.type).toBe('schema');
    expect(a.status).toBe('proposed');
    expect(a.diff.format).toBe('json-ld');
    expect(JSON.parse(a.diff.after).name).toBe('Acme Widget');
  });

  it('explains itself instead of guessing when no entity facts are available', () => {
    const r = generateSchemaAction('fnd_1', ctx({ entity: undefined }), ENV);
    expect(isSkipped(r)).toBe(true);
    expect(isSkipped(r) && r.reason).toMatch(/which brand/i);
  });

  it('refuses to emit @type Thing, which describes nothing', () => {
    const r = generateSchemaAction('fnd_1', ctx({ entity: { schemaType: 'Thing', name: 'Acme Dental' } }), ENV);
    expect(isSkipped(r)).toBe(true);
    expect(isSkipped(r) && r.reason).toMatch(/what kind of business/i);
  });
});

function text(p: ReturnType<typeof proposeTitle>): string {
  if (!isProposal(p)) throw new Error(p.reason);
  return p.text;
}

describe('meta proposals', () => {
  it('leads with the page heading and adds the brand as a suffix', () => {
    const t = text(proposeTitle(ctx({ leadHeading: 'Coffee grinders' })));
    expect(t).toBe('Coffee grinders — Acme Widget');
    expect(t.length).toBeLessThanOrEqual(TITLE_MAX);
  });

  it('does not repeat the brand when the heading already contains it', () => {
    expect(text(proposeTitle(ctx()))).toBe('The Acme Widget');
  });

  it('reads the heading off the crawled headings when no lead heading is given', () => {
    const t = text(proposeTitle(ctx({ leadHeading: undefined, headings: [{ level: 2, text: 'Delivery' }, { level: 1, text: 'Coffee grinders' }] })));
    expect(t).toBe('Coffee grinders — Acme Widget');
  });

  it('truncates a long title with an ellipsis and keeps the page subject', () => {
    const t = text(proposeTitle(ctx({ leadHeading: 'x'.repeat(100), entity: undefined })));
    expect(t.length).toBeLessThanOrEqual(TITLE_MAX);
    expect(t.endsWith('…')).toBe(true);
  });

  it('uses the opening sentence when the heading is just the brand name', () => {
    const t = text(proposeTitle(ctx({ leadHeading: 'Acme Widget' })));
    expect(t).toMatch(/grinds coffee/);
    expect(t).not.toBe('Acme Widget');
  });

  it('refuses rather than proposing the brand name as the title of a page it knows nothing about', () => {
    const p = proposeTitle(ctx({ leadHeading: undefined, headings: [], currentBodyText: undefined }));
    expect(isProposal(p)).toBe(false);
    expect(!isProposal(p) && p.reason).toMatch(/no heading or visible text/i);
  });

  it('describes the page from its own opening sentences', () => {
    const d = text(proposeDescription(ctx()));
    expect(d).toMatch(/grinds coffee in under ten seconds/);
    expect(d.length).toBeLessThanOrEqual(DESC_MAX);
  });

  it('falls back to the entity description, never to the entity name alone', () => {
    const d = text(proposeDescription(ctx({ currentBodyText: undefined })));
    expect(d).toBe('A great widget for people who like widgets.');
  });

  it('refuses when the page has too little text to describe', () => {
    const p = proposeDescription(ctx({ currentBodyText: 'Hello.', entity: { schemaType: 'Product', name: 'Acme Widget' } }));
    expect(isProposal(p)).toBe(false);
    expect(!isProposal(p) && p.reason).toMatch(/too little text/i);
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

describe('generateInternalLinkAction', () => {
  const links = [
    { anchor: 'widget guide', href: 'https://acme.com/guide' },
    { anchor: 'pricing', href: 'https://acme.com/pricing' },
  ];

  it('wraps the first occurrence of each suggested anchor in a link', () => {
    const body = '<p>Read our widget guide before you compare pricing today.</p>';
    const a = generateInternalLinkAction({ id: 'fnd_1' }, ctx({ currentBodyHtml: body, internalLinkSuggestions: links }), ENV)!;
    expect(a.type).toBe('internal-link');
    expect(a.diff.format).toBe('html');
    expect(a.diff.after).toContain('<a href="https://acme.com/guide">widget guide</a>');
    expect(a.diff.after).toContain('<a href="https://acme.com/pricing">pricing</a>');
  });

  it('never links inside an existing anchor and never double-links', () => {
    const body = '<p>See <a href="/x">pricing</a> and more pricing details.</p>';
    const a = generateInternalLinkAction({ id: 'fnd_1' }, ctx({ currentBodyHtml: body, internalLinkSuggestions: [links[1]] }), ENV)!;
    // The already-linked "pricing" is untouched; the second, free occurrence gets linked.
    expect(a.diff.after).toBe('<p>See <a href="/x">pricing</a> and more <a href="https://acme.com/pricing">pricing</a> details.</p>');
  });

  it('falls back to currentBodyText when no bodyHtml is given', () => {
    const a = generateInternalLinkAction({ id: 'fnd_1' }, ctx({ currentBodyText: 'The pricing is fair.', internalLinkSuggestions: [links[1]] }), ENV)!;
    expect(a.diff.after).toContain('<a href="https://acme.com/pricing">pricing</a>');
  });

  it('returns null when there is nothing to link (no source, no suggestions, or no anchor found)', () => {
    expect(generateInternalLinkAction({ id: 'fnd_1' }, ctx({ internalLinkSuggestions: links }), ENV)).toBeNull();
    expect(generateInternalLinkAction({ id: 'fnd_1' }, ctx({ currentBodyHtml: '<p>hi</p>' }), ENV)).toBeNull();
    expect(
      generateInternalLinkAction({ id: 'fnd_1' }, ctx({ currentBodyHtml: '<p>nothing relevant</p>', internalLinkSuggestions: links }), ENV),
    ).toBeNull();
  });

  it('escapes href attribute values', () => {
    const body = '<p>compare pricing</p>';
    const a = generateInternalLinkAction(
      { id: 'fnd_1' },
      ctx({ currentBodyHtml: body, internalLinkSuggestions: [{ anchor: 'pricing', href: 'https://acme.com/p?a=1&b="2"' }] }),
      ENV,
    )!;
    expect(a.diff.after).toContain('href="https://acme.com/p?a=1&amp;b=&quot;2&quot;"');
  });
});

describe('generateActions dispatcher', () => {
  it('emits an internal-link action for a sparse-internal-linking finding', () => {
    const f = finding({
      issueType: 'sparse-internal-linking',
      actionTemplates: [{ type: 'internal-link', label: 'Add internal links', description: '' }],
    });
    const { actions } = generateActions(
      f,
      ctx({ currentBodyHtml: '<p>our pricing page</p>', internalLinkSuggestions: [{ anchor: 'pricing', href: 'https://acme.com/pricing' }] }),
      ENV,
    );
    expect(actions.map((a) => a.type)).toEqual(['internal-link']);
  });


  it('emits a schema action for a schema finding', () => {
    const f = finding({ actionTemplates: [{ type: 'schema', label: 'Generate JSON-LD', description: '' }] });
    const { actions } = generateActions(f, ctx(), ENV);
    expect(actions.map((a) => a.type)).toEqual(['schema']);
  });

  it('routes a meta-title-missing finding to only a title action', () => {
    const f = finding({
      issueType: 'meta-title-missing',
      actionTemplates: [{ type: 'meta', label: 'Regenerate title', description: '' }],
    });
    const { actions } = generateActions(f, ctx({ currentTitle: '', currentMetaDescription: 'present' }), ENV);
    expect(actions).toHaveLength(1);
    expect(actions[0].diff.field).toBe('title');
    expect(actions[0].diff.after).toContain('Acme Widget');
  });

  it('routes a meta-description-missing finding to only a description action', () => {
    const f = finding({
      issueType: 'meta-description-missing',
      actionTemplates: [{ type: 'meta', label: 'Regenerate meta description', description: '' }],
    });
    const { actions } = generateActions(f, ctx({ currentTitle: 'present', currentMetaDescription: '' }), ENV);
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
    const actions = [...generateActions(titleFinding, pageCtx, ENV).actions, ...generateActions(descriptionFinding, pageCtx, ENV).actions];
    expect(actions.map((a) => a.diff.field).sort()).toEqual(['description', 'title']);
  });

  it('emits nothing for an unrecognized meta issue type', () => {
    const f = finding({ actionTemplates: [{ type: 'meta', label: 'Regenerate title', description: '' }] });
    expect(generateActions(f, ctx({ currentTitle: '', currentMetaDescription: '' }), ENV).actions).toEqual([]);
  });

  it('dispatches a hreflang-missing finding to the hreflang generator, not title/description', () => {
    const f = finding({
      issueType: 'hreflang-missing',
      actionTemplates: [{ type: 'meta', label: 'Generate hreflang', description: '' }],
    });
    const { actions } = generateActions(
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
    const { actions } = generateActions(f, ctx({ currentRobotsTxt: 'User-agent: *\nDisallow: /\n' }), ENV);
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
    const { actions } = generateActions(f, ctx(), ENV);
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('redirect');
    expect(actions[0].diff.after).toBe('https://acme.com/final');
  });

  it('yields no actions for a finding with no templates (non-executable diagnosis)', () => {
    expect(generateActions(finding({ actionTemplates: [] }), ctx(), ENV)).toEqual({ actions: [], skipped: [] });
  });

  it('reports why a fix could not be built instead of returning silence', () => {
    const f = finding({
      issueType: 'meta-title-missing',
      actionTemplates: [{ type: 'meta', label: 'Regenerate title', description: '' }],
    });
    const { actions, skipped } = generateActions(
      f,
      ctx({ currentTitle: '', leadHeading: undefined, headings: [], currentBodyText: undefined }),
      ENV,
    );
    expect(actions).toEqual([]);
    expect(skipped).toEqual([{ type: 'meta', reason: expect.stringMatching(/no heading or visible text/i) }]);
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

describe('human review of content rewrites', () => {
  const rewrite: Action = buildAction({
    findingId: 'fnd_2',
    type: 'content',
    target: { kind: 'github-pr', repo: 'acme/site', branch: 'main', path: 'index.html' },
    diff: { before: 'Old copy.', after: 'New copy.', format: 'text' },
    env: ENV,
  });

  it('marks content as needing review and nothing else', () => {
    expect(requiresHumanReview('content')).toBe(true);
    expect(requiresHumanReview('schema')).toBe(false);
    expect(requiresHumanReview('meta')).toBe(false);
  });

  it('refuses to approve a rewrite nobody has read', () => {
    expect(() => transition(rewrite, 'approved', ENV, 'alice')).toThrow(/read and confirmed/i);
  });

  it('approves once a person has confirmed the wording', () => {
    const reviewed = reviewMarked(rewrite, ENV, 'alice@acme.com');
    expect(reviewed.reviewedBy).toBe('alice@acme.com');
    expect(reviewed.reviewedAt).toBe(ENV.now());
    expect(reviewed.auditLog.map((e) => e.event)).toEqual(['proposed', 'reviewed']);
    expect(transition(reviewed, 'approved', ENV, 'alice@acme.com').status).toBe('approved');
  });

  it('keeps the reviewer\'s edit as the text that deploys', () => {
    const reviewed = reviewMarked(rewrite, ENV, 'alice@acme.com', 'Copy the customer actually wants.');
    expect(reviewed.diff.after).toBe('Copy the customer actually wants.');
    expect(reviewed.auditLog[1].detail).toEqual({ edited: true });
  });

  it('does not mutate the reviewed action', () => {
    reviewMarked(rewrite, ENV, 'alice@acme.com', 'edited');
    expect(rewrite.diff.after).toBe('New copy.');
    expect(rewrite.reviewedAt).toBeUndefined();
  });

  it('only reviews a proposed fix', () => {
    const reviewed = transition(reviewMarked(rewrite, ENV, 'alice'), 'approved', ENV, 'alice');
    expect(() => reviewMarked(reviewed, ENV, 'alice')).toThrow(/proposed/i);
  });
});
