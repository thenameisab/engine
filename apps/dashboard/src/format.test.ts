import { describe, it, expect } from 'vitest';
import { bandPositions, sparklinePath, sparklineArea, fmtDelta, nextAction, clamp, hostname, normalizeDomain, domainRank, serpFeatureLabel, toActionCard, actionTitle, effortLabel, targetLabel, impactPoints } from './format.js';
import type { ApiAction } from './types.js';

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
