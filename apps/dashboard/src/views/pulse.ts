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
} from '../format.js';
import { fetchPulse, fetchSearchTraffic } from '../api.js';
import { infoCard, type HoverCardContent } from '../hovercard.js';
import { readableError } from '../errors.js';
import type { AppContext } from '../context.js';
import type {
  PulseData,
  ChannelContribution,
  SearchTraffic,
  SearchSummary,
  TrafficSummary,
  ProviderStatus,
  DailyPoint,
} from '../types.js';

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

function heroPanel(d: PulseData): HTMLElement {
  const score = d.score!; // caller only renders this when d.score is non-null
  const b = bandPositions(score);
  const track = el(
    'div',
    { class: 'band-track', title: 'We report AI-influenced metrics as a range, never a false point.' },
    [el('i', { style: `left:${b.leftPct}%;right:${b.rightPct}%` }), el('b', { style: `left:${b.tickPct}%` })],
  );

  return el('section', { class: 'panel hero' }, [
    el('div', { class: 'label' }, ['Unified Visibility Score']),
    el('div', { class: 'scorewrap' }, [
      el('div', { class: 'score num' }, [String(score.point)]),
      el('div', { class: 'band' }, [
        track,
        el('div', { class: 'band-nums' }, [
          el('span', {}, [String(score.low)]),
          el('span', {}, [String(score.high)]),
        ]),
      ]),
    ]),
    el('div', { class: 'hero-meta' }, [
      el('span', { class: 'num' }, ['organic + AI + local, weighted by your traffic mix']),
    ]),
    el('div', { class: 'contrib' }, d.contributions.map(contributionCell)),
  ]);
}

/**
 * The panel shown when the project has never been polled — the honest state
 * this view lacked entirely before: it always rendered `MOCK_PULSE`'s score
 * of 64, band 57–72, and three invented wins/risks for a site nothing had
 * measured. A project this genuinely new has neither, and 0 would read as
 * "zero visibility" rather than "nothing measured yet".
 */
function emptyPanel(): HTMLElement {
  return el('section', { class: 'panel hero' }, [
    el('div', { class: 'label' }, ['Unified Visibility Score']),
    el('div', { class: 'fq-note' }, [
      'No visibility data yet. The score appears once search rankings and AI answers have been ' +
        'sampled for this project’s keywords and prompts.',
    ]),
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

function summaryLine(d: PulseData, st: SearchTraffic | null): string {
  if (d.score) {
    return `Unified visibility is ${d.score.point} (${d.score.low}–${d.score.high}) across ${d.keywordsTracked} tracked keyword${d.keywordsTracked === 1 ? '' : 's'} and ${d.citationSamples} AI citation sample${d.citationSamples === 1 ? '' : 's'}.`;
  }
  const parts = ['Search rankings and AI answers have not been sampled for this site yet.'];
  if (st?.search || st?.traffic) parts.push('Search Console and Analytics figures are below.');
  return parts.join(' ');
}

export async function pulseView(ctx: AppContext): Promise<HTMLElement> {
  let data: PulseData | null = null;
  let loadError: string | null = null;
  let searchTraffic: SearchTraffic | null = null;
  let searchTrafficError: string | null = null;
  const [pulse, st] = await Promise.allSettled([fetchPulse(), fetchSearchTraffic()]);
  if (pulse.status === 'fulfilled') data = pulse.value;
  else {
    // Same rule as the Fix Queue and Audit views: an unreachable API is not
    // an empty Pulse, and this view will not invent a score to paper over
    // the difference.
    loadError = (pulse.reason as Error).message;
  }
  if (st.status === 'fulfilled') searchTraffic = st.value;
  else searchTrafficError = readableError(st.reason);

  if (!data) {
    return el('div', {}, [
      el('div', { class: 'pagehead' }, [el('h1', {}, ['Pulse'])]),
      el('section', { class: 'panel' }, [el('div', { class: 'fq-note' }, [`Could not load Pulse: ${loadError}`])]),
    ]);
  }

  const d = data;
  const google = searchTraffic
    ? el('div', { class: 'grid gm-grid' }, [
        searchPanel(ctx, searchTraffic.search, searchTraffic.connections.gsc),
        trafficPanel(ctx, searchTraffic.traffic, searchTraffic.connections.ga4),
      ])
    : el('section', { class: 'panel' }, [
        el('div', { class: 'fq-note' }, [`Could not load search and traffic figures: ${searchTrafficError}`]),
      ]);

  return el('div', { class: 'stack' }, [
    el('div', { class: 'pagehead' }, [el('h1', {}, ['Pulse']), el('p', {}, [summaryLine(d, searchTraffic)])]),
    d.score ? heroPanel(d) : emptyPanel(),
    google,
  ]);
}
