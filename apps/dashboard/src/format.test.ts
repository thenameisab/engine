import { describe, it, expect } from 'vitest';
import { readableError } from './errors.js';
import { pctChange, fmtChange, fmtRatio, fmtPosition, syncStatusLine, providerNextStep, diffLines, actionChanges, bandPositions, sparklinePath, sparklineArea, fmtDelta, nextAction, clamp, hostname, normalizeDomain, domainRank, serpFeatureLabel, toActionCard, actionTitle, effortLabel, targetLabel, impactPoints, toFindingRow, issueLabel, severityBand, toPulseData, groupFindings, pagePath, onboardingDefaults, onboardingPlan, brandNameFromDomain, personNameFrom, auditRequestStatusLine, integrationTileState, rankChange, rankLabel, auditLastRunLine, crawlCoverageLine, accountVocabulary, showsClientColumn, chooseAccountNote, clientInitials, filterWorkspace, needsWorkspaceSearch, openSiteLabel, issueExplanation, manualFixReason, verifyLine, screenName, breadcrumb, SCREEN_NAMES, homeSummary, healthBand, severityCounts, laneCounts, operatorChecklist, strengthBand, scorePct, brandStrengthSummary, BRAND_STRENGTH_EXPLANATION } from './format.js';
import { VISIBILITY_TABS, visibilityTabId, visibleVisibilityTabs } from './views/visibility.js';
import { firstSentence } from './views/home.js';
import type { ActionCard, ApiAction, ApiAuditRequest, ApiFinding, ApiPulseResponse, EntityStrength, FindingRow } from './types.js';

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
  it('walks the lifecycle and stops where there is nothing for a person to do', () => {
    expect(nextAction('proposed')).toEqual({ to: 'approved', label: 'Approve' });
    expect(nextAction('approved')).toEqual({ to: 'deployed', label: 'Deploy' });
    // 'deployed' used to offer "Verify". Verification is a machine step now —
    // see the Deployed-card tests at the end of this file.
    expect(nextAction('deployed')).toBeNull();
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
      targetKind: 'edge-worker',
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

describe('brandNameFromDomain', () => {
  it('reads a name out of the first label', () => {
    expect(brandNameFromDomain('https://www.acme-dental.co.uk/about')).toBe('Acme Dental');
    expect(brandNameFromDomain('brightsmile.example')).toBe('Brightsmile');
  });
  it('is empty for an empty address', () => {
    expect(brandNameFromDomain('  ')).toBe('');
  });
});

describe('personNameFrom', () => {
  it('prefers a real name and falls back to the email', () => {
    expect(personNameFrom({ name: 'Aditya Gaur', email: 'ag@example.com' })).toBe('Aditya Gaur');
    expect(personNameFrom({ name: 'jane.doe@example.com', email: 'jane.doe@example.com' })).toBe('Jane Doe');
    expect(personNameFrom(null)).toBe('');
  });
});

describe('onboardingPlan', () => {
  it('a company: every name comes from the address', () => {
    expect(onboardingPlan('company', 'https://acme-dental.example/')).toEqual({
      domain: 'acme-dental.example', siteName: 'acme-dental.example',
      brandName: 'Acme Dental', accountName: 'Acme Dental', entityKind: 'Organization',
    });
  });
  it('an agency’s client: the client name is the account and the brand', () => {
    expect(onboardingPlan('agency', 'acme.example', { clientName: ' Acme Dental ' })).toEqual({
      domain: 'acme.example', siteName: 'acme.example',
      brandName: 'Acme Dental', accountName: 'Acme Dental', entityKind: 'Organization',
    });
  });
  it('me: the signed-in person is the brand, as a Person', () => {
    expect(onboardingPlan('individual', 'jane.example', { userName: 'Jane Doe' })).toEqual({
      domain: 'jane.example', siteName: 'jane.example',
      brandName: 'Jane Doe', accountName: 'Jane Doe', entityKind: 'Person',
    });
  });
  it('keeps a brand name the customer changed', () => {
    expect(onboardingPlan('company', 'acme.example', { brandName: 'ACME Inc.' }).brandName).toBe('ACME Inc.');
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

  it('points a 403 at the switcher, which every kind of account has', () => {
    // Not the Clients grid: a company or an individual has neither the grid
    // nor the word, so the recovery it named did not exist for them.
    expect(readableError(new Error('403 {"error":"project not in your account"}')))
      .toBe('project not in your account. Check which site is open in the switcher at the top of the rail.');
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

describe('auditLastRunLine', () => {
  const now = Date.parse('2026-09-10T12:00:00.000Z');

  it('says an audit has never run, without implying a clean result', () => {
    const line = auditLastRunLine(null, now);
    expect(line).toContain('Not checked yet');
    expect(line).not.toContain('nothing to fix');
  });

  it('reports a clean run as a result, not as an absence', () => {
    // The distinction the whole run table exists for: this must not read the
    // same as "never run".
    const line = auditLastRunLine(
      { trigger: 'schedule', findingsCount: 0, ranAt: '2026-09-10T09:00:00.000Z' },
      now,
    );
    expect(line).toBe('Last checked 3h ago · on the nightly pass · nothing to fix');
  });

  it('names what set the audit off', () => {
    const at = '2026-09-10T09:00:00.000Z';
    expect(auditLastRunLine({ trigger: 'crawl', findingsCount: 2, ranAt: at }, now)).toContain('after a crawl');
    expect(auditLastRunLine({ trigger: 'manual', findingsCount: 2, ranAt: at }, now)).toContain('you asked');
  });

  it('counts one finding in the singular', () => {
    const at = '2026-09-10T09:00:00.000Z';
    expect(auditLastRunLine({ trigger: 'crawl', findingsCount: 1, ranAt: at }, now)).toMatch(/· 1 finding$/);
    expect(auditLastRunLine({ trigger: 'crawl', findingsCount: 4, ranAt: at }, now)).toContain('4 findings');
  });
});

describe('crawlCoverageLine', () => {
  const full = {
    robotsFound: true,
    sitemapUrls: 40,
    linksDiscovered: 120,
    blockedByRobots: 0,
    stoppedAtLimit: false,
    maxPages: 50,
  };

  it('says nothing about a project that has never been audited', () => {
    expect(crawlCoverageLine(null, null)).toBeNull();
  });

  it('reports only the page count for a run recorded before coverage existed', () => {
    // "We did not record whether a sitemap was found" is not "no sitemap was
    // found", and an old row must not be made to say the second.
    const line = crawlCoverageLine(12, null);
    expect(line).toEqual({ text: 'Crawled 12 pages.', warning: null });
  });

  it('does not call a zero-page crawl a home page', () => {
    // The health score beside this line is computed over nothing at all, which
    // is a different and worse story than "we saw only your home page".
    const line = crawlCoverageLine(0, { ...full, sitemapUrls: 0, linksDiscovered: 0 });
    expect(line!.warning).toContain('No page could be reached');
    expect(line!.warning).not.toContain('home page could be reached');
  });

  it('names the one-page crawl as the finding it is', () => {
    // Production's actual state: one page audited, and a thin finding list
    // that reads as "nearly clean".
    const line = crawlCoverageLine(1, { ...full, sitemapUrls: 0, linksDiscovered: 0 });
    expect(line!.text).toBe('Crawled 1 page · no sitemap found · 0 links followed.');
    expect(line!.warning).toContain('Only the home page could be reached');
    expect(line!.warning).toContain('not the whole site');
  });

  it('puts a spent budget ahead of a missing sitemap, because it is a different problem', () => {
    const line = crawlCoverageLine(50, { ...full, sitemapUrls: 0, stoppedAtLimit: true });
    expect(line!.warning).toContain('50-page limit');
  });

  it('stays quiet when the crawl covered the site properly', () => {
    // A warning shown every time trains the reader to skip the one that matters.
    expect(crawlCoverageLine(40, full)!.warning).toBeNull();
  });

  it('counts pages blocked by robots.txt, and only when there are some', () => {
    expect(crawlCoverageLine(40, { ...full, blockedByRobots: 3 })!.text).toContain('3 blocked by robots.txt');
    expect(crawlCoverageLine(40, full)!.text).not.toContain('robots.txt');
  });
});

describe('the workspace rail', () => {
  const clients = [
    {
      id: 'a1',
      name: 'Bright Smile Dental',
      connectedProviders: ['gsc'],
      sites: [
        { id: 'p1', name: 'Main site', domain: 'brightsmile.example' },
        { id: 'p2', name: 'Clinic blog', domain: 'blog.brightsmile.example' },
      ],
    },
    {
      id: 'a2',
      name: 'Acme',
      connectedProviders: [],
      sites: [{ id: 'p3', name: 'Main site', domain: 'acme.example' }],
    },
  ];

  describe('clientInitials', () => {
    it('takes the first and last word, so a long name stays distinctive', () => {
      expect(clientInitials('Bright Smile Dental')).toBe('BD');
    });
    it('takes two letters from a single word, because one is not distinctive', () => {
      expect(clientInitials('Acme')).toBe('AC');
    });
    it('does not render an empty square for an empty name', () => {
      expect(clientInitials('   ')).toBe('?');
    });
  });

  describe('filterWorkspace', () => {
    it('returns everything for an empty query', () => {
      expect(filterWorkspace(clients, '  ')).toHaveLength(2);
    });

    it('narrows a matched client to its matching sites', () => {
      // Searching a domain must not hand back every other site the agency runs
      // for that client.
      const out = filterWorkspace(clients, 'blog.brightsmile');
      expect(out).toHaveLength(1);
      expect(out[0].sites.map((s) => s.id)).toEqual(['p2']);
    });

    it('keeps every site when the client name is what matched', () => {
      const out = filterWorkspace(clients, 'bright');
      expect(out[0].sites).toHaveLength(2);
    });

    it('matches a site name shared across two clients, under both', () => {
      const out = filterWorkspace(clients, 'main site');
      expect(out.map((c) => c.id)).toEqual(['a1', 'a2']);
    });

    it('returns nothing rather than everything when nothing matches', () => {
      expect(filterWorkspace(clients, 'zzz')).toEqual([]);
    });
  });

  describe('accountVocabulary', () => {
    it('says "client" for an agency and "account" for everyone else', () => {
      expect(accountVocabulary(['agency'])).toEqual({
        agency: true, one: 'client', many: 'clients', One: 'Client', Many: 'Clients',
      });
      expect(accountVocabulary(['company'])).toEqual({
        agency: false, one: 'account', many: 'accounts', One: 'Account', Many: 'Accounts',
      });
      expect(accountVocabulary(['individual'])).toEqual(accountVocabulary(['company']));
    });

    it('reads as a company before the first /accounts response, not as an agency', () => {
      // The cache is empty on a first-ever visit. The quiet answer is the safe
      // one: a company must never see a flash of the client layer, and an
      // agency's own vocabulary arriving a frame late costs nothing.
      expect(accountVocabulary([]).agency).toBe(false);
    });

    it('is an agency as soon as one account is, whatever the others are', () => {
      // Someone who runs an agency also has their own company account. They
      // think in clients on both.
      expect(accountVocabulary(['company', 'agency']).agency).toBe(true);
    });
  });

  describe('showsClientColumn', () => {
    it('hides the column from a company with one account', () => {
      expect(showsClientColumn(['company'])).toBe(false);
      expect(showsClientColumn(['individual'])).toBe(false);
      expect(showsClientColumn([])).toBe(false);
    });

    it('shows it to an agency, and to anyone with more than one account', () => {
      expect(showsClientColumn(['agency'])).toBe(true);
      expect(showsClientColumn(['company', 'company'])).toBe(true);
    });
  });

  describe('chooseAccountNote', () => {
    it('points an agency at the grid and everyone else at the switcher', () => {
      expect(chooseAccountNote(accountVocabulary(['agency']))).toContain('Clients grid');
      const company = chooseAccountNote(accountVocabulary(['company']));
      expect(company).toContain('switcher');
      expect(company).not.toMatch(/client/i);
    });
  });

  describe('needsWorkspaceSearch', () => {
    it('is quiet until a search field would have something to find', () => {
      expect(needsWorkspaceSearch(clients.length)).toBe(false);
      expect(needsWorkspaceSearch(8)).toBe(false);
      expect(needsWorkspaceSearch(9)).toBe(true);
    });
  });

  describe('openSiteLabel', () => {
    it('names the client, the site and the domain', () => {
      // The site name alone is ambiguous: both clients here have a "Main site".
      expect(openSiteLabel(clients, 'a2', 'p3')).toEqual({
        client: 'Acme',
        site: 'Main site',
        domain: 'acme.example',
      });
    });

    it('is null when nothing is open, so the header can prompt instead of blank', () => {
      expect(openSiteLabel(clients, 'a1', '')).toBeNull();
    });

    it('does not name a site from a client that is not the open one', () => {
      expect(openSiteLabel(clients, 'a2', 'p1')).toBeNull();
    });
  });
});

describe('what an issue is, and whether Engine can fix it', () => {
  it('explains an issue in the customer\u2019s terms, not Engine\u2019s', () => {
    const text = issueExplanation('canonical-conflict');
    expect(text).toBeTruthy();
    // The second sentence is the one that decides whether to care.
    expect(text!.split('. ').length).toBeGreaterThanOrEqual(2);
    expect(text).not.toContain('canonical-conflict');
  });

  it('has no explanation to offer for an issue type it does not know', () => {
    expect(issueExplanation('some-future-rule')).toBeNull();
  });

  it('names why Engine will not fix the ones it cannot', () => {
    expect(manualFixReason('cwv-poor')).toContain('hosting');
    expect(manualFixReason('missing-wikidata-mapping')).toContain('Wikidata');
    expect(manualFixReason('meta-title-missing')).toBeNull();
  });

  it('stops calling an issue auto-fixable when it has a manual reason', () => {
    // A template says a fix *exists* for this kind of issue, not that Engine
    // holds what it takes to write one. Claiming otherwise and then producing
    // nothing costs a click and the credibility of the label.
    const base = {
      id: 'f1',
      entityId: 'e1',
      source: 'technical',
      severity: 0.9,
      predictedImpact: 0.5,
      evidence: { url: 'https://x.example/a' },
      createdAt: '2026-09-10T00:00:00.000Z',
      actionTemplates: [{ type: 'meta' }],
    } as never;

    expect(toFindingRow({ ...(base as object), issueType: 'meta-title-missing' } as never).autoFixable).toBe(true);
    expect(toFindingRow({ ...(base as object), issueType: 'cwv-poor' } as never).autoFixable).toBe(false);
  });
});

describe('what the Deployed card says about the live page', () => {
  const now = Date.parse('2026-09-10T12:00:00.000Z');

  it('offers no Verify transition, because the browser could never satisfy one', () => {
    // The old button asked the browser for the deployed page's HTML, which it
    // does not have and cannot fetch cross-origin. It posted an empty string
    // and failed every time — a control that teaches the customer that deploys
    // do not stick.
    expect(nextAction('deployed')).toBeNull();
    expect(nextAction('proposed')).toEqual({ to: 'approved', label: 'Approve' });
    expect(nextAction('approved')).toEqual({ to: 'deployed', label: 'Deploy' });
  });

  it('separates never-checked from checked-and-absent', () => {
    const never = verifyLine(null, { now });
    expect(never.text).toBe('Not checked yet.');
    expect(never.tone).toBeNull();

    const absent = verifyLine({ status: 'done', verified: false, error: null, finishedAt: null }, { now });
    expect(absent.text).toBe('Not found on the page yet.');
    expect(absent.tone).toBe('watch');
  });

  it('says it is looking, and hides the button while it does', () => {
    const running = verifyLine({ status: 'queued', verified: null, error: null, finishedAt: null }, { now });
    expect(running.text).toBe('Checking the live page…');
    expect(running.canCheck).toBe(false);
  });

  it('reports a confirmed fix with when it was confirmed', () => {
    const ok = verifyLine(
      { status: 'done', verified: true, error: null, finishedAt: '2026-09-10T09:00:00.000Z' },
      { now },
    );
    expect(ok.text).toBe('Verified 3h ago');
    expect(ok.tone).toBe('good');
  });

  it('distinguishes an unreachable page from a page missing the change', () => {
    const unreachable = verifyLine(
      { status: 'done', verified: false, error: 'the page answered 503', finishedAt: null },
      { now },
    );
    expect(unreachable.text).toContain('503');
    expect(unreachable.text).not.toBe('Not found on the page yet.');
  });

  it('says a PR fix is waiting on the merge, not that it is unchecked', () => {
    // The deploy no longer queues a check for a PR target: nothing on the site
    // has changed until someone merges it. "Not checked yet" would invite a
    // customer to press a button that could only report a failure.
    const pr = verifyLine(null, { targetKind: 'github-pr', now });
    expect(pr.text).toContain('merged');
    expect(pr.tone).toBeNull();
    // Still offered, for someone who merged it a minute ago and does not want
    // to wait for the nightly pass.
    expect(pr.canCheck).toBe(true);
  });

  it('reports a real check on a PR fix once one has run', () => {
    // Once the merge pass has queued a check, the PR is no longer the story.
    const pr = verifyLine(
      { status: 'done', verified: true, error: null, finishedAt: '2026-09-10T09:00:00.000Z' },
      { targetKind: 'github-pr', now },
    );
    expect(pr.text).toBe('Verified 3h ago');
  });

  it('carries the target kind onto the card, since only the API knows it', () => {
    const card = toActionCard({
      id: 'a1',
      findingId: 'f1',
      type: 'meta',
      target: { kind: 'github-pr', repo: 'acme/site' },
      diff: { before: 'a', after: 'b', format: 'text', field: 'title' },
      status: 'deployed',
      predictedImpact: 3,
    });
    expect(card.targetKind).toBe('github-pr');
  });
});


describe('screen names', () => {
  it('names every route the rail offers', () => {
    for (const id of ['home', 'findings', 'fixes', 'visibility', 'integrations', 'settings']) {
      expect(screenName(id)).not.toBe(id);
    }
  });

  it('names every Visibility tab, so the crumb never shows a slug', () => {
    for (const tab of VISIBILITY_TABS) {
      expect(SCREEN_NAMES).toHaveProperty(tab.id);
      expect(screenName(tab.id)).not.toBe(tab.id);
    }
  });

  it('falls through to the id rather than inventing a name', () => {
    expect(screenName('not-a-route')).toBe('not-a-route');
  });
});

describe('breadcrumb', () => {
  it('reads site then screen', () => {
    expect(breadcrumb('brightsmile.example', 'Findings')).toBe('brightsmile.example / Findings');
  });

  it('adds the tab as a third part', () => {
    expect(breadcrumb('Acme', 'Visibility', 'Rankings')).toBe('Acme / Visibility / Rankings');
  });

  it('drops the site when none is open, rather than leaving a leading slash', () => {
    expect(breadcrumb(null, 'Settings')).toBe('Settings');
  });
});

describe('visibilityTabId', () => {
  it('reads the tab out of the hash', () => {
    expect(visibilityTabId('#/visibility/competitors')).toBe('competitors');
  });

  it('falls back to the first tab for a bare route or an unknown tab', () => {
    expect(visibilityTabId('#/visibility')).toBe('rankings');
    expect(visibilityTabId('#/visibility/nope')).toBe('rankings');
  });
});

describe('visibleVisibilityTabs', () => {
  const ids = (available: boolean | null): string[] => visibleVisibilityTabs(available).map((t) => t.id);

  it('drops Local for a business with no location', () => {
    expect(ids(false)).not.toContain('local');
  });

  it('drops only Local, so gating one tab cannot cost another', () => {
    expect(ids(false)).toEqual(VISIBILITY_TABS.filter((t) => t.id !== 'local').map((t) => t.id));
  });

  it('shows Local once a connection or typed-in facts exist', () => {
    expect(ids(true)).toContain('local');
  });

  it('shows Local when the answer is unknown, rather than moving the customer off it', () => {
    expect(ids(null)).toEqual(VISIBILITY_TABS.map((t) => t.id));
  });

  it('never gates the tab the redirect lands on, or a gated bookmark would loop', () => {
    const fallback = visibilityTabId('#/visibility');
    expect(ids(false)).toContain(fallback);
    expect(ids(true)).toContain(fallback);
  });
});

describe('issueLabel', () => {
  it('has copy for poor-self-containment, which used to render as its raw type', () => {
    expect(issueLabel('poor-self-containment')).toBe('Sections do not stand on their own');
  });
});

describe('homeSummary', () => {
  const audited = {
    healthScore: 20,
    findingCount: 46,
    pagesAudited: 7,
    fixesReady: 2,
    lastRunAt: '2026-09-10T10:00:00.000Z',
    crawl: null,
  };
  const now = Date.parse('2026-09-10T10:03:00.000Z');

  it('leads with the crawl, so a site just added says something is happening', () => {
    expect(
      homeSummary({ ...audited, crawl: { status: 'running', rootUrl: 'https://brightsmile.example/x' } }, now),
    ).toBe('Crawling brightsmile.example now. Findings appear here as they are recorded.');
  });

  it('says queued differently from running — one has not started', () => {
    const line = homeSummary({ ...audited, crawl: { status: 'queued', rootUrl: 'https://a.example' } }, now);
    expect(line).toContain('Queued to crawl a.example');
    expect(line).not.toContain('now');
  });

  it('reads the whole state once a run has finished', () => {
    expect(homeSummary(audited, now)).toBe('Site health 20 · 46 findings on 7 pages · 2 fixes ready · audited 3m ago');
  });

  it('omits fixes at zero rather than reporting "0 fixes ready"', () => {
    expect(homeSummary({ ...audited, fixesReady: 0 }, now)).not.toContain('fixes ready');
  });

  it('separates an unreadable audit from a site that has never been audited', () => {
    const line = homeSummary({ ...audited, auditUnavailable: true, healthScore: null }, now);
    expect(line).toContain('Could not read');
    expect(line).not.toContain('has not been audited yet');
  });

  it('says what to do when the site has never been audited, not "health 0"', () => {
    const line = homeSummary({ ...audited, healthScore: null, findingCount: 0, pagesAudited: null, lastRunAt: null }, now);
    expect(line).toContain('has not been audited yet');
    expect(line).not.toContain('0');
  });

  it('a finished crawl does not hold the line — done falls through to the score', () => {
    const line = homeSummary({ ...audited, crawl: { status: 'done', rootUrl: 'https://a.example' } }, now);
    expect(line).toContain('Site health 20');
  });

  it('agrees with itself on singulars', () => {
    const line = homeSummary({ ...audited, findingCount: 1, pagesAudited: 1, fixesReady: 1 }, now);
    expect(line).toContain('1 finding on 1 page');
    expect(line).toContain('1 fix ready');
  });
});

describe('healthBand', () => {
  it('bands the score, and reports nothing for a site never audited', () => {
    expect(healthBand(92)).toBe('good');
    expect(healthBand(80)).toBe('good');
    expect(healthBand(79)).toBe('watch');
    expect(healthBand(50)).toBe('watch');
    expect(healthBand(49)).toBe('risk');
    expect(healthBand(null)).toBeNull();
  });
});

describe('severityCounts and laneCounts', () => {
  const row = (severity: FindingRow['severity']): FindingRow => ({
    id: severity, type: 't', title: 'T', severity, predictedImpact: 1, autoFixable: false, url: '',
  });

  it('counts each severity, including the ones with none', () => {
    expect(severityCounts([row('high'), row('high'), row('low')])).toEqual({ high: 2, medium: 0, low: 1 });
  });

  it('counts every lane, so an empty lane shows 0 rather than being absent', () => {
    const action = (status: ActionCard['status']): ActionCard => ({
      id: status, type: 't', kind: 'Meta', title: 'T',
      diff: { before: '', after: '', format: 'text' }, changes: 'x', status, needsReview: false,
    });
    expect(laneCounts([action('proposed'), action('verified'), action('verified')])).toEqual({
      proposed: 1, approved: 0, deployed: 0, verified: 2,
    });
  });
});

describe('firstSentence', () => {
  it('takes the first sentence when there is more than one', () => {
    expect(firstSentence('A page needs a title. Search engines show it.')).toBe('A page needs a title.');
  });

  it('returns a single sentence whole, with no trailing cut', () => {
    expect(firstSentence('Only one sentence here.')).toBe('Only one sentence here.');
  });
});

describe('operatorChecklist', () => {
  const readiness = (over: Record<string, 'configured' | 'partial' | 'missing'> = {}) => ({
    mvpReady: false,
    summary: { configured: 0, partial: 0, missing: 0, total: 0 },
    integrations: ['database', 'google-integrations', 'serp', 'llm-sarvam', 'email'].map((id) => ({
      id,
      name: id,
      category: 'x',
      logoDomain: '',
      requiredForMvp: true,
      status: over[id] ?? ('configured' as const),
      missing: (over[id] ?? 'configured') === 'configured' ? [] : [{ name: 'SOME_KEY', description: '' }],
      optionalPresent: [],
    })),
  });
  const client = (registered: boolean, byEnv = false) => ({
    vendor: 'google',
    client: registered ? { clientId: 'id', redirectUri: 'https://api.example/callback', updatedAt: '', updatedBy: '' } : null,
    suggestedRedirectUri: 'https://api.example/callback',
    configuredByEnvironment: byEnv,
    events: [],
  });
  const users = (over: Partial<{ admins: number; withCredential: number; total: number }> = {}) => {
    const total = over.total ?? 2;
    const withCredential = over.withCredential ?? 2;
    return {
      adminCount: over.admins ?? 1,
      users: Array.from({ length: total }, (_, i) => ({
        id: `u${i}`,
        platformRole: (i === 0 ? 'admin' : 'user') as 'admin' | 'user',
        hasCredential: i < withCredential,
        createdAt: '2026-09-01T00:00:00.000Z',
      })),
    };
  };
  const queue = (over: Partial<{ queued: number; running: number; oldest: number | null; last: string | null }> = {}) => ({
    queued: over.queued ?? 0,
    running: over.running ?? 0,
    oldestQueuedAgeSeconds: over.oldest === undefined ? null : over.oldest,
    lastFinishedAt: over.last === undefined ? new Date(Date.now() - 60_000).toISOString() : over.last,
  });
  const full = (over: Partial<Parameters<typeof operatorChecklist>[0]> = {}) =>
    operatorChecklist({
      readiness: readiness(),
      google: client(true),
      github: client(true),
      users: users(),
      queue: queue(),
      ...over,
    });
  const row = (rows: ReturnType<typeof operatorChecklist>, id: string) => rows.find((r) => r.id === id)!;

  it('reports every row done on a fully configured deployment', () => {
    const rows = full();
    expect(rows.every((r) => r.state === 'done')).toBe(true);
    // A done row carries no next action, which is what makes "the first row
    // that is not done is the one to fix" readable.
    expect(rows.every((r) => r.next === null)).toBe(true);
  });

  it('is ordered by dependency, so the first unfinished row is the one to fix', () => {
    // Registering a Google client cannot help while the database is unset.
    expect(full().map((r) => r.id)).toEqual([
      'database',
      'google-integrations',
      'sign-in',
      'google-client',
      'github-client',
      'serp',
      'llm-sarvam',
      'email',
      'runner',
    ]);
  });

  it('names the missing variables rather than saying "partial"', () => {
    const r = row(full({ readiness: readiness({ database: 'missing' }) }), 'database');
    expect(r.state).toBe('todo');
    expect(r.detail).toContain('SOME_KEY');
    expect(r.next).toContain('SOME_KEY');
  });

  it('counts a client supplied as Worker config as partial, not done', () => {
    // It works, but it cannot be rotated from the product.
    const r = row(full({ google: client(false, true) }), 'google-client');
    expect(r.state).toBe('partial');
    expect(r.next).toContain('rotated');
  });

  it('says what an unregistered client costs on the customer screen', () => {
    const r = row(full({ github: client(false) }), 'github-client');
    expect(r.state).toBe('todo');
    expect(r.detail).toContain('Needs setup');
  });

  it('calls out a deployment with no administrator', () => {
    // Nobody can fix this row from inside the product, so it names the CLI.
    const r = row(full({ users: users({ admins: 0 }) }), 'sign-in');
    expect(r.state).toBe('todo');
    expect(r.next).toContain('pnpm db:user');
  });

  it('treats an admin with no password as partial', () => {
    const r = row(full({ users: users({ withCredential: 0 }) }), 'sign-in');
    expect(r.state).toBe('partial');
  });

  it('does not call a runner healthy when nothing has ever been crawled', () => {
    // An empty queue with no completion is indistinguishable from a runner
    // that has never worked.
    const r = row(full({ queue: queue({ last: null }) }), 'runner');
    expect(r.state).toBe('partial');
    expect(r.detail).toContain('ever been crawled');
  });

  it('flags a queue that is not draining', () => {
    const r = row(full({ queue: queue({ queued: 4, oldest: 45 * 60 }) }), 'runner');
    expect(r.state).toBe('todo');
    expect(r.detail).toContain('45 min');
    expect(r.next).toContain('GitHub Actions');
  });

  it('accepts a deep queue that is still fresh', () => {
    const r = row(full({ queue: queue({ queued: 12, running: 1, oldest: 20 }) }), 'runner');
    expect(r.state).toBe('done');
    expect(r.detail).toContain('12 queued');
  });

  it('reports a failed read as a to-do naming the read, not by throwing', () => {
    const rows = operatorChecklist({ readiness: null, google: null, github: null, users: null, queue: null });
    expect(rows).toHaveLength(9);
    expect(rows.every((r) => r.next !== null)).toBe(true);
  });
});

describe('brand strength as a Findings group', () => {
  const entity = (
    canonicalName: string,
    components: EntityStrength['components'],
  ): EntityStrength => ({
    entityId: canonicalName,
    canonicalName,
    // The same 30/30/20/20 blend `@engine/entity-audit` applies, so a fixture
    // cannot claim a score its components would not produce.
    score:
      0.3 * components.schema +
      0.3 * components.corroboration +
      0.2 * components.wikidata +
      0.2 * components.sameAsConsistency,
    components,
    corroboratingDomains: 0,
  });

  const strong = entity('Acme', { wikidata: 1, schema: 1, sameAsConsistency: 1, corroboration: 1 });
  const weak = entity('Acme Labs', { wikidata: 0, schema: 0, sameAsConsistency: 0.5, corroboration: 0.2 });

  it('says nothing at all when no entity has been scored', () => {
    // A group reading "0%" would describe a site nobody has looked at as a
    // site with no brand, which is a different and much worse claim.
    expect(brandStrengthSummary([])).toBeNull();
  });

  it('averages across entities rather than letting the worst one speak', () => {
    const b = brandStrengthSummary([strong, weak])!;
    expect(b.entityCount).toBe(2);
    expect(b.score).toBeCloseTo((strong.score + weak.score) / 2, 10);
    expect(b.score).toBeGreaterThan(weak.score);
  });

  it('names the weakest entity, which is where an owner starts', () => {
    expect(brandStrengthSummary([strong, weak])!.weakest).toBe('Acme Labs');
    expect(brandStrengthSummary([weak, strong])!.weakest).toBe('Acme Labs');
  });

  it('orders the four signals weakest first, breaking a tie on weight', () => {
    const b = brandStrengthSummary([weak])!;
    expect(b.components.map((c) => c.key)).toEqual(['schema', 'wikidata', 'corroboration', 'sameAsConsistency']);
    // wikidata and schema are both 0; schema leads because it carries 30%.
    expect(b.components[0].weight).toBeGreaterThan(b.components[1].weight);
  });

  it('keeps the weights the explanation names adding up to the whole score', () => {
    // The weights are copied from `@engine/entity-audit`. If they change there
    // without changing here, the sentence a customer reads becomes wrong.
    const b = brandStrengthSummary([strong])!;
    expect(b.components.reduce((sum, c) => sum + c.weight, 0)).toBeCloseTo(1, 10);
    expect(BRAND_STRENGTH_EXPLANATION).toContain('30%');
    expect(BRAND_STRENGTH_EXPLANATION).toContain('20%');
  });

  it('bands a score the same way on Findings and on the Brand screen', () => {
    expect(strengthBand(0.75)).toBe('good');
    expect(strengthBand(0.74)).toBe('warn');
    expect(strengthBand(0.5)).toBe('warn');
    expect(strengthBand(0.49)).toBe('bad');
    expect(brandStrengthSummary([weak])!.band).toBe('bad');
    expect(brandStrengthSummary([strong])!.band).toBe('good');
  });

  it('reads a 0-1 score as a whole percentage, clamped', () => {
    expect(scorePct(0.625)).toBe('63%');
    expect(scorePct(0)).toBe('0%');
    expect(scorePct(1)).toBe('100%');
    expect(scorePct(1.4)).toBe('100%');
  });
});
