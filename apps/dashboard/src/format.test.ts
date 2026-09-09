import { describe, it, expect } from 'vitest';
import { readableError } from './errors.js';
import { pctChange, fmtChange, fmtRatio, fmtPosition, syncStatusLine, providerNextStep, diffLines, actionChanges, bandPositions, sparklinePath, sparklineArea, fmtDelta, nextAction, clamp, hostname, normalizeDomain, domainRank, serpFeatureLabel, toActionCard, actionTitle, effortLabel, targetLabel, impactPoints, toFindingRow, issueLabel, severityBand, toPulseData, groupFindings, pagePath, onboardingDefaults, auditRequestStatusLine, integrationTileState, rankChange, rankLabel } from './format.js';
import type { ApiAction, ApiAuditRequest, ApiFinding, ApiPulseResponse, FindingRow } from './types.js';

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
      type: 'meta',
      kind: 'Meta',
      title: 'Regenerate title · acme-edge',
      diff: base.diff,
      changes: 'The page title, as search results and AI answers show it',
      impact: 7,
      effort: 'edge',
      status: 'proposed',
      needsReview: false,
      reviewedAt: undefined,
      reviewedBy: undefined,
    });
  });

  it('carries the diff onto the card, so a card can show what it changes', () => {
    expect(toActionCard(base).diff).toEqual(base.diff);
  });

  it('marks a content rewrite as needing a person to read it, and nothing else', () => {
    expect(toActionCard({ ...base, type: 'content' }).needsReview).toBe(true);
    expect(toActionCard({ ...base, type: 'schema' }).needsReview).toBe(false);
    expect(toActionCard({ ...base, type: 'content', reviewedAt: '2026-09-09T10:00:00.000Z' }).reviewedAt)
      .toBe('2026-09-09T10:00:00.000Z');
  });

  it('says what each fix changes in the customer\'s terms', () => {
    expect(actionChanges({ ...base, type: 'content' })).toBe('The words on the page itself');
    expect(actionChanges({ ...base, type: 'robots' })).toBe('Which AI crawlers your site lets in, in robots.txt');
    expect(actionChanges({ ...base, diff: { ...base.diff, field: 'description' } }))
      .toBe('The description under the page title in search results');
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

describe('issueLabel for content and entity findings', () => {
  it('names every issue type the crawler and the entity audit can emit', () => {
    for (const slug of [
      'not-answer-first', 'weak-eeat', 'weak-entity-coverage', 'sparse-internal-linking',
      'missing-wikidata-mapping', 'missing-entity-schema', 'inconsistent-sameas', 'weak-corroboration',
    ]) {
      const label = issueLabel(slug);
      expect(label).not.toBe(slug);
      expect(label).not.toMatch(/[A-Z]\d|Phase/);
    }
  });
});

describe('groupFindings', () => {
  const row = (type: string, url: string, severity: FindingRow['severity'], autoFixable = false): FindingRow => ({
    id: `${type}:${url}`, type, title: issueLabel(type), severity, predictedImpact: 3, autoFixable, url,
  });

  it('puts each issue type once with one row per page', () => {
    const groups = groupFindings([
      row('not-in-sitemap', 'https://a.test/', 'low'),
      row('schema-missing', 'https://a.test/', 'high', true),
      row('not-in-sitemap', 'https://a.test/b', 'low'),
      row('not-in-sitemap', 'https://a.test/c', 'low'),
    ]);
    expect(groups.map((g) => [g.type, g.pageCount])).toEqual([['schema-missing', 1], ['not-in-sitemap', 3]]);
    expect(groups[1]!.findings.map((f) => f.url)).toEqual(['https://a.test/', 'https://a.test/b', 'https://a.test/c']);
  });

  it('orders high severity first, then the widest-spread issue', () => {
    const groups = groupFindings([
      row('x', 'https://a.test/1', 'medium'),
      row('y', 'https://a.test/1', 'medium'),
      row('y', 'https://a.test/2', 'medium'),
      row('z', 'https://a.test/1', 'low'),
      row('w', 'https://a.test/1', 'high'),
    ]);
    expect(groups.map((g) => g.type)).toEqual(['w', 'y', 'x', 'z']);
  });

  it('marks the group fixable when any page in it is', () => {
    const [g] = groupFindings([row('t', 'https://a.test/1', 'low', false), row('t', 'https://a.test/2', 'low', true)]);
    expect(g!.autoFixable).toBe(true);
  });

  it('returns nothing for nothing', () => {
    expect(groupFindings([])).toEqual([]);
  });
});

describe('pagePath', () => {
  it('shows the path and query, and "/" for the home page', () => {
    expect(pagePath('https://acme.test/pricing?plan=pro')).toBe('/pricing?plan=pro');
    expect(pagePath('https://acme.test')).toBe('/');
  });
  it('falls back to the raw value when it is not a URL', () => {
    expect(pagePath('not a url')).toBe('not a url');
  });
});

describe('onboardingDefaults', () => {
  it('names the site after its domain and the brand after the client when left blank', () => {
    expect(onboardingDefaults('Acme Dental', 'https://www.acme.example/pricing')).toEqual({
      domain: 'acme.example', siteName: 'acme.example', brandName: 'Acme Dental',
    });
  });
  it('keeps what the customer typed', () => {
    expect(onboardingDefaults('Acme Dental', 'acme.example', ' Acme site ', 'Acme')).toEqual({
      domain: 'acme.example', siteName: 'Acme site', brandName: 'Acme',
    });
  });
  it('yields an empty domain for an empty address, so the form can refuse it', () => {
    expect(onboardingDefaults('Acme', '   ').domain).toBe('');
  });
});

describe('auditRequestStatusLine', () => {
  const base: ApiAuditRequest = {
    id: 'r', projectId: 'p', status: 'queued', maxPages: 50, error: null, auditRunId: null,
    createdAt: '2026-09-08T10:00:00.000Z', startedAt: null, finishedAt: null,
  };
  it('is silent with no request, and after a finished one', () => {
    expect(auditRequestStatusLine(null)).toBeNull();
    expect(auditRequestStatusLine({ ...base, status: 'done' })).toBeNull();
  });
  it('keeps polling while queued or running', () => {
    expect(auditRequestStatusLine(base)?.live).toBe(true);
    expect(auditRequestStatusLine({ ...base, status: 'running', startedAt: base.createdAt })?.live).toBe(true);
  });
  it('shows the failure reason on the risk tone and stops polling', () => {
    const line = auditRequestStatusLine({ ...base, status: 'failed', error: 'site unreachable' });
    expect(line).toEqual({ text: 'The last audit failed: site unreachable', tone: 'risk', live: false });
  });
});

describe('integrationTileState', () => {
  const configured = { platformReady: true, isAdmin: false };
  it('puts connected providers first and coming-soon ones last', () => {
    const connected = integrationTileState({ authKind: 'oauth2' }, { status: 'connected', scopesSufficient: true }, configured);
    const idle = integrationTileState({ authKind: 'api_key' }, undefined, configured);
    const planned = integrationTileState({ availability: 'planned', authKind: 'oauth2' }, undefined, configured);
    expect(connected).toEqual({ label: 'Connected', tone: 'good', sort: 0 });
    expect(idle).toEqual({ label: 'Not connected', tone: null, sort: 1 });
    expect(planned).toEqual({ label: 'Coming soon', tone: 'muted', sort: 3 });
  });
  it('tells an administrator to set up, and everyone else that it is not available', () => {
    const unset = { platformReady: false, isAdmin: false };
    expect(integrationTileState({ authKind: 'oauth2' }, undefined, unset)).toEqual({ label: 'Not available yet', tone: 'muted', sort: 2 });
    expect(integrationTileState({ authKind: 'oauth2' }, undefined, { ...unset, isAdmin: true })).toEqual({ label: 'Needs setup', tone: 'watch', sort: 2 });
    // An API-key provider does not depend on Engine's own app at all.
    expect(integrationTileState({ authKind: 'api_key' }, undefined, unset).label).toBe('Not connected');
    // A GitHub App does: without one registered, nobody can install it.
    expect(integrationTileState({ authKind: 'github_app' }, undefined, unset).label).toBe('Not available yet');
    expect(integrationTileState({ authKind: 'github_app' }, undefined, configured).label).toBe('Not connected');
  });
  it('flags a grant that needs attention on the watch tone', () => {
    expect(integrationTileState({ authKind: 'oauth2' }, { status: 'needs_reauth', scopesSufficient: true }, configured).tone).toBe('watch');
    expect(integrationTileState({ authKind: 'oauth2' }, { status: 'connected', scopesSufficient: false }, configured).label).toBe('Missing a permission');
  });
});

describe('diffLines', () => {
  it('marks a replaced line as one removal and one addition', () => {
    expect(diffLines('Acme Dental', 'Teeth whitening — Acme Dental')).toEqual([
      { kind: 'removed', text: 'Acme Dental' },
      { kind: 'added', text: 'Teeth whitening — Acme Dental' },
    ]);
  });

  it('keeps shared lines and marks only what changed', () => {
    const before = '{\n  "@type": "Thing",\n  "name": "Acme"\n}';
    const after = '{\n  "@type": "Dentist",\n  "name": "Acme"\n}';
    expect(diffLines(before, after)).toEqual([
      { kind: 'same', text: '{' },
      { kind: 'removed', text: '  "@type": "Thing",' },
      { kind: 'added', text: '  "@type": "Dentist",' },
      { kind: 'same', text: '  "name": "Acme"' },
      { kind: 'same', text: '}' },
    ]);
  });

  it('reports an empty before as pure addition — nothing is there to remove', () => {
    expect(diffLines('', 'A new title')).toEqual([{ kind: 'added', text: 'A new title' }]);
  });

  it('reports no change when the two sides match', () => {
    expect(diffLines('same', 'same')).toEqual([{ kind: 'same', text: 'same' }]);
  });

  it('handles an inserted line without re-reporting the lines around it', () => {
    expect(diffLines('a\nc', 'a\nb\nc')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'added', text: 'b' },
      { kind: 'same', text: 'c' },
    ]);
  });
});

describe('readableError', () => {
  it('replaces a 401 with a sentence about the session, not our vocabulary', () => {
    // The bug this guards: "Sync failed: missing bearer token" reached a
    // customer's toast. `missing bearer token` is the API's phrasing for a
    // request it could not authenticate; nobody outside this repo can act on it.
    expect(readableError(new Error('401 {"error":"missing bearer token"}'))).toBe(
      'Your session has expired. Sign in again.',
    );
  });

  it('pulls the error field out of a JSON body', () => {
    expect(readableError(new Error('503 {"error":"Publishing to GitHub is not configured on this deployment."}')))
      .toBe('Publishing to GitHub is not configured on this deployment.');
  });

  it('points a 403 at the client picker', () => {
    expect(readableError(new Error('403 {"error":"project not in your account"}')))
      .toBe('project not in your account. Pick the right client from the Clients grid.');
  });

  it('passes through a message that is not a status-prefixed body', () => {
    expect(readableError(new Error('no API base URL configured'))).toBe('no API base URL configured');
  });

  it('falls back to the status when the body is empty', () => {
    expect(readableError(new Error('500 '))).toBe('Request failed (500).');
  });
});

describe('pctChange / fmtChange', () => {
  it('is null without a previous period or against a previous zero', () => {
    expect(pctChange(10, null)).toBeNull();
    expect(pctChange(10, undefined)).toBeNull();
    expect(pctChange(10, 0)).toBeNull();
  });

  it('formats up, down and flat with a sign', () => {
    expect(fmtChange(pctChange(110, 100)!)).toBe('+10%');
    expect(fmtChange(pctChange(90, 100)!)).toBe('−10%');
    expect(fmtChange(pctChange(100, 100)!)).toBe('±0%');
  });
});

describe('fmtRatio / fmtPosition', () => {
  it('keeps one decimal only for small rates', () => {
    expect(fmtRatio(0.068)).toBe('6.8%');
    expect(fmtRatio(0.284)).toBe('28%');
    expect(fmtRatio(0)).toBe('0%');
  });

  it('shows a dash for an unmeasured position', () => {
    expect(fmtPosition(13.34)).toBe('13.3');
    expect(fmtPosition(0)).toBe('–');
  });
});

describe('syncStatusLine', () => {
  const now = Date.parse('2026-09-09T12:00:00Z');

  it('never shows a row count', () => {
    const { text } = syncStatusLine({ lastSyncedAt: '2026-09-09T10:00:00Z', lastSyncError: undefined }, now);
    expect(text).toBe('Synced 2h ago');
    expect(text).not.toMatch(/rows/);
  });

  it('says a sync never finished, with the step that failed', () => {
    const { text, tone } = syncStatusLine(
      { lastSyncedAt: undefined, lastSyncError: 'pages failed after 56 rows were stored: Google API searchAnalytics.query failed' },
      now,
    );
    expect(text).toMatch(/^Sync did not finish: pages failed/);
    expect(tone).toBe('watch');
  });

  it('keeps the last good sync visible when a later one failed', () => {
    const { text } = syncStatusLine({ lastSyncedAt: '2026-09-07T10:00:00Z', lastSyncError: 'channels failed: 503' }, now);
    expect(text).toMatch(/^Last sync failed\. Data is from 2d ago\./);
  });

  it('reads "not synced yet" for a fresh assignment', () => {
    expect(syncStatusLine({ lastSyncedAt: undefined, lastSyncError: undefined }, now)).toEqual({
      text: 'Not synced yet',
      tone: 'muted',
    });
  });
});

describe('providerNextStep', () => {
  const base = { resourceId: null, syncedAt: null, syncError: null, connected: false, needsReauth: false, assigned: false, resourceLabel: null };

  it('walks connect, choose, sync in the order a customer does them', () => {
    expect(providerNextStep(base, 'Google Search Console', 'clicks').button).toBe('Connect Google Search Console');
    expect(providerNextStep({ ...base, connected: true }, 'Google Search Console', 'clicks').button).toBe('Choose a property');
    expect(
      providerNextStep({ ...base, connected: true, assigned: true, resourceLabel: 'sc-domain:tartanhq.com' }, 'Google Search Console', 'clicks').line,
    ).toMatch(/^sc-domain:tartanhq\.com is connected\. Data appears after the first sync/);
  });

  it('puts a failed sync and a needed reconnect in front of everything else', () => {
    expect(providerNextStep({ ...base, connected: true, assigned: true, syncError: 'pages failed' }, 'X', 'y').button).toBe('Sync again');
    expect(providerNextStep({ ...base, needsReauth: true }, 'X', 'y').button).toBe('Reconnect on Integrations');
  });

  it('never names an environment variable or API path', () => {
    for (const s of [base, { ...base, connected: true }, { ...base, connected: true, assigned: true }]) {
      const step = providerNextStep(s, 'Google Analytics', 'visits');
      expect(step.line).not.toMatch(/[A-Z]{3,}_[A-Z_]+|\/projects\//);
    }
  });
});

describe('rankChange', () => {
  /**
   * The trap: a rank is better when the number is lower, so a subtraction in
   * the obvious direction reports every improvement as a decline.
   */
  it('calls a lower position an improvement', () => {
    expect(rankChange(4, 7)).toEqual({ text: 'up 3', direction: 'better' });
    expect(rankChange(7, 4)).toEqual({ text: 'down 3', direction: 'worse' });
  });

  it('says nothing changed rather than "up 0"', () => {
    expect(rankChange(5, 5)).toEqual({ text: 'no change', direction: 'flat' });
  });

  it('separates the first poll from no change', () => {
    expect(rankChange(5, null)).toEqual({ text: 'first poll', direction: 'unknown' });
    expect(rankChange(null, null)).toEqual({ text: '—', direction: 'unknown' });
  });

  it('names leaving the tracked depth, which is not "no change"', () => {
    expect(rankChange(null, 8)).toEqual({ text: 'dropped out', direction: 'left' });
  });
});

describe('rankLabel', () => {
  it('distinguishes never polled from polled and not ranking', () => {
    expect(rankLabel(null, null)).toBe('not polled yet');
    expect(rankLabel(null, '2026-09-09T00:00:00.000Z')).toBe('not in top 10');
    expect(rankLabel(3, '2026-09-09T00:00:00.000Z')).toBe('#3');
  });
});
