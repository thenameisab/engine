import { describe, it, expect } from 'vitest';
import type { Action, Finding } from '@engine/core';
import type { ActionContext } from './context.js';
import { BuildEnv, buildAction, canTransition, transition } from './build.js';
import { buildJsonLd, generateSchemaAction } from './schema.js';
import { proposeTitle, proposeDescription, TITLE_MAX } from './meta.js';
import { unblockCrawlers } from './robots.js';
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

describe('generateActions dispatcher', () => {
  it('emits a schema action for a schema finding', () => {
    const f = finding({ actionTemplates: [{ type: 'schema', label: 'Generate JSON-LD', description: '' }] });
    const actions = generateActions(f, ctx(), ENV);
    expect(actions.map((a) => a.type)).toEqual(['schema']);
  });

  it('emits only the missing meta field', () => {
    const f = finding({ actionTemplates: [{ type: 'meta', label: 'Regenerate title', description: '' }] });
    // title missing, description present → only a title action
    const actions = generateActions(f, ctx({ currentTitle: '', currentMetaDescription: 'present' }), ENV);
    expect(actions).toHaveLength(1);
    expect(actions[0].diff.after).toContain('Acme Widget');
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
