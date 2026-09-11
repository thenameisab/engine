/**
 * What Pulse reads from the synced Google tables.
 *
 * Migration 0015 landed the tables and nothing read them: a connect flow that
 * reported success and a product that did not change. This module is the read
 * side. It answers two customer questions from stored rows, never from a live
 * Google call: "what is search doing for this site" (Search Console) and
 * "where do visits come from, and how many from AI assistants" (Analytics).
 *
 * Every number here is a 28-day period compared with the 28 days before it,
 * ending on the latest day the sync stored. The comparison is present only
 * when the previous period is actually covered; a delta computed against a
 * half-empty period would look like a collapse.
 *
 * The SQL is thin. Aggregation that decides what a customer sees (brand
 * detection, "within reach", AI-assistant classification) is in pure functions
 * below so it is unit-tested against real rows, not just executed.
 */
import type { Db } from '../db.js';
import { dayOffset, daysInclusive } from './googleSync.js';

export interface Period {
  from: string;
  to: string;
}

/** The current period ending on `latest`, and the equal-length one before it. */
export function periodsEndingAt(latest: string, days = 28): { current: Period; previous: Period } {
  const end = new Date(`${latest}T00:00:00Z`);
  const current = { from: dayOffset(end, -(days - 1)), to: latest };
  const previous = { from: dayOffset(end, -(2 * days - 1)), to: dayOffset(end, -days) };
  return { current, previous };
}

/* ── Brand detection ──────────────────────────────────────────────────────── */

/**
 * The words that mean "this brand", from the site's domain and its entity
 * names. `tartanhq.com` and the entity `TartanHQ` both yield `tartanhq`.
 * Anything under four characters is dropped: `hq` alone would flag every
 * query that happens to contain it.
 */
export function brandTerms(domain: string, names: readonly string[]): string[] {
  const terms = new Set<string>();
  const host = domain.toLowerCase().replace(/^www\./, '');
  const label = host.split('.')[0] ?? '';
  const normalizedLabel = label.replace(/[^a-z0-9]/g, '');
  if (normalizedLabel.length >= 4) terms.add(normalizedLabel);
  for (const name of names) {
    const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (normalized.length >= 4) terms.add(normalized);
  }
  return [...terms];
}

/**
 * Whether a query is someone looking for the brand rather than for what it
 * sells. Two tests: the query with spaces removed contains a brand term
 * (`tartan hq` → `tartanhq`), or a query word of four or more characters is
 * the start of a brand term (`tartan` starts `tartanhq`). The second catches
 * the shortened form people actually type; it does not catch misspellings,
 * and does not try to.
 */
export function isBrandQuery(query: string, terms: readonly string[]): boolean {
  const lower = query.toLowerCase();
  const squashed = lower.replace(/[^a-z0-9]/g, '');
  const words = lower.split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
  return terms.some((term) => squashed.includes(term) || words.some((w) => term.startsWith(w)));
}

/* ── Search Console ───────────────────────────────────────────────────────── */

export interface SearchTotals {
  clicks: number;
  impressions: number;
  /** 0..1, as Google reports it. */
  ctr: number;
  /** Impression-weighted average position over the period. */
  position: number;
}

export interface SearchQueryRow extends SearchTotals {
  query: string;
  brand: boolean;
}

export interface SearchPageRow extends SearchTotals {
  page: string;
}

export interface DailyPoint {
  date: string;
  value: number;
}

export interface SyncState {
  resourceId: string | null;
  syncedAt: string | null;
  syncError: string | null;
}

export interface SearchSummary extends SyncState {
  current: Period;
  previous: Period;
  hasPrevious: boolean;
  totals: SearchTotals;
  previousTotals: SearchTotals | null;
  /**
   * 'property' once the date-only totals (migration 0023) have synced;
   * 'queries' before that, when the headline is a sum over query rows and
   * therefore lower than Search Console's own figure.
   */
  totalsSource: 'property' | 'queries';
  dailyClicks: DailyPoint[];
  topQueries: SearchQueryRow[];
  /**
   * Non-brand queries the site already appears for, on page one or two but
   * not at the top: position 4 to 20 with at least ten impressions in the
   * period. These are the terms worth tracking and writing for, and the
   * natural seed list for scheduled rank tracking.
   */
  withinReach: SearchQueryRow[];
  topPages: SearchPageRow[];
  queryCount: number;
  pagesSynced: boolean;
}

export interface TotalsRow {
  clicks: string | number | null;
  impressions: string | number | null;
  position: string | number | null;
}

export function toTotals(row: TotalsRow | undefined): SearchTotals {
  const clicks = Number(row?.clicks ?? 0);
  const impressions = Number(row?.impressions ?? 0);
  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : 0,
    position: Number(row?.position ?? 0),
  };
}

/** Pick the top ten by clicks, then impressions. Ties broken by name so the order is stable. */
export function topByClicks<T extends SearchTotals>(rows: readonly T[], n = 10): T[] {
  return [...rows]
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
    .slice(0, n);
}

export const WITHIN_REACH = { minPosition: 4, maxPosition: 20, minImpressions: 10 } as const;

/**
 * The queries a site could win: not brand, already ranking on page one or
 * two, seen at least ten times in the period. Sorted by impressions, because
 * impressions are the demand the site is already visible for.
 */
export function withinReach(rows: readonly SearchQueryRow[], n = 10): SearchQueryRow[] {
  return rows
    .filter(
      (r) =>
        !r.brand &&
        r.position >= WITHIN_REACH.minPosition &&
        r.position <= WITHIN_REACH.maxPosition &&
        r.impressions >= WITHIN_REACH.minImpressions,
    )
    .sort((a, b) => b.impressions - a.impressions || a.position - b.position)
    .slice(0, n);
}

export async function searchSummary(
  db: Db,
  projectId: string,
  terms: readonly string[],
  state: SyncState,
): Promise<SearchSummary | null> {
  const [latestRow] = await db<{ latest: string | null; property: string | null }[]>`
    select
      greatest(
        (select max(date) from gsc_site_daily where project_id::text = ${projectId}),
        (select max(date) from gsc_query_daily where project_id::text = ${projectId})
      )::text as latest,
      (select max(date) from gsc_site_daily where project_id::text = ${projectId})::text as property
  `;
  if (!latestRow?.latest) return null;
  const { current, previous } = periodsEndingAt(latestRow.latest);
  const totalsSource: SearchSummary['totalsSource'] = latestRow.property ? 'property' : 'queries';
  const table = totalsSource === 'property' ? 'gsc_site_daily' : 'gsc_query_daily';

  const totalsFor = async (p: Period) => {
    const [row] = await db<TotalsRow[]>`
      select sum(clicks) as clicks, sum(impressions) as impressions,
             sum(position * impressions) / nullif(sum(impressions), 0) as position
      from ${db(table)} where project_id::text = ${projectId} and date between ${p.from} and ${p.to}
    `;
    return row;
  };

  const [currentTotals, previousTotals, coverage, daily, byClicks, byImpressions, pages, count] = await Promise.all([
    totalsFor(current),
    totalsFor(previous),
    db<{ lo: string | null }[]>`
      select min(date)::text as lo from ${db(table)} where project_id::text = ${projectId}
    `,
    db<{ date: string; clicks: string | number }[]>`
      select date::text as date, sum(clicks) as clicks from ${db(table)}
      where project_id::text = ${projectId} and date between ${current.from} and ${current.to}
      group by date order by date
    `,
    db<(TotalsRow & { query: string })[]>`
      select query, sum(clicks) as clicks, sum(impressions) as impressions,
             sum(position * impressions) / nullif(sum(impressions), 0) as position
      from gsc_query_daily where project_id::text = ${projectId} and date between ${current.from} and ${current.to}
      group by query order by sum(clicks) desc, sum(impressions) desc, query limit 10
    `,
    db<(TotalsRow & { query: string })[]>`
      select query, sum(clicks) as clicks, sum(impressions) as impressions,
             sum(position * impressions) / nullif(sum(impressions), 0) as position
      from gsc_query_daily where project_id::text = ${projectId} and date between ${current.from} and ${current.to}
      group by query having sum(impressions) >= ${WITHIN_REACH.minImpressions}
      order by sum(impressions) desc, query limit 300
    `,
    db<(TotalsRow & { page: string })[]>`
      select page, sum(clicks) as clicks, sum(impressions) as impressions,
             sum(position * impressions) / nullif(sum(impressions), 0) as position
      from gsc_page_daily where project_id::text = ${projectId} and date between ${current.from} and ${current.to}
      group by page order by sum(clicks) desc, sum(impressions) desc, page limit 10
    `,
    db<{ n: string | number }[]>`
      select count(distinct query) as n from gsc_query_daily
      where project_id::text = ${projectId} and date between ${current.from} and ${current.to}
    `,
  ]);

  const hasPrevious = coverage[0]?.lo !== null && coverage[0]?.lo !== undefined && coverage[0].lo <= previous.from;
  const toQueryRow = (r: TotalsRow & { query: string }): SearchQueryRow => ({
    query: r.query,
    ...toTotals(r),
    brand: isBrandQuery(r.query, terms),
  });

  return {
    ...state,
    current,
    previous,
    hasPrevious,
    totals: toTotals(currentTotals),
    previousTotals: hasPrevious ? toTotals(previousTotals) : null,
    totalsSource,
    dailyClicks: daily.map((d) => ({ date: d.date, value: Number(d.clicks) })),
    topQueries: byClicks.map(toQueryRow),
    withinReach: withinReach(byImpressions.map(toQueryRow)),
    topPages: pages.map((r) => ({ page: r.page, ...toTotals(r) })),
    queryCount: Number(count[0]?.n ?? 0),
    pagesSynced: pages.length > 0,
  };
}

/* ── Analytics ────────────────────────────────────────────────────────────── */

/**
 * Referrers that are AI assistants but that GA4 does not (yet) put in its
 * "AI Assistant" channel group. Observed on a real property in September
 * 2026: `copilot.com` landed in Unassigned while chatgpt.com, claude.ai,
 * perplexity.ai and gemini.google.com were classified by GA4 itself. The list
 * is a supplement to GA4's own grouping, and the response says which of the
 * two classified each source, so the product never claims a channel GA4 does
 * not report.
 */
export const AI_ASSISTANT_SOURCES: readonly string[] = [
  'chatgpt.com',
  'chat.openai.com',
  'openai.com',
  'claude.ai',
  'anthropic.com',
  'perplexity.ai',
  'gemini.google.com',
  'bard.google.com',
  'copilot.com',
  'copilot.microsoft.com',
  'meta.ai',
  'grok.com',
  'x.ai',
  'deepseek.com',
  'chat.deepseek.com',
  'mistral.ai',
  'chat.mistral.ai',
  'you.com',
  'phind.com',
  'poe.com',
  'kagi.com',
  'duckduckgo.com/aichat',
];

/** GA4's own channel group for AI referrers, as the Data API names it. */
export const GA4_AI_CHANNEL = 'AI Assistant';

/**
 * How a (channel group, source) pair is known to be an AI assistant:
 * GA4 said so, Engine's list says so, or neither.
 */
export function classifyAiSource(channelGroup: string, source: string): 'ga4' | 'engine' | null {
  if (channelGroup === GA4_AI_CHANNEL) return 'ga4';
  const host = source.toLowerCase().replace(/^www\./, '').replace(/\/+$/, '');
  return AI_ASSISTANT_SOURCES.some((s) => host === s || host.endsWith(`.${s}`)) ? 'engine' : null;
}

export const AI_CHANNEL_KEY = 'ai-assistants';

/**
 * Channel names in the customer's words. GA4's names are mostly already that;
 * the two changed here are the ones a customer without an Analytics
 * background misreads: "Cross-network" is Google Ads, and "Unassigned" is
 * traffic GA4 could not classify.
 */
export function channelLabel(group: string): string {
  switch (group) {
    case AI_CHANNEL_KEY:
      return 'AI assistants';
    case 'Cross-network':
      return 'Google Ads (cross-network)';
    case 'Unassigned':
      return 'Unclassified';
    case '(not set)':
      return 'Unclassified';
    default:
      return group;
  }
}

export interface TrafficTotals {
  sessions: number;
  engagedSessions: number;
  /** GA4's key events (the metric it used to call conversions). */
  keyEvents: number;
}

export interface TrafficChannel extends TrafficTotals {
  key: string;
  label: string;
}

export interface AiSource extends TrafficTotals {
  source: string;
  classifiedBy: 'ga4' | 'engine';
}

export interface TrafficSummary extends SyncState {
  current: Period;
  previous: Period;
  hasPrevious: boolean;
  totals: TrafficTotals;
  previousTotals: TrafficTotals | null;
  dailySessions: DailyPoint[];
  /** Every channel in the period, AI assistants pulled out as their own channel, sorted by sessions. */
  channels: TrafficChannel[];
  aiAssistants: AiSource[];
}

interface ChannelSourceRow {
  channel_group: string;
  source: string;
  sessions: string | number;
  engaged_sessions: string | number;
  conversions: string | number;
}

/**
 * Fold (channel, source) rows into channels, moving every AI-assistant source
 * into one channel whichever group GA4 put it in. Pure, so the real
 * September 2026 rows are the test fixture.
 */
export function foldChannels(rows: readonly ChannelSourceRow[]): { channels: TrafficChannel[]; aiAssistants: AiSource[] } {
  const channels = new Map<string, TrafficChannel>();
  const ai = new Map<string, AiSource>();
  const add = (target: TrafficTotals, row: ChannelSourceRow) => {
    target.sessions += Number(row.sessions);
    target.engagedSessions += Number(row.engaged_sessions);
    target.keyEvents += Number(row.conversions);
  };
  for (const row of rows) {
    const classified = classifyAiSource(row.channel_group, row.source);
    const key = classified ? AI_CHANNEL_KEY : row.channel_group;
    const channel = channels.get(key) ?? {
      key,
      label: channelLabel(key),
      sessions: 0,
      engagedSessions: 0,
      keyEvents: 0,
    };
    add(channel, row);
    channels.set(key, channel);
    if (classified) {
      const source = ai.get(row.source) ?? {
        source: row.source,
        classifiedBy: classified,
        sessions: 0,
        engagedSessions: 0,
        keyEvents: 0,
      };
      add(source, row);
      ai.set(row.source, source);
    }
  }
  const bySessions = (a: TrafficTotals, b: TrafficTotals) => b.sessions - a.sessions;
  return {
    channels: [...channels.values()].sort(bySessions),
    aiAssistants: [...ai.values()].sort(bySessions),
  };
}

interface TrafficTotalsRow {
  sessions: string | number | null;
  engaged_sessions: string | number | null;
  conversions: string | number | null;
}

function toTrafficTotals(row: TrafficTotalsRow | undefined): TrafficTotals {
  return {
    sessions: Number(row?.sessions ?? 0),
    engagedSessions: Number(row?.engaged_sessions ?? 0),
    keyEvents: Number(row?.conversions ?? 0),
  };
}

export async function trafficSummary(db: Db, projectId: string, state: SyncState): Promise<TrafficSummary | null> {
  const [latestRow] = await db<{ latest: string | null; lo: string | null }[]>`
    select max(date)::text as latest, min(date)::text as lo from ga4_channel_daily where project_id::text = ${projectId}
  `;
  if (!latestRow?.latest) return null;
  const { current, previous } = periodsEndingAt(latestRow.latest);
  const hasPrevious = latestRow.lo !== null && latestRow.lo <= previous.from;

  const totalsFor = async (p: Period) => {
    const [row] = await db<TrafficTotalsRow[]>`
      select sum(sessions) as sessions, sum(engaged_sessions) as engaged_sessions, sum(conversions) as conversions
      from ga4_channel_daily where project_id::text = ${projectId} and date between ${p.from} and ${p.to}
    `;
    return row;
  };

  const [currentTotals, previousTotals, daily, grouped] = await Promise.all([
    totalsFor(current),
    totalsFor(previous),
    db<{ date: string; sessions: string | number }[]>`
      select date::text as date, sum(sessions) as sessions from ga4_channel_daily
      where project_id::text = ${projectId} and date between ${current.from} and ${current.to}
      group by date order by date
    `,
    db<ChannelSourceRow[]>`
      select channel_group, source, sum(sessions) as sessions, sum(engaged_sessions) as engaged_sessions,
             sum(conversions) as conversions
      from ga4_channel_daily where project_id::text = ${projectId} and date between ${current.from} and ${current.to}
      group by channel_group, source
    `,
  ]);

  return {
    ...state,
    current,
    previous,
    hasPrevious,
    totals: toTrafficTotals(currentTotals),
    previousTotals: hasPrevious ? toTrafficTotals(previousTotals) : null,
    dailySessions: daily.map((d) => ({ date: d.date, value: Number(d.sessions) })),
    ...foldChannels(grouped),
  };
}
