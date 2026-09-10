import { el, svg } from '../dom.js';
import {
  bandPositions,
  sparklinePath,
  sparklineArea,
  fmtInt,
  fmtChange,
  fmtRatio,
  fmtPosition,
  pctChange,
  pagePath,
  providerNextStep,
  relativeTime,
  screenName,
  homeSummary,
  healthBand,
  severityCounts,
  laneCounts,
  groupFindings,
  issueExplanation,
  statusLabel,
  LANE_ORDER,
} from '../format.js';
import { fetchPulse, fetchSearchTraffic, fetchAudit, fetchActions, fetchLatestAuditRequest } from '../api.js';
import { infoCard, type HoverCardContent } from '../hovercard.js';
import { readableError } from '../errors.js';
import { runAuditButton } from '../runAuditButton.js';
import type { AppContext } from '../context.js';
import type {
  PulseData,
  ChannelContribution,
  SearchTraffic,
  SearchSummary,
  TrafficSummary,
  ProviderStatus,
  DailyPoint,
  AuditData,
  ActionCard,
  ApiAuditRequest,
} from '../types.js';

/**
 * Home — the first screen after sign-in.
 *
 * It replaces Pulse, which led with the Unified Visibility Score. That score
 * needs tracked keywords and sampled AI prompts, and a site added five
 * minutes ago has neither, so the first screen of the product told almost
 * every new customer that there was nothing to show. What Engine does know
 * on day one is its own crawl: a health score, findings grouped by issue,
 * and fixes waiting to be read.
 *
 * So the order here is what Engine knows, most certain first: the crawl, the
 * fixes it produced, then visibility, then the connected accounts. A block
 * with no source shows what would fill it, never a zero.
 */

/** How often the screen re-checks a queued or running crawl. Matches Findings. */
const POLL_MS = 20_000;

/* ── Site health ──────────────────────────────────────────────────────────── */

/**
 * The block for a site that has never been audited. A dash, three zero
 * counts and a "See all findings" button that opens an empty screen is the
 * pattern the 2026-09-09 review counted four times: an empty state naming an
 * action the screen does not offer. This offers it.
 */
function firstRunBlock(ctx: AppContext, latest: ApiAuditRequest | null, reload: () => Promise<void>): HTMLElement {
  return el('section', { class: 'panel hm-health' }, [
    el('div', { class: 'gm-empty' }, [
      el('p', {}, [
        'Engine reads the site the way a search engine and an AI assistant do, then lists what it finds and which of it can be fixed for you.',
      ]),
      runAuditButton(ctx, latest, reload, 'Run the first audit'),
    ]),
  ]);
}

function healthBlock(ctx: AppContext, d: AuditData, crawling: boolean): HTMLElement {
  const band = healthBand(d.healthScore);
  const counts = severityCounts(d.findings);

  // Not a hero card. The score is a readout on a row with the three counts
  // that explain it, because "20" on its own tells a customer nothing they
  // can act on and the counts are what they click.
  const score = el('div', { class: 'hm-score' }, [
    el('span', { class: `hm-score-v num ${band ?? ''}` }, [d.healthScore === null ? '—' : String(d.healthScore)]),
    el('span', { class: 'hm-score-k' }, ['Site health']),
  ]);

  const severity = (key: 'high' | 'medium' | 'low', n: number) =>
    el('a', { class: 'hm-sev', href: '#/findings' }, [
      el('span', { class: `sev ${key}` }, [key]),
      el('span', { class: 'num' }, [String(n)]),
    ]);

  return el('section', { class: 'panel hm-health' }, [
    el('div', { class: 'hm-health-row' }, [
      score,
      el('div', { class: 'hm-sevs' }, [
        severity('high', counts.high),
        severity('medium', counts.medium),
        severity('low', counts.low),
      ]),
      el('button', { class: 'btn', onclick: () => ctx.navigate('findings') }, ['See all findings']),
    ]),
    // Without this the screen says "Crawling now" above a score and three
    // counts from the run before, with nothing to say which is which. The
    // numbers are still the best answer available, so they stay — they are
    // just labelled as the previous answer.
    crawling
      ? el('p', { class: 'hm-stale' }, [
          `From the last completed run${d.lastRunAt ? `, ${relativeTime(d.lastRunAt)}` : ''}. These change when the crawl finishes.`,
        ])
      : null,
  ]);
}

/* ── Top issues ───────────────────────────────────────────────────────────── */

/**
 * The three issue groups worth reading first. `groupFindings` already sorts
 * high severity first, then by how many pages carry the issue, which is the
 * same order Findings uses — so the top of Home and the top of Findings are
 * the same three rows, and clicking through does not reshuffle.
 */
function topIssuesBlock(ctx: AppContext, d: AuditData): HTMLElement | null {
  const groups = groupFindings(d.findings).slice(0, 3);
  if (groups.length === 0) return null;

  return el('section', { class: 'panel' }, [
    el('header', {}, [
      el('h3', {}, ['What to fix first']),
      el('a', { class: 'more', href: '#/findings' }, ['All findings →']),
    ]),
    el(
      'div',
      { class: 'hm-issues' },
      groups.map((g) => {
        const why = issueExplanation(g.type);
        return el('a', { class: 'hm-issue', href: '#/findings' }, [
          el('div', { class: 'hm-issue-top' }, [
            el('span', { class: `sev ${g.severity}` }, [g.severity]),
            el('b', {}, [g.title]),
            el('span', { class: 'hm-issue-n num' }, [
              g.pageCount === 1 ? 'on 1 page' : `on ${g.pageCount} pages`,
            ]),
          ]),
          // One sentence, not the full explanation: this is the reason to
          // click through, not the place to read the whole thing.
          why ? el('p', { class: 'hm-issue-why' }, [firstSentence(why)]) : null,
        ]);
      }),
    ),
  ]);
}

/** The first sentence of an explanation, for a preview that must stay one line tall. */
export function firstSentence(text: string): string {
  const end = text.indexOf('. ');
  return end === -1 ? text : text.slice(0, end + 1);
}

/* ── Fixes ────────────────────────────────────────────────────────────────── */

/**
 * What each fix would change, as the customer will read it on the card.
 * Truncated hard: this is a preview that has to fit a row, and the Fixes
 * screen shows the full diff.
 */
function preview(text: string, limit = 90): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

function fixesBlock(ctx: AppContext, actions: ActionCard[]): HTMLElement {
  const counts = laneCounts(actions);
  const next = actions.filter((a) => a.status === 'proposed').slice(0, 2);

  const lanes = el(
    'div',
    { class: 'hm-lanes' },
    LANE_ORDER.map((status) =>
      el('a', { class: 'hm-lane', href: '#/fixes' }, [
        el('span', { class: 'num' }, [String(counts[status])]),
        el('span', {}, [statusLabel(status)]),
      ]),
    ),
  );

  const body =
    next.length > 0
      ? el(
          'div',
          { class: 'hm-fixes' },
          next.map((a) =>
            el('div', { class: 'hm-fix' }, [
              el('div', { class: 'hm-fix-top' }, [el('b', {}, [a.title]), el('span', { class: 'hm-fix-k' }, [a.changes])]),
              el('div', { class: 'hm-fix-diff' }, [
                el('div', { class: 'hm-fix-side' }, [
                  el('span', { class: 'label' }, ['Now']),
                  el('code', {}, [a.diff.before ? preview(a.diff.before) : 'nothing there']),
                ]),
                el('div', { class: 'hm-fix-side' }, [
                  el('span', { class: 'label' }, ['After']),
                  el('code', { class: 'after' }, [preview(a.diff.after)]),
                ]),
              ]),
            ]),
          ),
        )
      : el('div', { class: 'fq-note' }, [
          counts.proposed + counts.approved + counts.deployed + counts.verified === 0
            ? 'No fixes proposed yet. Findings that Engine can fix get a fix from the Findings screen.'
            : 'Nothing waiting to be read. Every proposed fix has been dealt with.',
        ]);

  return el('section', { class: 'panel' }, [
    el('header', {}, [
      el('h3', {}, [screenName('fixes')]),
      el('a', { class: 'more', href: '#/fixes' }, ['Open Fixes →']),
    ]),
    lanes,
    body,
  ]);
}

/* ── Visibility ───────────────────────────────────────────────────────────── */

function contributionCell(c: ChannelContribution): HTMLElement {
  const isBand = c.low !== undefined && c.high !== undefined;
  const meterPct = isBand ? (c.low! + c.high!) / 2 : c.value;
  return el('div', { class: 'cell' }, [
    el('div', { class: 'top' }, [
      el('h4', {}, [c.label]),
      isBand ? el('span', { class: 'tagband' }, ['± range']) : null,
    ]),
    el('div', { class: 'v num' }, [
      String(Math.round(c.value)),
      isBand ? el('span', { class: 'v-range' }, [`–${Math.round(c.high!)}`]) : null,
    ]),
    el('div', { class: 'sub' }, [c.sub]),
    el('div', { class: 'meter' }, [el('i', { style: `width:${meterPct}%` })]),
  ]);
}

function visibilityBlock(ctx: AppContext, d: PulseData): HTMLElement {
  if (!d.score) {
    // The honest version of the panel this replaces, which rendered the
    // label and an explanation of why it was empty and offered nothing to do
    // about it. A block with no source shows what would fill it.
    return el('section', { class: 'panel' }, [
      el('header', {}, [
        el('h3', {}, [screenName('visibility')]),
        el('a', { class: 'more', href: '#/visibility' }, ['Open Visibility →']),
      ]),
      el('div', { class: 'gm-empty' }, [
        el('p', {}, [
          'How often this site is found in search and named in AI answers. It fills once keywords are tracked and AI prompts are sampled.',
        ]),
        el('button', { class: 'btn primary', onclick: () => ctx.navigate('visibility/rankings') }, ['Track a keyword']),
      ]),
    ]);
  }

  const score = d.score;
  const b = bandPositions(score);
  return el('section', { class: 'panel hero' }, [
    el('header', {}, [
      el('h3', {}, [screenName('visibility')]),
      el('a', { class: 'more', href: '#/visibility' }, ['Open Visibility →']),
    ]),
    el('div', { class: 'scorewrap' }, [
      el('div', { class: 'score num' }, [String(score.point)]),
      el('div', { class: 'band' }, [
        el(
          'div',
          { class: 'band-track', title: 'We report AI-influenced metrics as a range, never a false point.' },
          [el('i', { style: `left:${b.leftPct}%;right:${b.rightPct}%` }), el('b', { style: `left:${b.tickPct}%` })],
        ),
        el('div', { class: 'band-nums' }, [
          el('span', {}, [String(score.low)]),
          el('span', {}, [String(score.high)]),
        ]),
      ]),
    ]),
    el('div', { class: 'contrib' }, d.contributions.map(contributionCell)),
  ]);
}

/* ── Search Console and Analytics ─────────────────────────────────────────── */

/**
 * One headline figure with its change against the previous period.
 *
 * `invert` is for average position, where a lower number is the good
 * direction. Without it a site climbing from 14 to 9 would be shown in red.
 */
function stat(
  label: string,
  value: string,
  current: number,
  previous: number | null | undefined,
  opts: { invert?: boolean; hover?: HoverCardContent } = {},
): HTMLElement {
  const change = pctChange(current, previous);
  let sub: HTMLElement;
  if (previous === null || previous === undefined) {
    sub = el('div', { class: 'sub' }, ['no comparison yet']);
  } else if (change === null) {
    sub = el('div', { class: 'sub' }, [current > 0 ? 'up from 0' : 'no change']);
  } else {
    const good = opts.invert ? change < 0 : change > 0;
    const cls = change === 0 ? 'delta flat' : good ? 'delta' : 'delta down';
    sub = el('div', { class: 'sub' }, [el('span', { class: cls }, [fmtChange(change)]), ' vs previous 28 days']);
  }
  return el('div', { class: 'cell' }, [
    el('div', { class: 'top' }, [el('h4', {}, [label, opts.hover ? infoCard(`About ${label}`, opts.hover) : null])]),
    el('div', { class: 'v num' }, [value]),
    sub,
  ]);
}

/** A small filled line of one series, no axes: the shape of the period at a glance. */
function sparkline(points: DailyPoint[], label: string): SVGElement | null {
  if (points.length < 2) return null;
  const series = points.map((p) => p.value);
  const w = 600;
  const h = 56;
  const markup =
    `<svg class="spark gm-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${label}">` +
    `<path class="area" d="${sparklineArea(series, w, h)}"></path>` +
    `<path class="line" d="${sparklinePath(series, w, h)}"></path></svg>`;
  return svg(markup);
}

function sectionHead(title: string, hover?: HoverCardContent): HTMLElement {
  return el('div', { class: 'gm-sec' }, [title, hover ? infoCard(`What ${title.toLowerCase()} means`, hover) : null]);
}

function metricCell(text: string, strong?: string): HTMLElement {
  return el('span', { class: 'n' }, [strong ? el('b', {}, [strong]) : null, strong ? ` ${text}` : text]);
}

function panelHead(title: string, source: string, summary: { current: { to: string }; syncedAt: string | null } | null): HTMLElement {
  const meta = summary
    ? `28 days to ${summary.current.to} · synced ${relativeTime(summary.syncedAt)}`
    : source;
  return el('header', { class: 'gm-head' }, [
    el('div', {}, [el('h3', {}, [title]), el('div', { class: 'gm-src' }, [source])]),
    el('span', { class: 'num' }, [meta]),
  ]);
}

function nextStepPanel(ctx: AppContext, status: ProviderStatus, providerName: string, dataNoun: string): HTMLElement {
  const step = providerNextStep(status, providerName, dataNoun);
  return el('div', { class: 'gm-empty' }, [
    el('p', {}, [step.line]),
    step.action ? el('button', { class: 'btn primary', onclick: () => ctx.navigate('integrations') }, [step.button ?? '']) : null,
  ]);
}

const KEY_EVENTS_HOVER: HoverCardContent = {
  title: 'Key events',
  body: [
    'The actions this Analytics property counts as important: a form sent, a sign-up, a purchase. Google Analytics used to call these conversions.',
    'Which actions count is set inside Google Analytics, not here.',
  ],
};

const WITHIN_REACH_HOVER: HoverCardContent = {
  title: 'Queries within reach',
  body: [
    'Searches this site already shows up for on page one or two (average position 4 to 20), seen at least ten times in the period, that are not the brand name.',
    'Moving one of these a few places brings clicks the site is already close to. They are the natural list to track and write for.',
  ],
};

const BRAND_HOVER: HoverCardContent = {
  title: 'Brand searches',
  body: ['Queries that contain the brand or domain name. People searching for the brand were going to find it anyway, so these are listed but not counted as opportunities.'],
};

function searchPanel(ctx: AppContext, s: SearchSummary | null, status: ProviderStatus): HTMLElement {
  const name = 'Google Search Console';
  if (!s) {
    return el('section', { class: 'panel gm' }, [
      panelHead('Search', name, null),
      nextStepPanel(ctx, status, name, 'clicks, impressions and the queries that bring people to this site'),
    ]);
  }
  const prev = s.previousTotals;
  const stats = el('div', { class: 'gm-stats' }, [
    stat('Clicks', fmtInt(s.totals.clicks), s.totals.clicks, prev?.clicks),
    stat('Impressions', fmtInt(s.totals.impressions), s.totals.impressions, prev?.impressions),
    stat('Average position', fmtPosition(s.totals.position), s.totals.position, prev?.position, { invert: true }),
    stat('Click-through rate', fmtRatio(s.totals.ctr), s.totals.ctr, prev?.ctr),
  ]);

  // The tag sits in a fixed slot so the metric columns line up whether or
  // not a row carries it.
  const queryRow = (q: SearchSummary['topQueries'][number]) =>
    el('div', { class: 'gm-row' }, [
      el('span', { class: 't', title: q.query }, [q.query]),
      el('span', { class: 'slot' }, [q.brand ? el('span', { class: 'tagband' }, ['brand']) : null]),
      metricCell('clicks', fmtInt(q.clicks)),
      metricCell('impr.', fmtInt(q.impressions)),
      metricCell('pos.', fmtPosition(q.position)),
    ]);

  const pageRow = (p: SearchSummary['topPages'][number]) =>
    el('div', { class: 'gm-row' }, [
      el('span', { class: 't', title: p.page }, [pagePath(p.page)]),
      metricCell('clicks', fmtInt(p.clicks)),
      metricCell('impr.', fmtInt(p.impressions)),
      metricCell('pos.', fmtPosition(p.position)),
    ]);

  return el('section', { class: 'panel gm' }, [
    panelHead('Search', name, s),
    stats,
    s.totalsSource === 'queries'
      ? el('div', { class: 'gm-note' }, [
          'Totals are summed from query rows until the next sync. Search Console’s own figure is higher because it includes searches Google anonymises.',
        ])
      : null,
    sparkline(s.dailyClicks, 'Clicks per day'),
    sectionHead('Top queries', s.topQueries.some((q) => q.brand) ? BRAND_HOVER : undefined),
    s.topQueries.length > 0
      ? el('div', { class: 'gm-list' }, s.topQueries.map(queryRow))
      : el('div', { class: 'gm-note' }, ['No query rows in this period.']),
    sectionHead('Queries within reach', WITHIN_REACH_HOVER),
    s.withinReach.length > 0
      ? el('div', { class: 'gm-list' }, s.withinReach.map(queryRow))
      : el('div', { class: 'gm-note' }, [
          `None yet. ${fmtInt(s.queryCount)} queries appeared in the period; none outside the brand name sits on page one or two with ten or more impressions.`,
        ]),
    sectionHead('Top pages'),
    s.pagesSynced
      ? el('div', { class: 'gm-list' }, s.topPages.map(pageRow))
      : el('div', { class: 'gm-note' }, ['Page figures arrive with the next sync.']),
  ]);
}

function trafficPanel(ctx: AppContext, t: TrafficSummary | null, status: ProviderStatus): HTMLElement {
  const name = 'Google Analytics';
  if (!t) {
    return el('section', { class: 'panel gm' }, [
      panelHead('Traffic', name, null),
      nextStepPanel(ctx, status, name, 'visits by channel, including visits from AI assistants'),
    ]);
  }
  const prev = t.previousTotals;
  const stats = el('div', { class: 'gm-stats three' }, [
    stat('Sessions', fmtInt(t.totals.sessions), t.totals.sessions, prev?.sessions),
    stat('Engaged sessions', fmtInt(t.totals.engagedSessions), t.totals.engagedSessions, prev?.engagedSessions),
    stat('Key events', fmtInt(t.totals.keyEvents), t.totals.keyEvents, prev?.keyEvents, { hover: KEY_EVENTS_HOVER }),
  ]);

  const max = Math.max(1, ...t.channels.map((c) => c.sessions));
  const channelRow = (c: TrafficSummary['channels'][number]) =>
    el('div', { class: 'gm-row' }, [
      el('span', { class: 't fixed', title: c.label }, [c.label]),
      el('span', { class: `gm-bar${c.key === 'ai-assistants' ? ' ai' : ''}` }, [
        el('i', { style: `width:${Math.max(1, Math.round((c.sessions / max) * 100))}%` }),
      ]),
      metricCell('sessions', fmtInt(c.sessions)),
      metricCell('key events', fmtInt(c.keyEvents)),
    ]);

  // Two metrics, not three: this column is the narrow one, and a third
  // figure pushed the source name out of its own row.
  const aiRow = (a: TrafficSummary['aiAssistants'][number]) =>
    el('div', { class: 'gm-row' }, [
      el('span', { class: 't', title: a.source }, [
        a.source,
        a.classifiedBy === 'engine'
          ? el('span', { class: 'tagband' }, [
              'added by Engine',
              infoCard('Why this source is listed', {
                body: [
                  'Google Analytics left this referrer unclassified. Engine keeps a list of known AI assistants and counts it here, so the figure above includes it.',
                ],
              }),
            ])
          : null,
      ]),
      metricCell('sessions', fmtInt(a.sessions)),
      metricCell('key events', fmtInt(a.keyEvents)),
    ]);

  return el('section', { class: 'panel gm' }, [
    panelHead('Traffic', name, t),
    stats,
    sparkline(t.dailySessions, 'Sessions per day'),
    sectionHead('Where visits come from'),
    el('div', { class: 'gm-list' }, t.channels.map(channelRow)),
    sectionHead('Visits from AI assistants', {
      title: 'AI assistants',
      body: [
        'People who arrived from ChatGPT, Claude, Perplexity, Gemini and similar tools. Google Analytics groups most of these itself; the ones it leaves unclassified are added from a list Engine keeps, and are tagged.',
        'This is who clicked through. It does not show how often an assistant mentioned the site without a click.',
      ],
    }),
    t.aiAssistants.length > 0
      ? el('div', { class: 'gm-list' }, t.aiAssistants.map(aiRow))
      : el('div', { class: 'gm-note' }, ['No visits from AI assistants in this period.']),
  ]);
}

/* ── The view ─────────────────────────────────────────────────────────────── */

interface HomeData {
  audit: AuditData | null;
  auditError: string | null;
  actions: ActionCard[];
  pulse: PulseData | null;
  searchTraffic: SearchTraffic | null;
  searchTrafficError: string | null;
  crawl: ApiAuditRequest | null;
}

export async function homeView(ctx: AppContext): Promise<HTMLElement> {
  const container = el('div', {});
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  async function load(): Promise<void> {
    // Every source is settled independently. One unreachable route must not
    // blank the whole screen: a site with no Analytics connection still has
    // a health score worth showing, and the reverse is just as true.
    const [audit, actions, pulse, st, crawl] = await Promise.allSettled([
      fetchAudit(),
      fetchActions(),
      fetchPulse(),
      fetchSearchTraffic(),
      fetchLatestAuditRequest(),
    ]);
    render({
      audit: audit.status === 'fulfilled' ? audit.value : null,
      auditError: audit.status === 'rejected' ? readableError(audit.reason) : null,
      actions: actions.status === 'fulfilled' ? actions.value : [],
      pulse: pulse.status === 'fulfilled' ? pulse.value : null,
      searchTraffic: st.status === 'fulfilled' ? st.value : null,
      searchTrafficError: st.status === 'rejected' ? readableError(st.reason) : null,
      crawl: crawl.status === 'fulfilled' ? crawl.value : null,
    });
  }

  function schedulePoll(crawl: ApiAuditRequest | null): void {
    if (pollTimer) clearTimeout(pollTimer);
    if (crawl?.status !== 'queued' && crawl?.status !== 'running') return;
    pollTimer = setTimeout(() => {
      // The view may have been replaced by another route since the timer was set.
      if (container.isConnected) void load();
    }, POLL_MS);
  }

  function render(d: HomeData): void {
    const crawling = d.crawl?.status === 'queued' || d.crawl?.status === 'running';
    const summary = homeSummary({
      auditUnavailable: d.audit === null,
      healthScore: d.audit?.healthScore ?? null,
      findingCount: d.audit?.findings.length ?? 0,
      pagesAudited: d.audit?.pagesAudited ?? null,
      fixesReady: d.actions.filter((a) => a.status === 'proposed').length,
      lastRunAt: d.audit?.lastRunAt ?? null,
      crawl: d.crawl ? { status: d.crawl.status, rootUrl: d.crawl.rootUrl } : null,
    });

    const google = d.searchTraffic
      ? el('div', { class: 'grid gm-grid' }, [
          searchPanel(ctx, d.searchTraffic.search, d.searchTraffic.connections.gsc),
          trafficPanel(ctx, d.searchTraffic.traffic, d.searchTraffic.connections.ga4),
        ])
      : el('section', { class: 'panel' }, [
          el('div', { class: 'fq-note' }, [`Could not load search and traffic figures: ${d.searchTrafficError}`]),
        ]);

    container.replaceChildren(
      el('div', { class: 'stack' }, [
        el('div', { class: 'pagehead' }, [el('h1', {}, [screenName('home')]), el('p', {}, [summary])]),
        d.audit === null
          ? el('section', { class: 'panel' }, [
              el('div', { class: 'fq-note' }, [`Could not load the audit: ${d.auditError}`]),
            ])
          : d.audit.lastRunAt === null && !crawling
            ? firstRunBlock(ctx, d.crawl, load)
            : healthBlock(ctx, d.audit, crawling),
        d.audit ? topIssuesBlock(ctx, d.audit) : null,
        fixesBlock(ctx, d.actions),
        d.pulse ? visibilityBlock(ctx, d.pulse) : null,
        google,
      ]),
    );
    schedulePoll(d.crawl);
  }

  await load();
  return container;
}
