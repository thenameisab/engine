/**
 * Turning a connected provider into stored data (migration 0015).
 *
 * One module for both trigger paths. The on-demand route and the scheduled cron
 * job run the *same* functions — a scheduled sync that takes a different code
 * path from the button the user pressed is a second implementation to keep
 * correct, and the one nobody watches is the one that drifts.
 *
 * Every write is an upsert keyed on the natural grain, so re-syncing a day
 * overwrites rather than accumulates. That is not a nicety: a cron job that
 * fires twice would otherwise double every click count, and nothing about the
 * resulting number would look wrong.
 */
import {
  queryGscAll,
  ga4ChannelReport,
  listGbpAccounts,
  listGbpLocations,
  listGbpReviews,
  namedGscRow,
  GoogleApiError,
  type GbpLocation,
  type GoogleProvider,
} from '@engine/connectors';
import type { Db } from '../db.js';
import { getLocalProfile, setLocalProfile, type ProfileInput } from './local.js';
import {
  getAccessToken,
  getProjectAssignment,
  listAssignments,
  ConnectionUnavailableError,
  type OAuthClientEnv,
} from './integrations.js';
import { keyringFrom } from './oauthFlows.js';

/**
 * `ENCRYPTION_KEYS` is the keyring form (`version:key` pairs, newest first);
 * `ENCRYPTION_KEY` is the original single-key form and still works, loaded as
 * version 'v1'. Both are read here so a sync running on a deployment that has
 * not adopted rotation behaves exactly as before.
 */
export interface SyncEnv extends OAuthClientEnv {
  ENCRYPTION_KEY?: string;
  ENCRYPTION_KEYS?: string;
}

export interface SyncResult {
  provider: GoogleProvider;
  projectId: string;
  resourceId: string;
  rows: number;
  /** True when the provider had more data than we fetched in one run. */
  truncated: boolean;
  /** Inclusive date range actually requested. */
  from: string;
  to: string;
}

/**
 * GSC data lags by about two days and is revised for a few days after that. A
 * window that ends today would store rows Google then changes, and a window
 * that starts yesterday would store almost nothing. Ending three days back and
 * re-fetching the whole window each run means revisions land, because every
 * write is an upsert.
 */
const GSC_LAG_DAYS = 3;
const DEFAULT_WINDOW_DAYS = 28;

/** `YYYY-MM-DD` for a date offset from a reference day, in UTC. */
export function dayOffset(reference: Date, days: number): string {
  const d = new Date(reference.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface SyncWindow {
  from: string;
  to: string;
}

/**
 * The default window for a provider, given "now".
 *
 * Both bounds are inclusive, as Google treats them, so `windowDays` is the
 * number of days actually covered: `windowDays - 1` steps back from the end.
 * Off by one here means every stored total silently covers a different span
 * than the label on it.
 */
export function defaultWindow(provider: GoogleProvider, now: Date, windowDays = DEFAULT_WINDOW_DAYS): SyncWindow {
  const lag = provider === 'gsc' ? GSC_LAG_DAYS : 1;
  const span = Math.max(1, windowDays);
  return { from: dayOffset(now, -(lag + span - 1)), to: dayOffset(now, -lag) };
}

async function recordSyncOutcome(
  db: Db,
  assignmentId: string,
  outcome: { rows: number } | { error: string },
): Promise<void> {
  if ('error' in outcome) {
    await db`
      update integration_assignments
      set last_sync_error = ${outcome.error.slice(0, 1000)}
      where id::text = ${assignmentId}
    `;
    return;
  }
  await db`
    update integration_assignments
    set last_synced_at = now(), last_sync_rows = ${outcome.rows}, last_sync_error = null
    where id::text = ${assignmentId}
  `;
}

/**
 * Sync one project's Search Console data.
 *
 * Two requests, by query and by page, rather than one date × query × page
 * request whose cross product is enormous and answers a question nobody asks.
 */
export async function syncGsc(
  db: Db,
  accountId: string,
  projectId: string,
  env: SyncEnv,
  window?: SyncWindow,
  now: Date = new Date(),
  fetchImpl: typeof fetch = fetch,
): Promise<SyncResult | { error: 'no-assignment' }> {
  const assignment = await getProjectAssignment(db, projectId, 'gsc');
  if (!assignment) return { error: 'no-assignment' };

  const { from, to } = window ?? defaultWindow('gsc', now);
  const token = await getAccessToken(db, accountId, 'gsc', await keyringFrom(env), env, fetchImpl);

  try {
    const [byQuery, byPage] = await Promise.all([
      queryGscAll(token, assignment.resourceId, { startDate: from, endDate: to, dimensions: ['date', 'query'] }, fetchImpl),
      queryGscAll(token, assignment.resourceId, { startDate: from, endDate: to, dimensions: ['date', 'page'] }, fetchImpl),
    ]);

    for (const row of byQuery.rows) {
      const named = namedGscRow(row, ['date', 'query']);
      if (!named.date || !named.query) continue;
      await db`
        insert into gsc_query_daily (project_id, date, query, clicks, impressions, ctr, position, synced_at)
        values (${projectId}, ${named.date}, ${named.query}, ${row.clicks}, ${row.impressions}, ${row.ctr}, ${row.position}, now())
        on conflict (project_id, date, query) do update set
          clicks = excluded.clicks, impressions = excluded.impressions,
          ctr = excluded.ctr, position = excluded.position, synced_at = now()
      `;
    }

    for (const row of byPage.rows) {
      const named = namedGscRow(row, ['date', 'page']);
      if (!named.date || !named.page) continue;
      await db`
        insert into gsc_page_daily (project_id, date, page, clicks, impressions, ctr, position, synced_at)
        values (${projectId}, ${named.date}, ${named.page}, ${row.clicks}, ${row.impressions}, ${row.ctr}, ${row.position}, now())
        on conflict (project_id, date, page) do update set
          clicks = excluded.clicks, impressions = excluded.impressions,
          ctr = excluded.ctr, position = excluded.position, synced_at = now()
      `;
    }

    const rows = byQuery.rows.length + byPage.rows.length;
    await recordSyncOutcome(db, assignment.id, { rows });
    return {
      provider: 'gsc',
      projectId,
      resourceId: assignment.resourceId,
      rows,
      truncated: byQuery.truncated || byPage.truncated,
      from,
      to,
    };
  } catch (error) {
    await recordSyncOutcome(db, assignment.id, { error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

/** Sync one project's GA4 channel report. */
export async function syncGa4(
  db: Db,
  accountId: string,
  projectId: string,
  env: SyncEnv,
  window?: SyncWindow,
  now: Date = new Date(),
  fetchImpl: typeof fetch = fetch,
): Promise<SyncResult | { error: 'no-assignment' }> {
  const assignment = await getProjectAssignment(db, projectId, 'ga4');
  if (!assignment) return { error: 'no-assignment' };

  const { from, to } = window ?? defaultWindow('ga4', now);
  const token = await getAccessToken(db, accountId, 'ga4', await keyringFrom(env), env, fetchImpl);

  try {
    const report = await ga4ChannelReport(token, assignment.resourceId, from, to, fetchImpl);
    const index = (name: string) => report.dimensionHeaders.indexOf(name);
    const metric = (name: string) => report.metricHeaders.indexOf(name);
    const dateAt = index('date');
    const channelAt = index('sessionDefaultChannelGroup');
    const sourceAt = index('sessionSource');

    let written = 0;
    for (const row of report.rows) {
      // GA4 returns dates as 'YYYYMMDD'; Postgres needs separators.
      const raw = row.dimensionValues[dateAt] ?? '';
      if (raw.length !== 8) continue;
      const date = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;

      await db`
        insert into ga4_channel_daily (
          project_id, date, channel_group, source, sessions, engaged_sessions, conversions, revenue, synced_at
        )
        values (
          ${projectId}, ${date},
          ${row.dimensionValues[channelAt] ?? '(not set)'},
          ${row.dimensionValues[sourceAt] ?? ''},
          ${row.metricValues[metric('sessions')] ?? 0},
          ${row.metricValues[metric('engagedSessions')] ?? 0},
          ${row.metricValues[metric('conversions')] ?? 0},
          ${row.metricValues[metric('totalRevenue')] ?? 0},
          now()
        )
        on conflict (project_id, date, channel_group, source) do update set
          sessions = excluded.sessions, engaged_sessions = excluded.engaged_sessions,
          conversions = excluded.conversions, revenue = excluded.revenue, synced_at = now()
      `;
      written++;
    }

    await recordSyncOutcome(db, assignment.id, { rows: written });
    return {
      provider: 'ga4',
      projectId,
      resourceId: assignment.resourceId,
      rows: written,
      truncated: report.rowCount > report.rows.length,
      from,
      to,
    };
  } catch (error) {
    await recordSyncOutcome(db, assignment.id, { error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

/**
 * Map a GBP review's star rating onto the sentiment bucket B5 blends.
 *
 * Derived from the rating, not from reading the text: a rating is what the
 * customer actually asserted, and inferring sentiment from prose here would put
 * an unmeasured guess into a score the product presents as deterministic.
 */
function sentimentFromRating(rating: number): 'positive' | 'neutral' | 'negative' | null {
  if (rating >= 4) return 'positive';
  if (rating === 3) return 'neutral';
  if (rating >= 1) return 'negative';
  return null;
}

/**
 * Sync a project's GBP locations into `local_profiles`.
 *
 * This is what migration 0013 was waiting for. B5's local audit has been scoring
 * GBP completeness and review health off a profile document a human had to `PUT`
 * by hand — the migration says so outright: "until the GBP API connector lands,
 * the profile is settable via PUT". This writes the same `LocalProfileFacts`
 * shape from the API, so the audit reads one document regardless of origin.
 *
 * Two fields the Business Profile API does not give us here, and both are
 * *scored* by the audit, so writing a false empty would manufacture a finding
 * against the customer:
 *
 *   - `photoCount` — media lives on a separate v4 endpoint.
 *   - `directoryListings` — third-party citations, which is A6's job, not GBP's.
 *
 * Neither is overwritten. Whatever the existing profile holds is carried
 * forward, and a first sync leaves them empty rather than inventing a number.
 *
 * The audit is deliberately not re-run here. Storing facts and scoring them are
 * separate steps in this codebase (`setLocalProfile`, then `runLocalAudit`), and
 * collapsing them would let a background sync publish customer-visible findings
 * with nobody having asked for an audit.
 */
export async function syncGbp(
  db: Db,
  accountId: string,
  projectId: string,
  env: SyncEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<{ locations: number; skipped: number } | { error: 'no-assignment' }> {
  const assignments = (await listAssignments(db, projectId)).filter((a) => a.provider === 'gbp');
  if (assignments.length === 0) return { error: 'no-assignment' };

  const token = await getAccessToken(db, accountId, 'gbp', await keyringFrom(env), env, fetchImpl);

  // Locations are addressed under their Business Profile account, and an
  // assignment records only the location. Build the map once: an agency with
  // forty locations under one account would otherwise re-list them forty times.
  const ownerOf = new Map<string, string>();
  const detailOf = new Map<string, GbpLocation>();
  const { accounts } = await listGbpAccounts(token, fetchImpl);
  for (const account of accounts) {
    const { locations } = await listGbpLocations(token, account.name, fetchImpl);
    for (const location of locations) {
      ownerOf.set(location.name, account.name);
      detailOf.set(location.name, location);
    }
  }

  let written = 0;
  let skipped = 0;
  for (const assignment of assignments) {
    const detail = detailOf.get(assignment.resourceId);
    const owner = ownerOf.get(assignment.resourceId);
    if (!detail || !owner || !assignment.entityId) {
      // Deleted in Google, or moved to an account this token can no longer see.
      // Recorded on the assignment rather than thrown: one stale location must
      // not abort the other thirty-nine.
      await recordSyncOutcome(db, assignment.id, {
        error: `location ${assignment.resourceId} is no longer visible to this connection`,
      });
      skipped++;
      continue;
    }

    const { reviews } = await listGbpReviews(token, owner, assignment.resourceId, fetchImpl);
    const existing = await getLocalProfile(db, projectId, assignment.entityId);

    const profile: ProfileInput = {
      name: detail.title,
      address: [detail.addressLines.join(', '), detail.locality, detail.administrativeArea, detail.postalCode]
        .filter((part) => part && part.trim() !== '')
        .join(', '),
      phone: detail.phone ?? '',
      categories: [detail.primaryCategory, ...detail.additionalCategories].filter(
        (c): c is string => typeof c === 'string' && c !== '',
      ),
      hoursSet: detail.hasRegularHours,
      attributes: detail.attributes,
      description: detail.description ?? null,
      // Not available from this API surface — preserved, never overwritten.
      photoCount: existing?.photoCount ?? 0,
      directoryListings: existing?.directoryListings ?? [],
      reviews: reviews.map((r) => ({
        rating: r.starRating,
        respondedTo: r.hasReply,
        sentiment: sentimentFromRating(r.starRating),
        at: r.createTime ?? r.updateTime ?? new Date().toISOString(),
      })),
    };

    const stored = await setLocalProfile(db, projectId, assignment.entityId, profile);
    if (!stored) {
      // The entity is not in this project. The assignment's FK should make that
      // impossible, so this is a guard against a future schema change rather
      // than an expected path — but a silent skip is better than a 500.
      await recordSyncOutcome(db, assignment.id, {
        error: `entity ${assignment.entityId} is not in project ${projectId}`,
      });
      skipped++;
      continue;
    }
    await recordSyncOutcome(db, assignment.id, { rows: reviews.length });
    written++;
  }

  return { locations: written, skipped };
}

/** Providers whose sync a cron tick should attempt, in order. */
export const SYNCABLE_PROVIDERS: GoogleProvider[] = ['gsc', 'ga4', 'gbp'];

export interface ScheduledSyncSummary {
  attempted: number;
  succeeded: number;
  failed: { projectId: string; provider: GoogleProvider; error: string }[];
}

/**
 * Sync every assignment that has a live connection — the cron entry point.
 *
 * Failures are collected, never thrown. One customer whose token was revoked
 * must not stop every other customer's nightly sync, which is exactly what an
 * uncaught throw in a scheduled handler does.
 */
export async function runScheduledSync(db: Db, env: SyncEnv, now: Date = new Date()): Promise<ScheduledSyncSummary> {
  const targets = await db<{ project_id: string; account_id: string; provider: GoogleProvider }[]>`
    select distinct a.project_id, c.account_id, a.provider
    from integration_assignments a
    join integration_connections c on c.id = a.connection_id
    where c.status = 'connected'
  `;

  const summary: ScheduledSyncSummary = { attempted: 0, succeeded: 0, failed: [] };
  for (const target of targets) {
    summary.attempted++;
    try {
      if (target.provider === 'gsc') {
        await syncGsc(db, target.account_id, target.project_id, env, undefined, now);
      } else if (target.provider === 'ga4') {
        await syncGa4(db, target.account_id, target.project_id, env, undefined, now);
      } else {
        await syncGbp(db, target.account_id, target.project_id, env);
      }
      summary.succeeded++;
    } catch (error) {
      const message =
        error instanceof GoogleApiError || error instanceof ConnectionUnavailableError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
      summary.failed.push({ projectId: target.project_id, provider: target.provider, error: message });
    }
  }
  return summary;
}
