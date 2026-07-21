import { describe, it, expect } from 'vitest';
import type { ConfidenceBand, Finding } from '@engine/core';
import { parseIntent, resolveEntity, extractKeyword } from './intent.js';
import { buildAnswer, unknownAnswer } from './answer.js';
import { applyPhrasing, templatePhrasing, openAiPhrasing } from './phrasing.js';
import type { CopilotData } from './types.js';

const entities = [
  { id: 'e-acme', canonicalName: 'Acme Corp' },
  { id: 'e-globex', canonicalName: 'Globex' },
];

const band = (point: number): ConfidenceBand => ({ point, low: point - 5, high: point + 5 });

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: 'f1',
    entityId: 'e-acme',
    source: 'technical',
    issueType: 'meta-title-missing',
    severity: 8,
    predictedImpact: 0.7,
    evidence: { url: 'https://acme.com/x' },
    actionTemplates: [{ type: 'meta' }],
    createdAt: '2026-07-21T00:00:00.000Z',
    ...over,
  } as Finding;
}

function data(over: Partial<CopilotData> = {}): CopilotData {
  return {
    entityId: 'e-acme',
    canonicalName: 'Acme Corp',
    organic: { sov: 40, keywordsTracked: 12 },
    ai: { band: band(25), samplesObserved: 30 },
    topFindings: [finding()],
    ...over,
  };
}

describe('resolveEntity', () => {
  it('matches a full canonical name in the question', () => {
    expect(resolveEntity('how is Acme Corp doing?', entities)?.id).toBe('e-acme');
  });
  it('matches on a single shared token', () => {
    expect(resolveEntity('globex visibility', entities)?.id).toBe('e-globex');
  });
  it('returns undefined when nothing matches', () => {
    expect(resolveEntity('how is the weather', entities)).toBeUndefined();
  });
  it('prefers the longer, more specific name', () => {
    const es = [
      { id: 'short', canonicalName: 'Acme' },
      { id: 'long', canonicalName: 'Acme Corp' },
    ];
    expect(resolveEntity('tell me about Acme Corp', es)?.id).toBe('long');
  });
});

describe('extractKeyword', () => {
  it('prefers a quoted phrase', () => {
    expect(extractKeyword('where do I rank for "running shoes"?')).toBe('running shoes');
  });
  it('falls back to the tail after "for"', () => {
    expect(extractKeyword('rank for blue widgets')).toBe('blue widgets');
  });
});

describe('parseIntent', () => {
  it('classifies a fix request as top_findings', () => {
    expect(parseIntent('what should I fix for Acme Corp?', entities).type).toBe('top_findings');
  });
  it('classifies a keyword rank question', () => {
    const i = parseIntent('where does Globex rank for "cloud storage"?', entities);
    expect(i.type).toBe('keyword_rank');
    expect(i.keyword).toBe('cloud storage');
  });
  it('classifies a comparison', () => {
    expect(parseIntent('is Acme Corp stronger in google or ai?', entities).type).toBe('organic_vs_ai');
  });
  it('defaults to entity_visibility when an entity resolves with no sharper signal', () => {
    expect(parseIntent('how is Acme Corp doing', entities).type).toBe('entity_visibility');
  });
  it('is unknown when no entity resolves', () => {
    expect(parseIntent('what is the meaning of life', entities).type).toBe('unknown');
  });
});

describe('buildAnswer', () => {
  it('cites organic and AI for a visibility answer and carries a fix suggestion', () => {
    const a = buildAnswer(parseIntent('how is Acme Corp doing', entities), data(), 'p1');
    expect(a.answer).toContain('40%');
    expect(a.answer).toContain('25%');
    expect(a.citations.map((c) => c.source)).toContain('serp_positions');
    expect(a.citations.map((c) => c.source)).toContain('citation_events');
    expect(a.suggestedAction?.proposeHref).toBe('/projects/p1/findings/f1/propose');
    expect(a.suggestedAction?.actionType).toBe('meta');
  });

  it('every number in the prose is backed by a citation source', () => {
    const a = buildAnswer(parseIntent('how is Acme Corp doing', entities), data(), 'p1');
    expect(a.citations.length).toBeGreaterThan(0);
  });

  it('omits the suggestion when no top finding is executable', () => {
    const nonExec = finding({ actionTemplates: [{ type: 'gbp' }] as Finding['actionTemplates'] });
    const a = buildAnswer(parseIntent('what should I fix for Acme Corp', entities), data({ topFindings: [nonExec] }), 'p1');
    expect(a.suggestedAction).toBeUndefined();
  });

  it('compares organic vs ai and points to the stronger channel', () => {
    const a = buildAnswer(parseIntent('is Acme Corp better in google or ai', entities), data(), 'p1');
    expect(a.answer.toLowerCase()).toContain('organic');
  });

  it('answers a keyword rank with the resolved position', () => {
    const i = parseIntent('where does Acme Corp rank for "widgets"', entities);
    const a = buildAnswer(i, data({ keywordRank: { keyword: 'widgets', position: 3 } }), 'p1');
    expect(a.answer).toContain('position 3');
  });

  it('handles a no-data entity without fabricating numbers', () => {
    const a = buildAnswer(
      parseIntent('how is Acme Corp doing', entities),
      data({ organic: { sov: 0, keywordsTracked: 0 }, ai: { band: band(0), samplesObserved: 0 }, topFindings: [] }),
      'p1',
    );
    expect(a.answer).toContain('no keywords tracked');
    expect(a.answer).toContain('not been measured');
  });
});

describe('unknownAnswer', () => {
  it('carries no citations and no fabricated data', () => {
    const a = unknownAnswer('what is the weather');
    expect(a.intent).toBe('unknown');
    expect(a.citations).toHaveLength(0);
  });
});

describe('phrasing', () => {
  it('templatePhrasing returns the deterministic prose unchanged', async () => {
    const a = buildAnswer(parseIntent('how is Acme Corp doing', entities), data(), 'p1');
    const out = await applyPhrasing(a, templatePhrasing);
    expect(out.answer).toBe(a.answer);
    expect(out.citations).toEqual(a.citations);
  });

  it('openAiPhrasing falls back to deterministic text on a non-2xx response', async () => {
    const a = buildAnswer(parseIntent('how is Acme Corp doing', entities), data(), 'p1');
    const fetchImpl = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const model = openAiPhrasing({ apiKey: 'k', fetchImpl });
    const out = await applyPhrasing(a, model);
    expect(out.answer).toBe(a.answer);
  });

  it('openAiPhrasing uses the reworded text when the call succeeds', async () => {
    const a = buildAnswer(parseIntent('how is Acme Corp doing', entities), data(), 'p1');
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'Reworded.' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const model = openAiPhrasing({ apiKey: 'k', fetchImpl });
    const out = await applyPhrasing(a, model);
    expect(out.answer).toBe('Reworded.');
    // Facts are still carried through untouched.
    expect(out.citations).toEqual(a.citations);
  });
});
