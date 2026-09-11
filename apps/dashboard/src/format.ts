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
  PlatformClientView,
  PlatformUser,
  QueueHealth,
  ReadinessReport,
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

/**
 * One row of the operator checklist: what has to be true, whether it is, and
 * the exact next action when it is not.
 */
export interface OperatorCheck {
  id: string;
  label: string;
  state: 'done' | 'partial' | 'todo';
  /** What is true now, in one line. */
  detail: string;
  /** The next action, or null when the row is done. */
  next: string | null;
}

export interface OperatorChecklistInput {
  readiness: ReadinessReport | null;
  google: PlatformClientView | null;
  github: PlatformClientView | null;
  users: { users: PlatformUser[]; adminCount: number } | null;
  queue: QueueHealth | null;
}

/** How long the oldest queued crawl may wait before the runner looks stuck. */
const QUEUE_STUCK_SECONDS = 30 * 60;

function readinessCheck(
  report: ReadinessReport | null,
  id: string,
  label: string,
  todo: string,
): OperatorCheck {
  if (!report) {
    return { id, label, state: 'todo', detail: 'Could not read the deployment’s configuration.', next: todo };
  }
  const entry = report.integrations.find((i) => i.id === id);
  if (!entry) {
    return { id, label, state: 'todo', detail: 'Not in the integration registry.', next: todo };
  }
  if (entry.status === 'configured') {
    return { id, label, state: 'done', detail: 'Every required variable is set.', next: null };
  }
  // Naming the variables is the whole value of the row: "partial" tells an
  // operator nothing they can act on, and the readiness report already knows
  // exactly which names are absent.
  const missing = entry.missing.map((m) => m.name).join(', ');
  return {
    id,
    label,
    state: entry.status === 'partial' ? 'partial' : 'todo',
    detail: `Missing: ${missing}`,
    next: `Set ${missing} with \`wrangler secret put\`.`,
  };
}

function clientCheck(
  view: PlatformClientView | null,
  id: string,
  label: string,
  where: string,
): OperatorCheck {
  if (!view) {
    return { id, label, state: 'todo', detail: 'Could not read the registration.', next: `Register the client under ${where}.` };
  }
  if (view.client) {
    return { id, label, state: 'done', detail: `Registered, redirecting to ${view.client.redirectUri}`, next: null };
  }
  // A deployment can still supply the client as Worker config. That works, but
  // it cannot be rotated from the product, so it is a partial rather than done.
  if (view.configuredByEnvironment) {
    return {
      id,
      label,
      state: 'partial',
      detail: 'Supplied as Worker config, not registered in the product.',
      next: `Re-enter it under ${where} so it can be rotated without a deploy.`,
    };
  }
  return { id, label, state: 'todo', detail: 'Not registered. Every tile for this vendor reads "Needs setup".', next: `Register the client under ${where}.` };
}

/**
 * The operator checklist: is this deployment able to do the job.
 *
 * Ordered by dependency, so the first row that is not done is the one to fix —
 * an unregistered Google client cannot be worked around by setting a vendor
 * key, and nothing can be crawled before the database is reachable.
 *
 * Derived rather than stored. Every row reads state the deployment already
 * reports, so the list cannot claim something is done after someone deletes
 * the secret behind it.
 */
export function operatorChecklist(input: OperatorChecklistInput): OperatorCheck[] {
  const { readiness, google, github, users, queue } = input;

  const signIn = ((): OperatorCheck => {
    const withCredential = users?.users.filter((u) => u.hasCredential).length ?? 0;
    if (!users) {
      return { id: 'sign-in', label: 'Credential sign-in', state: 'todo', detail: 'Could not read the user list.', next: 'Check that the API is reachable.' };
    }
    if (users.adminCount === 0) {
      // A deployment with no admin cannot be administered from the product at
      // all — including fixing this row, which is why it is called out.
      return { id: 'sign-in', label: 'Credential sign-in', state: 'todo', detail: 'No administrator exists.', next: 'Create one with `pnpm db:user --email <address> --role admin`.' };
    }
    if (withCredential === 0) {
      return { id: 'sign-in', label: 'Credential sign-in', state: 'partial', detail: `${users.users.length} user${users.users.length === 1 ? '' : 's'}, none with a password.`, next: 'Sign in with an emailed code, then set a password under Settings.' };
    }
    return {
      id: 'sign-in',
      label: 'Credential sign-in',
      state: 'done',
      detail: `${withCredential} of ${users.users.length} can sign in with a password · ${users.adminCount} admin${users.adminCount === 1 ? '' : 's'}`,
      next: null,
    };
  })();

  const runner = ((): OperatorCheck => {
    if (!queue) {
      return { id: 'runner', label: 'Crawl runner', state: 'todo', detail: 'Could not read the queue.', next: 'Check that the API is reachable.' };
    }
    const waited = queue.oldestQueuedAgeSeconds;
    if (waited !== null && waited > QUEUE_STUCK_SECONDS) {
      return {
        id: 'runner',
        label: 'Crawl runner',
        state: 'todo',
        detail: `${queue.queued} queued, oldest waiting ${Math.round(waited / 60)} min.`,
        next: 'The runner is not draining the queue. Check the workflow’s last run in GitHub Actions.',
      };
    }
    if (queue.lastFinishedAt === null) {
      // Nothing queued and nothing ever finished is indistinguishable from a
      // runner that has never worked, so it is not reported as healthy.
      return { id: 'runner', label: 'Crawl runner', state: 'partial', detail: 'Nothing has ever been crawled.', next: 'Run an audit on a site, then check this row again.' };
    }
    const inFlight = queue.queued + queue.running;
    return {
      id: 'runner',
      label: 'Crawl runner',
      state: 'done',
      detail: inFlight > 0
        ? `${queue.queued} queued, ${queue.running} running · last finished ${relativeTime(queue.lastFinishedAt)}`
        : `Idle · last finished ${relativeTime(queue.lastFinishedAt)}`,
      next: null,
    };
  })();

  return [
    readinessCheck(readiness, 'database', 'Database', 'Set DATABASE_URL with `wrangler secret put`.'),
    readinessCheck(readiness, 'google-integrations', 'Encryption key and Google scopes', 'Set the missing variables with `wrangler secret put`.'),
    signIn,
    clientCheck(google, 'google-client', 'Google OAuth client', 'Google’s OAuth client below'),
    clientCheck(github, 'github-client', 'GitHub App', 'GitHub’s App below'),
    readinessCheck(readiness, 'serp', 'Search results key', 'Set the missing variables with `wrangler secret put`.'),
    readinessCheck(readiness, 'llm-sarvam', 'LLM engine', 'Set the missing variables with `wrangler secret put`.'),
    readinessCheck(readiness, 'email', 'Transactional email', 'Set the missing variables with `wrangler secret put`.'),
    runner,
  ];
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

/**
 * Whose site it is. The one question the first form asks besides the address.
 * `company` and `individual` derive every name; `agency` is the only kind
 * that reveals a second field, because the client's name is nowhere in the
 * address.
 */
export const SITE_OWNER_KINDS = [
  { value: 'company', label: 'A company', hint: 'Your own business or organisation.' },
  { value: 'agency', label: 'An agency’s client', hint: 'You do this work for someone else.' },
  { value: 'individual', label: 'Me', hint: 'A personal or professional site under your own name.' },
] as const;

export type SiteOwnerKind = (typeof SITE_OWNER_KINDS)[number]['value'];

/**
 * A readable name from a domain: the first label, with dashes as spaces and
 * each word capitalised. `acme-dental.co.uk` → `Acme Dental`. It is a
 * starting point the form shows and lets the customer change, not a fact.
 */
export function brandNameFromDomain(domainInput: string): string {
  const first = normalizeDomain(domainInput).split('.')[0] ?? '';
  return first
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** A person's name from a session that may only know their email. */
export function personNameFrom(user: { name?: string; email?: string } | null): string {
  const name = user?.name?.trim() ?? '';
  if (name && !name.includes('@')) return name;
  const local = (user?.email ?? name).split('@')[0] ?? '';
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export interface OnboardingPlan extends OnboardingDefaults {
  /** The account (client) the site is filed under, if one has to be created. */
  accountName: string;
  /** The `@type` Engine writes into the structured data it proposes. */
  entityKind: 'Organization' | 'Person';
}

/**
 * Everything the old five-field form asked for, derived from the address and
 * the owner kind. `brandName` is the one override the form still offers, one
 * click away; `clientName` is what an agency typed or picked; `userName` is
 * the signed-in person, for a site that is theirs.
 */
export function onboardingPlan(
  kind: SiteOwnerKind,
  domainInput: string,
  names: { clientName?: string; userName?: string; brandName?: string } = {},
): OnboardingPlan {
  const accountName =
    kind === 'agency' ? (names.clientName ?? '').trim()
    : kind === 'individual' ? (names.userName ?? '').trim() || brandNameFromDomain(domainInput)
    : brandNameFromDomain(domainInput);
  const d = onboardingDefaults(accountName, domainInput, '', names.brandName ?? '');
  return { ...d, accountName, entityKind: kind === 'individual' ? 'Person' : 'Organization' };
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
    targetKind: a.target.kind,
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
  'poor-self-containment': 'Sections do not stand on their own',
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

/**
 * What each issue is and why it matters, in two sentences.
 *
 * The Audit screen has always named issues in Engine's own vocabulary —
 * "canonical-conflict", "weak-eeat" — and left the reader to know what that
 * means and whether to care. A label alone is a thing to look up; a customer
 * deciding whether to spend a fix on it needs the second sentence more than
 * the first.
 *
 * Deliberately not per-page. The explanation is a property of the *kind* of
 * problem, so it belongs on the group heading, said once.
 */
const ISSUE_EXPLANATIONS: Record<string, string> = {
  'schema-missing':
    'Structured data tells search engines and AI what this page is about, in a format they read directly. Without it they have to infer it from the wording, and they often infer something else.',
  'schema-invalid':
    'This page has structured data, but it breaks the rules search engines check it against. Invalid markup is usually ignored altogether, so the page gets none of the benefit of having it.',
  'meta-title-missing':
    'The title is the line a search result and an AI answer use to name this page. With none, they pick something from the page themselves, and it is rarely the sentence you would have chosen.',
  'meta-description-missing':
    'The description is the summary shown under the title in a search result. With none, search engines quote a passage from the page, which often lands mid-sentence.',
  'ai-crawler-blocked':
    'Your robots.txt tells one or more AI crawlers to stay out. Those engines cannot cite a page they were never allowed to read.',
  'redirect-chain':
    'This URL redirects more than once before it lands. Each hop loses a little ranking signal and adds delay, and some crawlers stop following before the end.',
  'canonical-conflict':
    'This page names a different URL as the canonical one, so search engines are being asked to index that page instead of this one. If that was not intended, this page is being hidden by its own markup.',
  'hreflang-missing':
    'A page published in more than one language needs hreflang to say which version is which. Without it search engines pick one and may serve the wrong language to the wrong country.',
  'cwv-poor':
    'This page is slow or unstable to load by Google\u2019s own measurements. Core Web Vitals are a ranking input, and the same slowness costs visitors before it costs rankings.',
  'noindex-unexpected':
    'This page tells search engines not to index it. It will not appear in results at all until that instruction is removed.',
  'not-in-sitemap':
    'This page is not listed in your sitemap, so crawlers can only reach it by following a link to it. A page nobody links to and the sitemap omits may never be found.',
  'not-answer-first':
    'The answer to what this page is about arrives well down the page. AI answers quote from the top, so a page that builds up to its point often gets quoted saying nothing.',
  'weak-eeat':
    'The page shows little evidence of who wrote it or why they would know. Search engines and AI weigh that evidence when deciding whether to repeat a claim.',
  'weak-entity-coverage':
    'This page says very little about your brand by name. An engine that cannot connect the page to the brand will not cite it when asked about the brand.',
  'sparse-internal-linking':
    'Few other pages on your site link to this one. Internal links are how crawlers find pages and how ranking signal moves between them.',
  'missing-wikidata-mapping':
    'Your brand has no Wikidata entry, which is the reference many AI systems check to decide whether an entity is real and what it is. Without one, they rely on whatever else they can find.',
  'missing-entity-schema':
    'No structured data on your site identifies your brand as an organisation. That is the machine-readable statement of who you are, and nothing is making it.',
  'inconsistent-sameas':
    'Your structured data does not list the official profiles that confirm your brand elsewhere. Those links are how an engine ties the site to the company.',
  'weak-corroboration':
    'Few independent sources mention your brand in a way an engine can verify. Corroboration is what turns a claim about yourself into a fact an engine will repeat.',
  unknown:
    'This finding predates the version of Engine that records issue types, so its kind was never stored. The next audit that still finds it will label it properly.',
};

/** The two-sentence explanation for an issue type, or null when none is written. */
export function issueExplanation(issueType: string): string | null {
  return ISSUE_EXPLANATIONS[issueType] ?? null;
}

/**
 * Issue types Engine can never fix by itself, and the reason.
 *
 * The Audit screen labels a group "auto-fixable" whenever the finding carries
 * an action template, which is not the same question: a template says a fix
 * *exists* for this kind of issue, not that Engine holds what it would take to
 * write one. A brand with no Wikidata entry cannot be given one by editing the
 * site; poor Core Web Vitals are a hosting and front-end problem. Labelling
 * those "auto-fixable" and then producing nothing is the failure the customer
 * sees, and it costs them a click and their trust in the label.
 */
const MANUAL_ISSUES: Record<string, string> = {
  'cwv-poor':
    'Engine cannot make a page faster from the outside. This one is for whoever owns the site\u2019s hosting and front-end code.',
  'missing-wikidata-mapping':
    'A Wikidata entry has to be created and accepted on Wikidata itself, by a person, against their notability rules.',
  'weak-corroboration':
    'Corroboration comes from other people writing about you. Engine can show you where the gaps are; it cannot fill them on your behalf.',
  'weak-eeat':
    'Evidence of expertise \u2014 named authors, credentials, sources \u2014 has to be true before it is published. Engine will not invent it.',
  unknown: 'Engine did not record what this finding was, so it cannot pick a fix for it.',
};

/**
 * Why this issue cannot be fixed automatically, or null when it can be.
 * A group with a reason is labelled "Manual" and says what to do instead.
 */
export function manualFixReason(issueType: string): string | null {
  return MANUAL_ISSUES[issueType] ?? null;
}

export function issueLabel(issueType: string): string {
  return ISSUE_LABELS[issueType] ?? issueType;
}

/**
 * One name per screen, used by the nav rail, the breadcrumb and the page's own
 * h1. Three places used to name the same screen three ways: the rail said
 * "Findings" while the page said "Technical audit", the rail said "Fix Queue"
 * while the crumb said "Fix Queue" and the h1 said "Fix queue". A customer who
 * is told to "open Findings" then has to work out which of the eleven items
 * that is.
 *
 * Keyed by route id, so adding a route without a name here is a type error
 * rather than a screen the crumb calls by its slug.
 */
export const SCREEN_NAMES = {
  home: 'Home',
  findings: 'Findings',
  fixes: 'Fixes',
  visibility: 'Visibility',
  integrations: 'Integrations',
  settings: 'Settings',
  report: 'Branded report',
  'get-started': 'Set up',
  clients: 'Clients',
  platform: 'Platform',
  rankings: 'Rankings',
  brand: 'Brand',
  competitors: 'Competitors',
  'ai-answers': 'AI answers',
  local: 'Local',
} as const;

export type ScreenId = keyof typeof SCREEN_NAMES;

export function screenName(id: string): string {
  return (SCREEN_NAMES as Record<string, string>)[id] ?? id;
}

/**
 * The breadcrumb: which site is open, then where in it the user is. A tab
 * inside Visibility adds a third part, so "Visibility" alone never has to
 * stand for five different screens.
 */
export function breadcrumb(site: string | null, screen: string, tab?: string): string {
  return [site, screen, tab].filter(Boolean).join(' / ');
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
 * `autoFixable` used to be `actionTemplates.length > 0` alone, which answers a
 * different question: a template says a fix *exists* for this kind of issue,
 * not that Engine holds what it would take to write one. A brand with no
 * Wikidata entry cannot be given one by editing the site. Claiming
 * "auto-fixable" and then producing nothing costs the customer a click and
 * their trust in the label, so an issue with a stated manual reason is not
 * counted as auto-fixable however many templates it carries.
 */
export function toFindingRow(f: ApiFinding): FindingRow {
  return {
    id: f.id,
    type: f.issueType,
    title: issueLabel(f.issueType),
    severity: severityBand(f.severity),
    predictedImpact: impactPoints(f.predictedImpact),
    autoFixable: f.actionTemplates.length > 0 && manualFixReason(f.issueType) === null,
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
  return {
    id: a.id,
    name: a.name,
    // An API older than 0035 does not send it, and every account it holds was
    // created as a company. Defaulting here rather than at each reader keeps
    // `AccountCard.kind` total, so a view can branch on it without a guard.
    kind: a.kind ?? 'company',
    branding: a.branding,
    projects: a.projects,
    connectedProviders: a.connectedProviders ?? [],
  };
}

/** The Fix Queue lanes, in lifecycle order (rolled_back shown as its own lane). */
export const LANE_ORDER: ActionStatus[] = ['proposed', 'approved', 'deployed', 'verified'];

/**
 * The legal next transition for an action, or null when there is nothing for a
 * person to do.
 *
 * `deployed` now returns null. It used to offer "Verify", which asked the
 * *browser* for the deployed page's HTML — something a browser does not have
 * and cannot fetch cross-origin. It posted an empty string every time, the
 * matcher compared that against the proposed diff, and it failed every time. A
 * control that cannot succeed is worse than no control: it teaches the customer
 * that deploys do not stick. Verification is a machine step now, and the card
 * reports what the machine found.
 */
export function nextAction(status: ActionStatus): { to: ActionStatus; label: string } | null {
  switch (status) {
    case 'proposed':
      return { to: 'approved', label: 'Approve' };
    case 'approved':
      return { to: 'deployed', label: 'Deploy' };
    default:
      return null;
  }
}

export interface VerifyStatus {
  status: 'queued' | 'running' | 'done' | 'failed';
  verified: boolean | null;
  error: string | null;
  finishedAt: string | null;
}

/**
 * What the Deployed lane card says about the check behind it.
 *
 * Four states, because they are four different things to tell a customer, and
 * the old single failure message told them none of it: nobody has looked yet,
 * we are looking, we looked and it is live, we looked and it is not there.
 */
export function verifyLine(
  v: VerifyStatus | null,
  // Named rather than positional. `targetKind` had to join `now`, and a second
  // number-or-string parameter is exactly the signature where a caller passing
  // the old argument in the old place compiles and means something else.
  //
  // `targetKind` matters because "deployed" does not mean the same thing on
  // each: a `github-pr` fix is a pull request someone still has to merge, so
  // nothing on the site has changed, there is nothing to find on the page yet,
  // and the deploy no longer queues a check.
  opts: { targetKind?: string; now?: number } = {},
): { text: string; tone: 'good' | 'watch' | null; canCheck: boolean } {
  const now = opts.now ?? Date.now();
  if (opts.targetKind === 'github-pr' && !v) {
    return {
      text: 'Waiting for the pull request to be merged. Engine checks the page once it is.',
      tone: null,
      // Still offered: a customer who merged it a minute ago should not have to
      // wait for the nightly pass to see it confirmed.
      canCheck: true,
    };
  }
  if (!v) return { text: 'Not checked yet.', tone: null, canCheck: true };
  if (v.status === 'queued' || v.status === 'running') {
    return { text: 'Checking the live page…', tone: null, canCheck: false };
  }
  if (v.verified === true) {
    return { text: `Verified ${relativeTime(v.finishedAt, now)}`, tone: 'good', canCheck: true };
  }
  return {
    text: v.error ? `Not confirmed · ${v.error}` : 'Not found on the page yet.',
    tone: 'watch',
    canCheck: true,
  };
}

/* ── The workspace rail ───────────────────────────────────────────────────── */

/**
 * Initials for a client square. Two letters from two words, two from one.
 *
 * The square is 36 px and permanent, so three letters do not fit and one is
 * not distinctive enough to pick a client out of a column of them.
 */
export function clientInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

export interface WorkspaceSite {
  id: string;
  name: string;
  domain: string;
}

export interface WorkspaceClient {
  id: string;
  name: string;
  sites: WorkspaceSite[];
  connectedProviders: string[];
}

/**
 * The drawer's rows, filtered by what was typed.
 *
 * A client matches on its own name *or* on any of its sites, and a matching
 * client keeps only its matching sites — searching "brightsmile" should not
 * hand back every other site the agency runs for that client. A client whose
 * name matches but whose sites do not keeps all of them, because the match was
 * about the client.
 */
export function filterWorkspace(clients: readonly WorkspaceClient[], query: string): WorkspaceClient[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...clients];
  const out: WorkspaceClient[] = [];
  for (const c of clients) {
    if (c.name.toLowerCase().includes(q)) {
      out.push(c);
      continue;
    }
    const sites = c.sites.filter((s) => s.name.toLowerCase().includes(q) || s.domain.toLowerCase().includes(q));
    if (sites.length > 0) out.push({ ...c, sites });
  }
  return out;
}

/**
 * Whether the drawer earns a search field. Below this many clients, a search
 * box is one more thing to look at and nothing to look for.
 */
export const WORKSPACE_SEARCH_THRESHOLD = 8;

export function needsWorkspaceSearch(clients: readonly WorkspaceClient[]): boolean {
  return clients.length > WORKSPACE_SEARCH_THRESHOLD;
}

/**
 * What the rail header says about the open site.
 *
 * Two lines, never one: the site name alone is ambiguous across clients (two
 * clients can both have a "Main site"), and the domain alone is not what
 * anyone calls it. Null when nothing is selected, which the header renders as
 * a prompt rather than a blank.
 */
export function openSiteLabel(
  clients: readonly WorkspaceClient[],
  accountId: string | null,
  projectId: string,
): { client: string; site: string; domain: string } | null {
  for (const c of clients) {
    if (accountId && c.id !== accountId) continue;
    const site = c.sites.find((s) => s.id === projectId);
    if (site) return { client: c.name, site: site.name, domain: site.domain };
  }
  return null;
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

/* ── Home ─────────────────────────────────────────────────────────────────── */

export interface HomeSummaryInput {
  /**
   * True when the audit could not be read at all. Distinct from a site that
   * has never been audited: `healthScore` is null in both cases, and saying
   * "this site has not been audited yet" about an unreachable API states a
   * fact about the customer's site that we do not know.
   */
  auditUnavailable?: boolean;
  /** Null when this site has never been audited. */
  healthScore: number | null;
  findingCount: number;
  pagesAudited: number | null;
  /** Actions sitting in `proposed`: fixes a person can read and approve now. */
  fixesReady: number;
  lastRunAt: string | null;
  /** The queued or running crawl, when there is one. */
  crawl: { status: string; rootUrl: string } | null;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The one line under "Home" that says where this site stands.
 *
 * The screen after sign-in used to open with "Unified visibility is …" or,
 * far more often, "Search rankings and AI answers have not been sampled for
 * this site yet" — a sentence about the two data sources a new customer has
 * least of. What Engine actually knows on day one is the crawl: a health
 * score, findings, pages, and fixes waiting. That is what this says.
 *
 * A crawl in flight outranks the rest: a customer who has just added a site
 * wants to know something is happening, not read the score of a run that has
 * not finished.
 */
export function homeSummary(input: HomeSummaryInput, now = Date.now()): string {
  const { crawl } = input;
  if (crawl && (crawl.status === 'queued' || crawl.status === 'running')) {
    const host = hostname(crawl.rootUrl) || crawl.rootUrl;
    return crawl.status === 'queued'
      ? `Queued to crawl ${host}. This usually starts within a few minutes.`
      : `Crawling ${host} now. Findings appear here as they are recorded.`;
  }

  if (input.auditUnavailable) {
    return 'Could not read this site’s audit just now. The figures below are whatever else loaded.';
  }

  if (input.healthScore === null) {
    return 'This site has not been audited yet. Run an audit to see what search engines and AI assistants find.';
  }

  const parts = [`Site health ${input.healthScore}`];
  parts.push(
    input.pagesAudited === null
      ? plural(input.findingCount, 'finding')
      : `${plural(input.findingCount, 'finding')} on ${plural(input.pagesAudited, 'page')}`,
  );
  // Omitted at zero rather than shown as "0 fixes ready", which reads as a
  // failure when it usually means every proposed fix has been dealt with.
  if (input.fixesReady > 0) parts.push(`${plural(input.fixesReady, 'fix', 'fixes')} ready`);
  if (input.lastRunAt) parts.push(`audited ${relativeTime(input.lastRunAt, now)}`);
  return parts.join(' · ');
}

/**
 * How the health score should read. Three bands, matching the severity
 * vocabulary already on the findings list so one number and one chip do not
 * disagree about whether a site is in trouble.
 */
export function healthBand(score: number | null): 'good' | 'watch' | 'risk' | null {
  if (score === null) return null;
  return score >= 80 ? 'good' : score >= 50 ? 'watch' : 'risk';
}

/** How many findings sit at each severity, for the readout beside the score. */
export function severityCounts(rows: FindingRow[]): { high: number; medium: number; low: number } {
  const counts = { high: 0, medium: 0, low: 0 };
  for (const row of rows) counts[row.severity] += 1;
  return counts;
}

/** How many actions sit in each lane, for the Fixes strip. */
export function laneCounts(actions: ActionCard[]): Record<ActionStatus, number> {
  const counts = { proposed: 0, approved: 0, deployed: 0, verified: 0 } as Record<ActionStatus, number>;
  for (const a of actions) counts[a.status] += 1;
  return counts;
}
