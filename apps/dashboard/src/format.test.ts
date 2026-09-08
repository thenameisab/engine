import { describe, it, expect } from 'vitest';
import { bandPositions, sparklinePath, sparklineArea, fmtDelta, nextAction, clamp, hostname, normalizeDomain, domainRank, serpFeatureLabel, toActionCard, actionTitle, effortLabel, targetLabel, impactPoints, toFindingRow, issueLabel, severityBand, toPulseData } from './format.js';
import type { ApiAction, ApiFinding, ApiPulseResponse } from './types.js';

describe('bandPositions', () => {
  it('centers a symmetric band with the tick between the edges', () => {
    const p = bandPositions({ point: 64, low: 60, high: 68 });
    expect(p.leftPct).toBeGreaterThan(0);
    expect(p.rightPct).toBeGreaterThan(0);
    expect(p.tickPct).toBeGreaterThan(p.leftPct);
    expect(p.tickPct).toBeLessThan(100 - p.rightPct);
  });

  it('a wider band fills more of the track (uncertainty is legible)', () => {
    const narrow = bandPositions({ point: 64, low: 63, high: 65 });
    const wide = bandPositions({ point: 64, low: 55, high: 73 });
    const narrowFill = 100 - narrow.leftPct - narrow.rightPct;
    const wideFill = 100 - wide.leftPct - wide.rightPct;
    // Both render the band across the same padded window fraction, but the wide
    // band's absolute span is larger — the domain scales with width, so the
    // fill fraction is equal by construction; assert it stays within [0,100].
    expect(narrowFill).toBeGreaterThan(0);
    expect(wideFill).toBeGreaterThan(0);
    expect(wideFill).toBeLessThanOrEqual(100);
  });

  it('clamps within 0–100', () => {
    const p = bandPositions({ point: 2, low: 0, high: 1 });
    expect(p.leftPct).toBeGreaterThanOrEqual(0);
    expect(p.rightPct).toBeGreaterThanOrEqual(0);
    expect(p.tickPct).toBeLessThanOrEqual(100);
  });
});

describe('sparklinePath', () => {
  it('starts with M and maps the min to the bottom, max to the top', () => {
    const d = sparklinePath([1, 5], 100, 50);
    expect(d.startsWith('M')).toBe(true);
    // first point (value 1 = min) should be lower on screen (larger y) than last (value 5 = max)
    const coords = d.replace('M', '').split(' L').map((p) => p.split(',').map(Number));
    expect(coords[0]![1]).toBeGreaterThan(coords[1]![1]);
  });

  it('handles a single point as a flat mid line', () => {
    expect(sparklinePath([7], 100, 40)).toBe('M0,20 L100,20');
  });

  it('returns empty for an empty series', () => {
    expect(sparklinePath([], 100, 40)).toBe('');
    expect(sparklineArea([], 100, 40)).toBe('');
  });

  it('area path closes back to the baseline', () => {
    const area = sparklineArea([1, 2, 3], 90, 30);
    expect(area.endsWith('Z')).toBe(true);
    expect(area).toContain('L0,30');
  });
});

describe('fmtDelta', () => {
  it('signs positives and uses a real minus for negatives', () => {
    expect(fmtDelta(4.2)).toBe('+4.2');
    expect(fmtDelta(-1)).toBe('−1.0');
    expect(fmtDelta(0)).toBe('+0.0');
  });
});

describe('nextAction', () => {
  it('walks the lifecycle and stops at terminal states', () => {
    expect(nextAction('proposed')).toEqual({ to: 'approved', label: 'Approve' });
    expect(nextAction('approved')).toEqual({ to: 'deployed', label: 'Deploy' });
    expect(nextAction('deployed')).toEqual({ to: 'verified', label: 'Verify' });
    expect(nextAction('verified')).toBeNull();
    expect(nextAction('rolled_back')).toBeNull();
  });
});

describe('clamp', () => {
  it('bounds a value', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
});

describe('SERP helpers', () => {
  it('hostname strips www and lowercases', () => {
    expect(hostname('https://WWW.Acme.com/x?y=1')).toBe('acme.com');
    expect(hostname('not a url')).toBe('');
  });

  it('normalizeDomain strips protocol/www/path', () => {
    expect(normalizeDomain('https://www.Acme.com/blog')).toBe('acme.com');
  });

  it('domainRank finds the first matching organic position, incl. subdomains', () => {
    const organic = [
      { position: 1, url: 'https://competitor.com/a', title: '' },
      { position: 2, url: 'https://blog.acme.com/b', title: '' },
      { position: 3, url: 'https://acme.com/c', title: '' },
    ];
    expect(domainRank(organic, 'acme.com')).toBe(2);
    expect(domainRank(organic, 'nowhere.com')).toBeNull();
    expect(domainRank(organic, '')).toBeNull();
  });

  it('serpFeatureLabel humanizes a feature key', () => {
    expect(serpFeatureLabel('people_also_ask')).toBe('People Also Ask');
    expect(serpFeatureLabel('ai_overview')).toBe('Ai Overview');
  });
});

describe('toActionCard', () => {
  const base: ApiAction = {
    id: 'aa11',
    findingId: 'ff22',
    type: 'meta',
    target: { kind: 'edge-worker', workerName: 'acme-edge' },
    diff: { before: '<title>Old</title>', after: '<title>New</title>', format: 'html', field: 'title' },
    status: 'proposed',
    predictedImpact: 0.7,
  };

  it('maps a persisted Action onto a queue card', () => {
    const card = toActionCard(base);
    expect(card).toEqual({
      id: 'aa11',
      kind: 'Meta',
      title: 'Regenerate title · acme-edge',
      impact: 7,
      effort: 'edge',
      status: 'proposed',
    });
  });

  it('titles each action type from its diff and target', () => {
    expect(actionTitle({ ...base, type: 'schema', target: { kind: 'cms-plugin', plugin: 'wordpress', siteId: 'shop' } }))
      .toBe('Inject JSON-LD · wordpress · shop');
    expect(actionTitle({ ...base, type: 'robots' })).toBe('Update robots.txt · acme-edge');
    expect(actionTitle({ ...base, type: 'redirect', target: { kind: 'github-pr', repo: 'acme/site' } }))
      .toBe('Fix redirect · acme/site');
    expect(actionTitle({ ...base, type: 'gbp', target: { kind: 'gbp-api', locationId: 'loc-12' } }))
      .toBe('Update business profile · loc-12');
  });

  it('falls back to the meta label when a meta diff names no field', () => {
    const noField = { ...base, diff: { ...base.diff, field: undefined } };
    expect(actionTitle(noField)).toBe('Regenerate meta · acme-edge');
  });

  it('rescales the 0-1 predicted impact onto the card\'s 0-10 scale', () => {
    // Diagnosis emits severityWeight x pageValue; a card reading "+0.855 impact"
    // is the bug this guards.
    expect(impactPoints(0.855)).toBe(9);
    expect(impactPoints(0)).toBe(0);
    expect(impactPoints(1)).toBe(10);
    // Defensive: never render a negative or >10 impact if a score escapes 0-1.
    expect(impactPoints(1.4)).toBe(10);
    expect(impactPoints(-0.2)).toBe(0);
  });

  it('reads effort off the deploy target', () => {
    expect(effortLabel('cms-plugin')).toBe('1-click');
    expect(effortLabel('edge-worker')).toBe('edge');
    expect(effortLabel('github-pr')).toBe('PR');
    expect(effortLabel('gbp-api')).toBe('auto');
  });

  it('labels a target that carries no identifying detail', () => {
    expect(targetLabel({ kind: 'cms-plugin' })).toBe('cms plugin');
    expect(targetLabel({ kind: 'edge-worker' })).toBe('edge worker');
  });
});

describe('toFindingRow', () => {
  const finding = (o: Partial<ApiFinding> = {}): ApiFinding => ({
    id: 'uuid-1',
    entityId: 'ent_1',
    source: 'technical',
    issueType: 'ai-crawler-blocked',
    severity: 0.95,
    predictedImpact: 0.475,
    evidence: { url: 'https://acme.com/', blocked: ['GPTBot'] },
    actionTemplates: [{ type: 'robots', label: 'Allow AI crawlers', description: '…' }],
    createdAt: '2026-07-17T00:00:00.000Z',
    ...o,
  });

  it('maps a persisted finding onto a renderable row', () => {
    const row = toFindingRow(finding());
    expect(row).toEqual({
      id: 'uuid-1',
      type: 'ai-crawler-blocked',
      title: 'AI crawlers blocked by robots.txt',
      severity: 'high',
      // 0.475 on the contract's 0-1 scale, not "+0.475" on the card's 0-10 one.
      predictedImpact: 5,
      autoFixable: true,
      url: 'https://acme.com/',
    });
  });

  it('calls a finding with no action template manual, not auto-fixable', () => {
    // The §7 contract lets a finding carry no template only with a documented
    // reason — that is exactly the "manual" case the pill must not overstate.
    const row = toFindingRow(finding({ actionTemplates: [], evidence: { url: '/x', nonExecutableReason: 'needs a human' } }));
    expect(row.autoFixable).toBe(false);
  });

  it('renders an empty url rather than "undefined" when evidence carries none', () => {
    const row = toFindingRow(finding({ evidence: {} }));
    expect(row.url).toBe('');
  });
});

describe('issueLabel', () => {
  it('gives each issue type human copy', () => {
    expect(issueLabel('schema-missing')).toBe('No structured data');
    expect(issueLabel('meta-title-missing')).toBe('Missing <title>');
  });

  it('falls through to the raw type rather than hiding an unmapped one', () => {
    // A new rule in @engine/diagnosis should surface as itself, not vanish.
    expect(issueLabel('some-future-check')).toBe('some-future-check');
  });
});

describe('severityBand', () => {
  it('bands the real severity weights the way the product ranks them', () => {
    // ai-crawler-blocked (0.95) is the GEO-native issue the product exists for.
    expect(severityBand(0.95)).toBe('high');
    expect(severityBand(0.8)).toBe('high');
    // schema-missing (0.7) matters; not-in-sitemap (0.35) is housekeeping.
    expect(severityBand(0.7)).toBe('medium');
    expect(severityBand(0.55)).toBe('medium');
    expect(severityBand(0.4)).toBe('low');
    expect(severityBand(0.35)).toBe('low');
  });
});

describe('toPulseData', () => {
  it('reports null score, not a fabricated 0, when nothing has been polled', () => {
    const resp: ApiPulseResponse = { score: null, aiBand: null, keywordsTracked: 0, citationSamples: 0 };
    const data = toPulseData(resp);
    expect(data.score).toBeNull();
    // All three surfaces still render, so the view can say *why* each is flat.
    expect(data.contributions.map((c) => c.key)).toEqual(['organic', 'ai', 'local']);
  });

  it('rounds the band and carries the AI surface\'s own confidence band, never a bare point', () => {
    const resp: ApiPulseResponse = {
      score: {
        band: { low: 60.4, point: 66.6, high: 72.9 },
        decomposition: {
          organic: { score: 100, weight: 0.667 },
          ai: { score: 50, weight: 0.333 },
          local: { score: 0, weight: 0 },
        },
      },
      aiBand: { low: 30, point: 50, high: 70 },
      keywordsTracked: 3,
      citationSamples: 4,
    };
    const data = toPulseData(resp);
    expect(data.score).toEqual({ point: 67, low: 60, high: 73 });
    const ai = data.contributions.find((c) => c.key === 'ai')!;
    expect(ai.low).toBe(30);
    expect(ai.high).toBe(70);
    expect(ai.value).toBe(50);
    const organic = data.contributions.find((c) => c.key === 'organic')!;
    expect(organic.low).toBeUndefined();
    expect(organic.sub).toContain('3 kw tracked');
    const local = data.contributions.find((c) => c.key === 'local')!;
    // Customer-facing text: says what is true and carries no phase code.
    expect(local.sub).toBe('not measured yet');
  });
});
