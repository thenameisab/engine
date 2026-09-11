/**
 * The six tools backed by synced Google data.
 *
 * Every definition these tools depend on — what counts as a brand query, what
 * "within reach" means, which referrers are AI assistants, how click-through
 * rate and average position are derived rather than summed — is imported from
 * `googleMetrics.ts`, which is what Pulse reads. Restating any of them here
 * would give the product two answers to the same question, and the one Driver
 * quotes in a sentence would drift from the one the screen shows in a panel.
 *
 * What is not shared is the query shape. `searchSummary` answers one fixed
 * question — the last 28 days, top ten — because that is what Pulse renders.
 * A tool takes a period and a limit from the model, so the SQL is written here
 * and the *meaning* is imported.
 *
 * All six are `not-connected` on a new account. §9a decision 6 ships Driver
 * with no gate on Google data, so that branch is the common case early on and
 * `googleReadiness` is what keeps it from reading as "your site has no traffic".
 */
import type { ToolResult } from '@engine/driver';
import { listAssignments, listConnections } from '../repositories/integrations.js';
import { listEntitiesByProject } from '../repositories/entities.js';
import {
  AI_CHANNEL_KEY,
  brandTerms,
  channelLabel,
  foldChannels,
  isBrandQuery,
  toTotals,
  WITHIN_REACH,
  type SearchTotals,
  type TotalsRow,
} from '../repositories/googleMetrics.js';
import {
  blockedResult,
  boolArg,
  googleReadiness,
  intArg,
  noDataYet,
  ok,
  periodEndingAt,
  precedingPeriod,
  strArg,
  zero,
  type DriverToolContext,
  type GoogleProvider,
  type ToolHandler,
} from './context.js';

/**
 * Connection state plus the latest day the relevant table holds.
 *
 * One round trip for both, because every Google tool needs both and a tool that
 * makes four sequential queries to answer one question spends the loop's
 * wall-clock budget on plumbing.
 */
async function googleGate(
  ctx: DriverToolContext,
  provider: GoogleProvider,
  latestDate: () => Promise<string | null>,
): Promise<
  | { ready: false; result: ToolResult<Record<string, never>> }
  | { ready: true; latest: string; syncedAt: string | null; resourceLabel: string | null }
> {
  const tables = provider === 'gsc' ? ['gsc_site_daily'] : ['ga4_channel_daily'];
  const [connections, assignments] = await Promise.all([
    listConnections(ctx.db, ctx.accountId),
    listAssignments(ctx.db, ctx.projectId),
  ]);
  const readiness = googleReadiness(provider, connections, assignments);
  if (readiness.blocked) {
    return { ready: false, result: blockedResult({}, tables, readiness.blocked) };
  }

  const latest = await latestDate();
  if (!latest) {
    // Connected, assigned, and the sync reported success — but this particular
    // table is empty. A sync that returned zero rows is a real outcome (a brand
    // new property, a property with no traffic at all), and it is still "no data
    // yet" rather than "zero clicks": there is no period to compute zero over.
    return {
      ready: false,
      result: noDataYet({}, { tables }, {
        reason:
          `${provider === 'gsc' ? 'Search Console' : 'Analytics'} has synced, but it returned no ` +
          'rows for this property, so there is nothing to report on yet.',
        action:
          'Check that the assigned property is the right one on the Integrations screen. A property ' +
          'with no traffic at all will stay empty until it has some.',
      }),
    };
  }

  return {
    ready: true,
    latest,
    syncedAt: readiness.syncedAt,
    resourceLabel: readiness.resourceLabel,
  };
}

/** The most recent day a table holds for this project. */
async function maxDate(ctx: DriverToolContext, table: string): Promise<string | null> {
  const [row] = await ctx.db<{ latest: string | null }[]>`
    select max(date)::text as latest from ${ctx.db(table)} where project_id::text = ${ctx.projectId}
  `;
  return row?.latest ?? null;
}

/** The brand vocabulary for this project: its domain plus its tracked entity names. */
async function termsFor(ctx: DriverToolContext): Promise<string[]> {
  const entities = await listEntitiesByProject(ctx.db, ctx.projectId);
  return brandTerms(
    ctx.domain,
    entities.map((e) => e.canonicalName),
  );
}

/** Whether a totals row is entirely empty, which is what separates `zero` from `ok`. */
function isEmpty(totals: SearchTotals): boolean {
  return totals.clicks === 0 && totals.impressions === 0;
}

/* ── search_performance ───────────────────────────────────────────────────── */

export const searchPerformance: ToolHandler = async (ctx, args) => {
  const days = intArg(args, 'days', 28);
  const compare = boolArg(args, 'compare', true);
  const tables = ['gsc_site_daily'];

  const gate = await googleGate(ctx, 'gsc', () => maxDate(ctx, 'gsc_site_daily'));
  if (!gate.ready) return gate.result;

  const period = periodEndingAt(gate.latest, days);
  const previous = precedingPeriod(period, days);

  const totalsFor = async (p: { from: string; to: string }) => {
    const [row] = await ctx.db<TotalsRow[]>`
      select sum(clicks) as clicks, sum(impressions) as impressions,
             sum(position * impressions) / nullif(sum(impressions), 0) as position
      from gsc_site_daily
      where project_id::text = ${ctx.projectId} and date between ${p.from} and ${p.to}
    `;
    return toTotals(row);
  };

  const [current, prior, coverage, daily] = await Promise.all([
    totalsFor(period),
    compare ? totalsFor(previous) : Promise.resolve(null),
    ctx.db<{ lo: string | null }[]>`
      select min(date)::text as lo from gsc_site_daily where project_id::text = ${ctx.projectId}
    `,
    ctx.db<{ date: string; clicks: string | number }[]>`
      select date::text as date, clicks from gsc_site_daily
      where project_id::text = ${ctx.projectId} and date between ${period.from} and ${period.to}
      order by date
    `,
  ]);

  // Only offer a comparison over a period the sync actually covers. A delta
  // computed against a half-synced period reads as a collapse.
  const lo = coverage[0]?.lo ?? null;
  const hasPrevious = compare && lo !== null && lo <= previous.from;

  const data = {
    period,
    totals: current,
    previous: hasPrevious ? { period: previous, totals: prior } : null,
    comparisonOmittedBecause: compare && !hasPrevious ? 'the preceding period is not fully synced' : null,
    dailyClicks: daily.map((d) => ({ date: d.date, clicks: Number(d.clicks) })),
    property: gate.resourceLabel,
    lastSyncedAt: gate.syncedAt,
    note: 'Property-level totals as Search Console reports them. A sum over top_queries is lower, because Google withholds anonymised queries from the query dimension.',
  };
  const provenance = { tables, period };

  return isEmpty(current)
    ? zero(data, provenance, {
        reason: `Search Console holds data for this property but recorded no clicks or impressions between ${period.from} and ${period.to}.`,
        action: 'Try a longer period, or check the assigned property covers the site you expect.',
      })
    : ok(data, provenance);
};

/* ── top_queries ──────────────────────────────────────────────────────────── */

export const topQueries: ToolHandler = async (ctx, args) => {
  const days = intArg(args, 'days', 28);
  const max = intArg(args, 'limit', 10);
  const brand = strArg(args, 'brand') ?? 'all';
  const tables = ['gsc_query_daily'];

  const gate = await googleGate(ctx, 'gsc', () => maxDate(ctx, 'gsc_query_daily'));
  if (!gate.ready) return gate.result;

  const period = periodEndingAt(gate.latest, days);
  const [terms, rows] = await Promise.all([
    termsFor(ctx),
    // Over-fetch, because the brand split happens in `isBrandQuery` rather than
    // in SQL — the definition of a brand query lives in one place and it is not
    // this one. 500 is well past any limit the schema allows.
    ctx.db<(TotalsRow & { query: string })[]>`
      select query, sum(clicks) as clicks, sum(impressions) as impressions,
             sum(position * impressions) / nullif(sum(impressions), 0) as position
      from gsc_query_daily
      where project_id::text = ${ctx.projectId} and date between ${period.from} and ${period.to}
      group by query
      order by sum(clicks) desc, sum(impressions) desc, query
      limit 500
    `,
  ]);

  const all = rows.map((r) => ({ query: r.query, ...toTotals(r), brand: isBrandQuery(r.query, terms) }));
  const filtered =
    brand === 'only' ? all.filter((r) => r.brand) : brand === 'exclude' ? all.filter((r) => !r.brand) : all;
  const queries = filtered.slice(0, max);

  const data = {
    period,
    brandFilter: brand,
    queries,
    brandTermsUsed: terms,
    note: 'Anonymised queries are withheld by Google and are not in this list, so these clicks sum to less than search_performance.',
  };
  const provenance = { tables, period };

  if (queries.length > 0) return ok(data, provenance);

  return zero(data, provenance, {
    reason:
      all.length === 0
        ? `Search Console recorded no queries for this site between ${period.from} and ${period.to}.`
        : `Search Console recorded ${all.length} queries in this period, but none of them are ${brand === 'only' ? 'brand' : 'non-brand'} queries.`,
    action:
      all.length === 0
        ? 'Try a longer period.'
        : `Call top_queries with brand set to "all" to see the ${all.length} queries that do exist.`,
  });
};

/* ── top_pages ────────────────────────────────────────────────────────────── */

export const topPages: ToolHandler = async (ctx, args) => {
  const days = intArg(args, 'days', 28);
  const max = intArg(args, 'limit', 10);
  const tables = ['gsc_page_daily'];

  const gate = await googleGate(ctx, 'gsc', () => maxDate(ctx, 'gsc_page_daily'));
  if (!gate.ready) return gate.result;

  const period = periodEndingAt(gate.latest, days);
  const rows = await ctx.db<(TotalsRow & { page: string })[]>`
    select page, sum(clicks) as clicks, sum(impressions) as impressions,
           sum(position * impressions) / nullif(sum(impressions), 0) as position
    from gsc_page_daily
    where project_id::text = ${ctx.projectId} and date between ${period.from} and ${period.to}
    group by page
    order by sum(clicks) desc, sum(impressions) desc, page
    limit ${max}
  `;

  const pages = rows.map((r) => ({ page: r.page, ...toTotals(r) }));
  const data = { period, pages };
  const provenance = { tables, period };

  return pages.length > 0
    ? ok(data, provenance)
    : zero(data, provenance, {
        reason: `Search Console recorded no pages earning impressions between ${period.from} and ${period.to}.`,
        action: 'Try a longer period.',
      });
};

/* ── queries_within_reach ─────────────────────────────────────────────────── */

export const queriesWithinReach: ToolHandler = async (ctx, args) => {
  const days = intArg(args, 'days', 28);
  const max = intArg(args, 'limit', 10);
  const tables = ['gsc_query_daily'];

  const gate = await googleGate(ctx, 'gsc', () => maxDate(ctx, 'gsc_query_daily'));
  if (!gate.ready) return gate.result;

  const period = periodEndingAt(gate.latest, days);
  const [terms, rows] = await Promise.all([
    termsFor(ctx),
    ctx.db<(TotalsRow & { query: string })[]>`
      select query, sum(clicks) as clicks, sum(impressions) as impressions,
             sum(position * impressions) / nullif(sum(impressions), 0) as position
      from gsc_query_daily
      where project_id::text = ${ctx.projectId} and date between ${period.from} and ${period.to}
      group by query
      having sum(impressions) >= ${WITHIN_REACH.minImpressions}
      order by sum(impressions) desc, query
      limit 500
    `,
  ]);

  // `withinReach` from googleMetrics filters, sorts and slices in one call, but
  // it is hardcoded to exclude brand queries and to take ten. The thresholds are
  // what matter and they are imported; the limit is the model's.
  const candidates = rows.map((r) => ({
    query: r.query,
    ...toTotals(r),
    brand: isBrandQuery(r.query, terms),
  }));
  const queries = candidates
    .filter(
      (r) =>
        !r.brand &&
        r.position >= WITHIN_REACH.minPosition &&
        r.position <= WITHIN_REACH.maxPosition &&
        r.impressions >= WITHIN_REACH.minImpressions,
    )
    .sort((a, b) => b.impressions - a.impressions || a.position - b.position)
    .slice(0, max);

  const data = {
    period,
    queries,
    criteria: {
      positionBetween: [WITHIN_REACH.minPosition, WITHIN_REACH.maxPosition],
      minimumImpressions: WITHIN_REACH.minImpressions,
      brandQueriesExcluded: true,
    },
  };
  const provenance = { tables, period };

  return queries.length > 0
    ? ok(data, provenance)
    : zero(data, provenance, {
        reason: `No non-brand query sat between position ${WITHIN_REACH.minPosition} and ${WITHIN_REACH.maxPosition} with at least ${WITHIN_REACH.minImpressions} impressions between ${period.from} and ${period.to}.`,
        action:
          'Try a longer period. A site ranking either very well or not at all for its terms will have nothing in this range.',
      });
};

/* ── traffic_by_channel ───────────────────────────────────────────────────── */

interface ChannelSourceRow {
  channel_group: string;
  source: string;
  sessions: string | number;
  engaged_sessions: string | number;
  conversions: string | number;
}

/** The (channel, source) rows for a period, which both GA4 tools fold differently. */
async function channelRows(
  ctx: DriverToolContext,
  period: { from: string; to: string },
): Promise<ChannelSourceRow[]> {
  return ctx.db<ChannelSourceRow[]>`
    select channel_group, source, sum(sessions) as sessions,
           sum(engaged_sessions) as engaged_sessions, sum(conversions) as conversions
    from ga4_channel_daily
    where project_id::text = ${ctx.projectId} and date between ${period.from} and ${period.to}
    group by channel_group, source
  `;
}

export const trafficByChannel: ToolHandler = async (ctx, args) => {
  const days = intArg(args, 'days', 28);
  const tables = ['ga4_channel_daily'];

  const gate = await googleGate(ctx, 'ga4', () => maxDate(ctx, 'ga4_channel_daily'));
  if (!gate.ready) return gate.result;

  const period = periodEndingAt(gate.latest, days);
  const rows = await channelRows(ctx, period);
  const { channels } = foldChannels(rows);

  const data = {
    period,
    channels,
    property: gate.resourceLabel,
    lastSyncedAt: gate.syncedAt,
    note: `AI assistant traffic is pulled out as its own channel ("${channelLabel(AI_CHANNEL_KEY)}") whichever group GA4 put it in. Use ai_referral_traffic for the sources behind it.`,
  };
  const provenance = { tables, period };

  return channels.length > 0
    ? ok(data, provenance)
    : zero(data, provenance, {
        reason: `Analytics recorded no sessions for this property between ${period.from} and ${period.to}.`,
        action: 'Try a longer period, or check the assigned property on the Integrations screen.',
      });
};

/* ── ai_referral_traffic ──────────────────────────────────────────────────── */

export const aiReferralTraffic: ToolHandler = async (ctx, args) => {
  const days = intArg(args, 'days', 28);
  const tables = ['ga4_channel_daily'];

  const gate = await googleGate(ctx, 'ga4', () => maxDate(ctx, 'ga4_channel_daily'));
  if (!gate.ready) return gate.result;

  const period = periodEndingAt(gate.latest, days);
  const rows = await channelRows(ctx, period);
  const { channels, aiAssistants } = foldChannels(rows);

  const totalSessions = channels.reduce((sum, c) => sum + c.sessions, 0);
  const aiSessions = aiAssistants.reduce((sum, s) => sum + s.sessions, 0);

  const data = {
    period,
    sources: aiAssistants,
    totals: {
      sessions: aiSessions,
      shareOfAllSessions: totalSessions > 0 ? aiSessions / totalSessions : 0,
      allSessions: totalSessions,
    },
    note:
      'GA4 does not report AI assistants as a channel by default; that traffic lands in Referral or ' +
      'Organic Social depending on the referrer. Each source says which classified it: "ga4" means ' +
      "the property has its own AI Assistant channel group, \"engine\" means Engine recognised the " +
      'referring host.',
  };
  const provenance = { tables, period };

  if (aiAssistants.length > 0) return ok(data, provenance);

  // The distinction that matters here: a property with traffic but none of it
  // from assistants is a real zero and a useful answer. A property with no
  // traffic at all cannot say anything about assistants either way.
  return totalSessions > 0
    ? zero(data, provenance, {
        reason: `Analytics recorded ${totalSessions} sessions between ${period.from} and ${period.to}, and none of them came from a recognised AI assistant.`,
        action: 'This is a real measurement, not a gap. Track it over time rather than acting on one period.',
      })
    : zero(data, provenance, {
        reason: `Analytics recorded no sessions at all between ${period.from} and ${period.to}, so nothing can be said about AI assistant traffic in this period.`,
        action: 'Try a longer period, or check the assigned property on the Integrations screen.',
      });
};

/** Re-exported so the registry's import list is one line per group. */
export const GOOGLE_HANDLERS = {
  search_performance: searchPerformance,
  top_queries: topQueries,
  top_pages: topPages,
  queries_within_reach: queriesWithinReach,
  traffic_by_channel: trafficByChannel,
  ai_referral_traffic: aiReferralTraffic,
} satisfies Record<string, ToolHandler>;
