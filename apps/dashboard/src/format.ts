/**
 * Pure presentation helpers — no DOM, unit-tested. Keeping the geometry math
 * (confidence-band bar positions, sparkline paths) out of the view code means
 * the fiddly bits are verifiable in isolation.
 */
import type {
  IntegrationAssignment,
  ProviderStatus,
  ProviderCatalogEntry, IntegrationConnection,
  ApiAuditRequest,
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

export interface AuditRequestStatusLine {
  text: string;
  /** Semantic colour token name; null means plain text. */
  tone: 'watch' | 'risk' | 'good' | null;
  /** Whether the screen should keep polling. */
  live: boolean;
}

function clockTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * One sentence for the Audit header about the newest request. `done` returns
 * null: the findings below are the message. A `failed` line carries the API's
 * error, which is the customer's to read (the runner's log never has it).
 */
export function auditRequestStatusLine(r: ApiAuditRequest | null): AuditRequestStatusLine | null {
  if (!r) return null;
  switch (r.status) {
    case 'queued':
      return { text: 'Audit queued. It usually starts within a few minutes.', tone: 'watch', live: true };
    case 'running': {
      const since = r.startedAt ? clockTime(r.startedAt) : '';
      return { text: since ? `Audit running since ${since}.` : 'Audit running.', tone: 'watch', live: true };
    }
    case 'failed':
      return { text: `The last audit failed: ${r.error ?? 'no reason was recorded'}`, tone: 'risk', live: false };
    case 'done':
      return null;
  }
}

export interface IntegrationTileState {
  /** The pill text on the tile. */
  label: string;
  /** Semantic colour token, or null for plain. */
  tone: 'good' | 'watch' | 'muted' | null;
  /** Connected first, then connectable, then blocked, then coming soon. */
  sort: number;
}

/**
 * One status per provider tile, in the customer's words. The order it implies
 * puts what already works at the top and what nobody can act on at the bottom.
 * An OAuth provider whose client the workspace has not registered reads as
 * "Needs setup" to an administrator, who can fix it, and "Not available yet"
 * to everyone else, who cannot.
 */
export function integrationTileState(
  entry: Pick<ProviderCatalogEntry, 'availability' | 'authKind'>,
  connection: Pick<IntegrationConnection, 'status' | 'scopesSufficient'> | undefined,
  // `platformReady` is per vendor now: whether Engine's own identity with
  // *this* provider's vendor is registered. One boolean for every provider
  // said "not available yet" about GitHub whenever Google was unset, and the
  // reverse.
  opts: { platformReady: boolean; isAdmin: boolean },
): IntegrationTileState {
  if (entry.availability === 'planned') return { label: 'Coming soon', tone: 'muted', sort: 3 };
  if (connection?.status === 'connected') {
    return connection.scopesSufficient === false
      ? { label: 'Missing a permission', tone: 'watch', sort: 0 }
      : { label: 'Connected', tone: 'good', sort: 0 };
  }
  if (connection?.status === 'needs_reauth') return { label: 'Reconnect needed', tone: 'watch', sort: 0 };
  if (entry.authKind !== 'api_key' && !opts.platformReady) {
    return opts.isAdmin
      ? { label: 'Needs setup', tone: 'watch', sort: 2 }
      : { label: 'Not available yet', tone: 'muted', sort: 2 };
  }
  return { label: 'Not connected', tone: null, sort: 1 };
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

/**
 * Fix types whose `after` is written by a model rather than derived — the
 * customer has to read the words before approving. Mirrors
 * `requiresHumanReview` in @engine/actions, which is what actually enforces it.
 */
const REVIEW_REQUIRED_TYPES = new Set(['content']);

/**
 * What a fix changes on the site, in the customer's terms. The card shows a
 * before/after; this says what the two halves *are*, so a reader knows whether
 * they are looking at a page title or the whole body of the page.
 */
export function actionChanges(a: ApiAction): string {
  switch (a.type) {
    case 'meta':
      if (a.diff.field === 'title') return 'The page title, as search results and AI answers show it';
      if (a.diff.field === 'description') return 'The description under the page title in search results';
      if (a.diff.field === 'hreflang') return 'The links between this page’s language versions';
      return 'A tag in the page’s head';
    case 'schema':
      return 'The structured data that tells search engines and assistants what this page is about';
    case 'robots':
      return 'Which AI crawlers your site lets in, in robots.txt';
    case 'redirect':
      return 'Where this address sends visitors';
    case 'content':
      return 'The words on the page itself';
    case 'internal-link':
      return 'Links from this page to your other pages';
    case 'gbp':
      return 'Your Google Business Profile listing';
    default:
      return 'This page';
  }
}

/** Map a persisted Action from the API onto the card the Fix Queue renders. */
export function toActionCard(a: ApiAction): ActionCard {
  return {
    id: a.id,
    type: a.type,
    kind: actionKindLabel(a.type),
    title: actionTitle(a),
    diff: a.diff,
    changes: actionChanges(a),
    impact: impactPoints(a.predictedImpact),
    effort: effortLabel(a.target.kind),
    status: a.status,
    needsReview: REVIEW_REQUIRED_TYPES.has(a.type),
    reviewedAt: a.reviewedAt,
    reviewedBy: a.reviewedBy,
  };
}

/** One line of a rendered before/after comparison. */
export interface DiffLine {
  kind: 'same' | 'removed' | 'added';
  text: string;
}

/**
 * Line-by-line comparison of a fix's before and after, so a customer sees the
 * change rather than two walls of text. A longest-common-subsequence walk:
 * lines both versions share are marked `same`, the rest are the removals and
 * additions between them.
 *
 * Line-level, not word-level, on purpose. Every diff in the queue is either a
 * single line (a title, a description) or a block of prose or JSON where the
 * unit a reader checks is the line.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');

  // lcs[i][j] = length of the longest common subsequence of a[i…] and b[j…].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: 'removed', text: a[i] });
      i++;
    } else {
      out.push({ kind: 'added', text: b[j] });
      j++;
    }
  }
  while (i < a.length) out.push({ kind: 'removed', text: a[i++] });
  while (j < b.length) out.push({ kind: 'added', text: b[j++] });
  return out;
}

/** What an empty `before` means on a card: there is nothing there today. */
export const NOTHING_THERE = 'Nothing there now';

/**
 * What kind of thing a brand is, in the customer's words. Mirrors
 * `ENTITY_KINDS` in @engine/core, which is the source of truth and what the
 * API validates against — the dashboard compiles standalone and does not
 * import the package (same reason `types.ts` mirrors the API's shapes).
 */
export const ENTITY_KIND_OPTIONS = [
  { value: 'LocalBusiness', label: 'A business people visit in person' },
  { value: 'Organization', label: 'An online business or organisation' },
  { value: 'Product', label: 'A product' },
  { value: 'Service', label: 'A service' },
  { value: 'SoftwareApplication', label: 'Software or an app' },
  { value: 'Person', label: 'A person' },
] as const;

export const DEFAULT_ENTITY_KIND = 'Organization';

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
  return { id: a.id, name: a.name, branding: a.branding, projects: a.projects, connectedProviders: a.connectedProviders ?? [] };
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

/* ── Crawl coverage ───────────────────────────────────────────────────────── */

export interface CrawlCoverageInput {
  robotsFound: boolean | null;
  sitemapUrls: number | null;
  linksDiscovered: number | null;
  blockedByRobots: number | null;
  stoppedAtLimit: boolean | null;
  maxPages: number | null;
}

export interface CrawlCoverageLine {
  /** What the crawl reached, always safe to show. */
  text: string;
  /**
   * Why it reached so little, when that is the real story. Null when the crawl
   * covered the site properly — an explanation offered every time would train
   * the reader to skip the one time it matters.
   */
  warning: string | null;
}

/**
 * What the crawl could reach, in the customer's words.
 *
 * Production's last crawl audited one page, and the Audit screen showed a thin
 * finding list — which reads as "your site is nearly clean" when it means "we
 * only ever saw your home page". A crawl that reaches one page is itself the
 * first thing to report, and the reason matters more than the number: a
 * missing sitemap, unfollowable links, a robots.txt in the way and a spent
 * budget are four different problems with four different fixes.
 */
export function crawlCoverageLine(
  pagesAudited: number | null,
  coverage: CrawlCoverageInput | null,
): CrawlCoverageLine | null {
  if (pagesAudited === null) return null;
  const pages = pagesAudited === 1 ? '1 page' : `${pagesAudited} pages`;

  // An older run genuinely recorded no coverage. Saying "no sitemap found"
  // about it would be inventing a fact; the page count is all that is known.
  if (!coverage || coverage.maxPages === null) {
    return { text: `Crawled ${pages}.`, warning: null };
  }

  const parts = [`Crawled ${pages}`];
  parts.push(
    coverage.sitemapUrls && coverage.sitemapUrls > 0
      ? `sitemap listed ${coverage.sitemapUrls}`
      : 'no sitemap found',
  );
  if (coverage.linksDiscovered !== null) {
    parts.push(`${coverage.linksDiscovered} link${coverage.linksDiscovered === 1 ? '' : 's'} followed`);
  }
  if (coverage.blockedByRobots && coverage.blockedByRobots > 0) {
    parts.push(`${coverage.blockedByRobots} blocked by robots.txt`);
  }
  const text = `${parts.join(' · ')}.`;

  // Ordered by what the reader would act on first. A spent budget is not a
  // problem with their site; the other two are.
  let warning: string | null = null;
  if (pagesAudited === 0) {
    // Not "only the home page" — not even that was reached. The health score
    // beside this line is computed over nothing, so the line has to say so.
    warning = 'No page could be reached at all, so there is nothing behind the score above. Check the address and that the site is reachable.';
  } else if (coverage.stoppedAtLimit) {
    warning = `This run stopped at its ${coverage.maxPages}-page limit, so there is more of the site to check.`;
  } else if (pagesAudited <= 1 && !coverage.sitemapUrls && !coverage.linksDiscovered) {
    warning =
      'Only the home page could be reached — no sitemap was found and no links were followed from it. ' +
      'Findings below cover that one page, not the whole site.';
  } else if (!coverage.sitemapUrls) {
    warning = 'No sitemap was found, so pages are reached only by following links. Publishing one improves coverage.';
  }
  return { text, warning };
}

/* ── The deterministic audits' last run ───────────────────────────────────── */

export interface AuditRunSummary {
  trigger: 'crawl' | 'schedule' | 'manual';
  findingsCount: number;
  ranAt: string;
}

/**
 * The line each of the four audit screens carries: when it last ran, what set
 * it off, and what it found.
 *
 * Every word of "Last checked 3h ago · after a crawl · nothing to fix" is
 * load-bearing. Before these audits were scheduled the only honest reading of
 * an empty screen was "nobody has pressed the button", and a customer had no
 * way to tell that from "we looked and you are fine". The two now read
 * differently, so the clean result is worth something.
 */
export function auditLastRunLine(run: AuditRunSummary | null | undefined, now = Date.now()): string {
  if (!run) return 'Not checked yet — this runs on its own; you can also check now.';
  const when = relativeTime(run.ranAt, now);
  const why =
    run.trigger === 'crawl' ? 'after a crawl' : run.trigger === 'schedule' ? 'on the nightly pass' : 'you asked';
  const found =
    run.findingsCount === 0
      ? 'nothing to fix'
      : `${run.findingsCount} ${run.findingsCount === 1 ? 'finding' : 'findings'}`;
  return `Last checked ${when} · ${why} · ${found}`;
}

/* ── Search and traffic (Pulse) ───────────────────────────────────────────── */

/** "2h ago" for a timestamp; "never" for none. */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'never';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 90) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Change from the previous period as a fraction, or null when there is
 * nothing to compare against. A previous value of zero has no percentage: "up
 * from nothing" is a fact, not a ratio, and the caller says so in words.
 */
export function pctChange(current: number, previous: number | null | undefined): number | null {
  if (previous === null || previous === undefined || previous === 0) return null;
  return (current - previous) / previous;
}

/** "+12%" / "−3%" / "±0%" for a fractional change. */
export function fmtChange(change: number): string {
  const pct = Math.round(change * 100);
  if (pct === 0) return '±0%';
  return pct > 0 ? `+${pct}%` : `−${Math.abs(pct)}%`;
}

/** A 0..1 ratio as a percentage with one decimal below 10%. */
export function fmtRatio(ratio: number): string {
  const pct = ratio * 100;
  return pct >= 10 || pct === 0 ? `${Math.round(pct)}%` : `${pct.toFixed(1)}%`;
}

/** An average search position, one decimal. */
export function fmtPosition(position: number): string {
  return position > 0 ? position.toFixed(1) : '–';
}

/**
 * The one line under an assigned property on the Integrations screen.
 *
 * Row counts are gone: the review's rule is that a sync count is shown only
 * once synced data changes a screen, and the screen it changes is Pulse. What
 * this line answers is "is the data current, and if not, why".
 */
export function syncStatusLine(
  a: Pick<IntegrationAssignment, 'lastSyncedAt' | 'lastSyncError'>,
  now = Date.now(),
): { text: string; tone: 'good' | 'watch' | 'muted' } {
  const error = a.lastSyncError ? a.lastSyncError.replace(/\s+/g, ' ').trim().slice(0, 160) : '';
  if (error && a.lastSyncedAt) {
    return { text: `Last sync failed. Data is from ${relativeTime(a.lastSyncedAt, now)}. ${error}`, tone: 'watch' };
  }
  if (error) return { text: `Sync did not finish: ${error}`, tone: 'watch' };
  if (a.lastSyncedAt) return { text: `Synced ${relativeTime(a.lastSyncedAt, now)}`, tone: 'good' };
  return { text: 'Not synced yet', tone: 'muted' };
}

export interface ProviderNextStep {
  line: string;
  /** What the button does; null when there is nothing for the customer to do but wait. */
  action: 'integrations' | null;
  button: string | null;
}

/**
 * Why a Pulse panel has no data, and the one thing that changes that. The
 * order is the order a customer works through: connect, choose a property,
 * wait for or start a sync.
 */
export function providerNextStep(status: ProviderStatus, providerName: string, dataNoun: string): ProviderNextStep {
  if (status.needsReauth) {
    return {
      line: `${providerName} needs to be reconnected before ${dataNoun} can update.`,
      action: 'integrations',
      button: 'Reconnect on Integrations',
    };
  }
  if (!status.connected) {
    return {
      line: `Connect ${providerName} to see ${dataNoun}.`,
      action: 'integrations',
      button: `Connect ${providerName}`,
    };
  }
  if (!status.assigned) {
    return {
      line: `${providerName} is connected. Choose which property this site reads from.`,
      action: 'integrations',
      button: 'Choose a property',
    };
  }
  if (status.syncError) {
    return {
      line: `The last sync did not finish: ${status.syncError.slice(0, 200)}`,
      action: 'integrations',
      button: 'Sync again',
    };
  }
  return {
    line: `${status.resourceLabel ?? providerName} is connected. Data appears after the first sync, which runs nightly.`,
    action: 'integrations',
    button: 'Sync now on Integrations',
  };
}

/**
 * How a tracked keyword's rank reads on screen.
 *
 * A rank is better when the number is *lower*, so a naive "+3" for a position
 * going 4 → 7 would say the opposite of what happened. This returns the
 * direction as well as the text, so the colour and the arrow agree with the
 * words.
 *
 * Entering or leaving the tracked depth are their own cases: 12 → null is not
 * "no change", and null → 12 is not an improvement of nothing.
 */
export interface RankChange {
  text: string;
  direction: 'better' | 'worse' | 'flat' | 'entered' | 'left' | 'unknown';
}

export function rankChange(position: number | null, previous: number | null): RankChange {
  if (previous === null) {
    return position === null ? { text: '—', direction: 'unknown' } : { text: 'first poll', direction: 'unknown' };
  }
  if (position === null) return { text: 'dropped out', direction: 'left' };
  const delta = previous - position;
  if (delta === 0) return { text: 'no change', direction: 'flat' };
  if (delta > 0) return { text: `up ${delta}`, direction: 'better' };
  return { text: `down ${-delta}`, direction: 'worse' };
}

/** A position as a rank, or the honest absence of one. */
export function rankLabel(position: number | null, polledAt: string | null): string {
  if (position !== null) return `#${position}`;
  return polledAt === null ? 'not polled yet' : 'not in top 10';
}
