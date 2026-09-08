/**
 * Pure presentation helpers — no DOM, unit-tested. Keeping the geometry math
 * (confidence-band bar positions, sparkline paths) out of the view code means
 * the fiddly bits are verifiable in isolation.
 */
import type {
  AccountCard,
  ActionCard,
  ApiAccount,
  ApiAction,
  ApiFinding,
  ApiPulseResponse,
  ChannelContribution,
  FindingRow, FindingGroup,
  PulseData,
  ScoreBand,
  ActionStatus,
  SerpOrganic,
} from './types.js';

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Map a confidence band onto a 0–100% range-bar. The bar shows a local window
 * padded by the band width on each side, so a wider band visibly fills more of
 * the track — uncertainty is legible, never hidden. Tick marks the point value.
 */
export function bandPositions(band: ScoreBand): { leftPct: number; rightPct: number; tickPct: number } {
  const width = Math.max(band.high - band.low, 2);
  const domainMin = band.low - width;
  const domainMax = band.high + width;
  const span = domainMax - domainMin || 1;
  const pct = (v: number) => clamp(((v - domainMin) / span) * 100, 0, 100);
  const left = pct(band.low);
  const right = pct(band.high);
  return {
    leftPct: left,
    rightPct: 100 - right, // CSS `right` inset
    tickPct: pct(band.point),
  };
}

/** Build an SVG polyline `d` for a sparkline mapping a series into a viewBox. */
export function sparklinePath(series: number[], width: number, height: number, pad = 3): string {
  if (series.length === 0) return '';
  if (series.length === 1) {
    const y = height / 2;
    return `M0,${y} L${width},${y}`;
  }
  const min = Math.min(...series);
  const max = Math.max(...series);
  const range = max - min || 1;
  const innerH = height - pad * 2;
  const step = width / (series.length - 1);
  const pts = series.map((v, i) => {
    const x = i * step;
    const y = pad + innerH * (1 - (v - min) / range);
    return `${round(x)},${round(y)}`;
  });
  return `M${pts.join(' L')}`;
}

/** Close a line path into a filled area down to the baseline. */
export function sparklineArea(series: number[], width: number, height: number, pad = 3): string {
  const line = sparklinePath(series, width, height, pad);
  if (!line) return '';
  return `${line} L${round(width)},${height} L0,${height} Z`;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** A signed, one-decimal delta, e.g. +4.2 / −1.0 (real minus sign). */
export function fmtDelta(n: number): string {
  const s = n.toFixed(1);
  return n >= 0 ? `+${s}` : s.replace('-', '−');
}

/** Hostname of a URL, lowercased, without a leading www. Empty if unparseable. */
export function hostname(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

/** Normalize a user-entered domain to a bare host for matching. */
export function normalizeDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '');
}

export interface OnboardingDefaults {
  domain: string;
  siteName: string;
  brandName: string;
}

/**
 * Fill the optional onboarding fields from the required ones. The domain is
 * normalized the way the rest of the app matches hosts; the site is named
 * after its domain and the brand after the client unless the customer typed
 * something else.
 */
export function onboardingDefaults(clientName: string, domainInput: string, siteName = '', brandName = ''): OnboardingDefaults {
  const domain = normalizeDomain(domainInput);
  return {
    domain,
    siteName: siteName.trim() || domain,
    brandName: brandName.trim() || clientName.trim(),
  };
}

/** The position of the first organic result whose host matches `domain`, or null if not found. */
export function domainRank(organic: SerpOrganic[], domain: string): number | null {
  const target = normalizeDomain(domain);
  if (!target) return null;
  for (const o of organic) {
    const host = hostname(o.url);
    if (host === target || host.endsWith(`.${target}`)) return o.position;
  }
  return null;
}

/** Human label for a SERP feature key. */
export function serpFeatureLabel(feature: string): string {
  return feature.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}

const CONTRIBUTION_META: Record<
  'organic' | 'ai' | 'local',
  { label: string; sub: (r: ApiPulseResponse) => string }
> = {
  organic: {
    label: 'Organic SoV',
    sub: (r) => `rank presence · ${r.keywordsTracked} kw tracked`,
  },
  ai: {
    label: 'AI Share of Model',
    sub: (r) => `citation sampling · ${r.citationSamples} sample${r.citationSamples === 1 ? '' : 's'}`,
  },
  local: {
    label: 'Local SoV',
    sub: () => 'not measured yet',
  },
};

/**
 * Map `GET /projects/:id/pulse` onto the view model Pulse renders. `score`
 * stays null when the project has nothing polled — the hero panel renders
 * that as "no data" rather than the 0 a naive default would produce, which
 * would read as "this domain has zero visibility" instead of "unmeasured".
 *
 * Local's contribution cell is included even at weight 0 (rather than
 * omitted) so the UI always shows all three surfaces and can say *why* one
 * is flat: B5 (local audit) isn't built yet, which is a different fact than
 * "this business has no local presence".
 */
export function toPulseData(resp: ApiPulseResponse): PulseData {
  const contributions: ChannelContribution[] = (['organic', 'ai', 'local'] as const).map((key) => {
    const meta = CONTRIBUTION_META[key];
    const d = resp.score?.decomposition[key];
    const band = key === 'ai' ? resp.aiBand : null;
    return {
      key,
      label: meta.label,
      value: d?.score ?? 0,
      low: band?.low,
      high: band?.high,
      sub: meta.sub(resp),
    };
  });

  return {
    score: resp.score ? { point: Math.round(resp.score.band.point), low: Math.round(resp.score.band.low), high: Math.round(resp.score.band.high) } : null,
    contributions,
    keywordsTracked: resp.keywordsTracked,
    citationSamples: resp.citationSamples,
  };
}

/** Map a persisted Action from the API onto the card the Fix Queue renders. */
export function toActionCard(a: ApiAction): ActionCard {
  return {
    id: a.id,
    kind: actionKindLabel(a.type),
    title: actionTitle(a),
    impact: impactPoints(a.predictedImpact),
    effort: effortLabel(a.target.kind),
    status: a.status,
  };
}

/**
 * Human copy for each B1 issue type. Presentation only — the vocabulary itself
 * is @engine/diagnosis' `IssueType`, which is deliberately terse and stable
 * because it is hashed into the finding's fingerprint. Prose belongs here,
 * where changing it cannot alter a finding's identity.
 *
 * An unmapped type falls through to the raw string rather than something like
 * "Unknown issue": the type is the truth we have, and showing it beats hiding
 * it. `unknown` itself is real — findings stored before the issue type was
 * carried through (migration 0004) genuinely cannot say what they were, and
 * they heal on the next crawl.
 */
const ISSUE_LABELS: Record<string, string> = {
  'schema-missing': 'No structured data',
  'schema-invalid': 'Structured data has validation errors',
  'meta-title-missing': 'Missing <title>',
  'meta-description-missing': 'Missing meta description',
  'ai-crawler-blocked': 'AI crawlers blocked by robots.txt',
  'redirect-chain': 'Redirect chain',
  'canonical-conflict': 'Canonical points away from an indexable page',
  'hreflang-missing': 'Missing hreflang alternates',
  'cwv-poor': 'Poor Core Web Vitals',
  'noindex-unexpected': 'Unexpected noindex',
  'not-in-sitemap': 'Not in the sitemap',
  // Content findings (@engine/content rules).
  'not-answer-first': 'Answer is not at the top of the page',
  'weak-eeat': 'Weak signs of expertise and trust',
  'weak-entity-coverage': 'Page says too little about your brand',
  'sparse-internal-linking': 'Too few internal links',
  // Entity findings (@engine/entity-audit rules).
  'missing-wikidata-mapping': 'Brand has no Wikidata entry',
  'missing-entity-schema': 'No structured data identifies your brand',
  'inconsistent-sameas': 'Official profiles missing from structured data',
  'weak-corroboration': 'Few independent sources confirm your brand',
  unknown: 'Issue type not recorded',
};

export function issueLabel(issueType: string): string {
  return ISSUE_LABELS[issueType] ?? issueType;
}

/**
 * Severity band for the row's colour chip. Diagnosis scores severity 0–1 as an
 * intrinsic per-issue-type weight spanning 0.35 (`not-in-sitemap`) to 0.95
 * (`ai-crawler-blocked`); these cuts split that range so the GEO-native issues
 * the product exists to fix read as high, and the housekeeping ones do not.
 */
export function severityBand(severity: number): 'high' | 'medium' | 'low' {
  if (severity >= 0.8) return 'high';
  if (severity >= 0.55) return 'medium';
  return 'low';
}

/**
 * Map a persisted Finding onto the row the Audit view renders.
 *
 * `autoFixable` is `actionTemplates.length > 0` — the §7 contract guarantees a
 * finding carries a template or a documented reason it can't, so an empty list
 * means "no one-click fix exists", which is exactly what the pill claims.
 */
export function toFindingRow(f: ApiFinding): FindingRow {
  return {
    id: f.id,
    type: f.issueType,
    title: issueLabel(f.issueType),
    severity: severityBand(f.severity),
    predictedImpact: impactPoints(f.predictedImpact),
    autoFixable: f.actionTemplates.length > 0,
    // Findings are per-page, and the page URL lives in evidence. A finding
    // without one is a bug, but an empty cell beats "undefined" in the UI.
    url: typeof f.evidence?.url === 'string' ? f.evidence.url : '',
  };
}

const SEVERITY_ORDER: Record<FindingRow['severity'], number> = { high: 0, medium: 1, low: 2 };

/**
 * Group findings by issue type for the Audit screen. A crawl reports one
 * finding per page per issue, so a 7-page site with 6 issues is 42 rows that
 * differ only in URL. Grouping puts the issue once and lists the pages under
 * it. Groups sort high severity first, then by how many pages are affected;
 * pages inside a group keep the order the API returned.
 */
export function groupFindings(rows: FindingRow[]): FindingGroup[] {
  const byType = new Map<string, FindingGroup>();
  for (const row of rows) {
    const group = byType.get(row.type);
    if (group) {
      group.findings.push(row);
      group.pageCount += 1;
      // One finding with a template is enough to offer the button on the group.
      group.autoFixable = group.autoFixable || row.autoFixable;
    } else {
      byType.set(row.type, {
        type: row.type,
        title: row.title,
        severity: row.severity,
        autoFixable: row.autoFixable,
        pageCount: 1,
        findings: [row],
      });
    }
  }
  return [...byType.values()].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.pageCount - a.pageCount,
  );
}

/**
 * The part of a page URL a customer scans a list by: the path. The host is the
 * same on every row of one audit, so it goes in the muted line instead.
 */
export function pagePath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}` || '/';
  } catch {
    return url;
  }
}

/**
 * Diagnosis scores predicted impact on 0–1 (severity weight x page value); the
 * card reads "+N impact" on a 0–10 scale. Rescale here rather than changing the
 * Finding contract — 0–1 is the right shape for the scoring math, and "+0.855
 * impact" is the wrong shape for a human deciding what to approve first.
 */
export function impactPoints(predictedImpact: number): number {
  return Math.round(clamp(predictedImpact, 0, 1) * 10);
}

/**
 * A card needs a human sentence, but an Action carries only a typed diff. Derive
 * the sentence from the diff rather than storing prose: the diff is what actually
 * deploys, so a title built from it cannot drift from what the fix does.
 */
export function actionTitle(a: ApiAction): string {
  const where = targetLabel(a.target);
  switch (a.type) {
    case 'meta':
      return `Regenerate ${a.diff.field ?? 'meta'} · ${where}`;
    case 'schema':
      return `Inject JSON-LD · ${where}`;
    case 'robots':
      return `Update robots.txt · ${where}`;
    case 'redirect':
      return `Fix redirect · ${where}`;
    case 'content':
      return `Content rewrite · ${where}`;
    case 'internal-link':
      return `Add internal links · ${where}`;
    case 'gbp':
      return `Update business profile · ${where}`;
    default:
      return `${actionKindLabel(a.type)} · ${where}`;
  }
}

/** Where a fix lands, in the user's terms. */
export function targetLabel(t: ApiAction['target']): string {
  switch (t.kind) {
    case 'cms-plugin':
      return [t.plugin, t.siteId].filter(Boolean).join(' · ') || 'cms plugin';
    case 'edge-worker':
      return t.workerName ?? 'edge worker';
    case 'github-pr':
      return t.repo ?? 'repo';
    case 'gbp-api':
      return t.locationId ?? 'location';
    default:
      return t.kind;
  }
}

const KIND_LABELS: Record<string, string> = {
  'internal-link': 'Internal links',
};

export function actionKindLabel(type: string): string {
  return KIND_LABELS[type] ?? type.charAt(0).toUpperCase() + type.slice(1);
}

/** How much work a fix costs the user, read off where it deploys. */
export function effortLabel(targetKind: string): string {
  switch (targetKind) {
    case 'cms-plugin':
      return '1-click';
    case 'edge-worker':
      return 'edge';
    case 'github-pr':
      return 'PR';
    case 'gbp-api':
      return 'auto';
    default:
      return targetKind;
  }
}

const STATUS_LABELS: Record<ActionStatus, string> = {
  proposed: 'Proposed',
  approved: 'Approved',
  deployed: 'Deployed',
  verified: 'Verified',
  rolled_back: 'Rolled back',
};

export function statusLabel(status: ActionStatus): string {
  return STATUS_LABELS[status];
}

/** Map an `ApiAccount` onto the multi-client grid's card (drops `createdAt` — the grid has no use for it). */
export function toAccountCard(a: ApiAccount): AccountCard {
  return { id: a.id, name: a.name, branding: a.branding, projects: a.projects };
}

/** The Fix Queue lanes, in lifecycle order (rolled_back shown as its own lane). */
export const LANE_ORDER: ActionStatus[] = ['proposed', 'approved', 'deployed', 'verified'];

/** The legal next transition for an action, or null at a terminal state. */
export function nextAction(status: ActionStatus): { to: ActionStatus; label: string } | null {
  switch (status) {
    case 'proposed':
      return { to: 'approved', label: 'Approve' };
    case 'approved':
      return { to: 'deployed', label: 'Deploy' };
    case 'deployed':
      return { to: 'verified', label: 'Verify' };
    default:
      return null;
  }
}
