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
  type GscRow,
  type Ga4Report,
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

/** What one write step of a sync did. A sync is several steps, and they fail independently. */
export interface SyncPart {
  /** 'totals' | 'queries' | 'pages' for Search Console; 'channels' for Analytics. */
  name: string;
  rows: number;
  /** True when the provider had more rows than one run stores. */
  truncated: boolean;
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
  parts: SyncPart[];
  /**
   * True when this run reached back a second window so the previous period
   * exists for a comparison. Happens once per project and provider.
   */
  backfilled: boolean;
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

/**
 * Rows per insert statement.
 *
 * The first version of this module wrote one row per statement. A 28-day
 * Search Console window for one small site is several thousand rows, and
 * several thousand round trips to Neon from a Worker do not finish inside a
 * request: the request died part-way, the later steps never ran, no outcome
 * was recorded, and the customer saw "Sync now" do nothing while a biased
 * subset of rows (Google sorts by clicks, so the ones with clicks) had in fact
 * landed. 500 rows x 7 columns is 3,500 bound parameters, well under
 * Postgres' 65,535, and turns those thousands of round trips into a handful.
 */
export const BATCH_ROWS = 500;

/** `YYYY-MM-DD` for a date offset from a reference day, in UTC. */
export function dayOffset(reference: Date, days: number): string {
  const d = new Date(reference.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Days between two `YYYY-MM-DD` dates, inclusive of both. */
export function daysInclusive(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
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

/**
 * Widen a default window to two periods when the stored data does not yet
 * reach the previous one.
 *
 * Pulse compares the last 28 days with the 28 before. A project's first sync
 * would otherwise leave that comparison empty for a month, and a nightly
 * re-fetch of 56 days forever would double every run's cost for nothing. So
 * the window is widened exactly once: when `earliestStored` is null or later
 * than the previous period's first day. Pure, so the arithmetic is testable
 * without a database.
 */
export function widenForBackfill(
  window: SyncWindow,
  earliestStored: string | null,
): { window: SyncWindow; backfilled: boolean } {
  const days = daysInclusive(window.from, window.to);
  const previousFrom = dayOffset(new Date(`${window.from}T00:00:00Z`), -days);
  if (earliestStored !== null && earliestStored <= previousFrom) return { window, backfilled: false };
  return { window: { from: previousFrom, to: window.to }, backfilled: true };
}

async function earliestStoredDate(
  db: Db,
  table: 'gsc_site_daily' | 'ga4_channel_daily',
  projectId: string,
): Promise<string | null> {
  const rows = await db<{ lo: string | null }[]>`
    select min(date)::text as lo from ${db(table)} where project_id::text = ${projectId}
  `;
  return rows[0]?.lo ?? null;
}

/** Split rows into statements of at most `size` rows each. */
export function chunk<T>(rows: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/**
 * Drop repeated keys, keeping the last row for each.
 *
 * `insert ... on conflict do update` rejects a statement that touches the same
 * key twice ("cannot affect row a second time"), and one bad statement would
 * fail a whole batch of 500 good rows. Google's grouped responses should not
 * repeat a key, but the writer must not depend on a vendor's guarantee.
 */
export function dedupeByKey<T>(rows: readonly T[], keyOf: (row: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const row of rows) byKey.set(keyOf(row), row);
  return [...byKey.values()];
}

export interface GscDailyRow {
  project_id: string;
  date: string;
  /** The query or the page URL; absent for property-level totals. */
  key?: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/**
 * Shape Search Console rows for one of the three tables, skipping rows with
 * a missing dimension value rather than storing an empty key.
 */
export function gscDailyRows(
  rows: readonly GscRow[],
  dimension: 'query' | 'page' | null,
  projectId: string,
): GscDailyRow[] {
  const dims: ('date' | 'query' | 'page')[] = dimension ? ['date', dimension] : ['date'];
  const shaped: GscDailyRow[] = [];
  for (const row of rows) {
    const named = namedGscRow(row, dims);
    if (!named.date) continue;
    const key = dimension ? named[dimension] : undefined;
    if (dimension && !key) continue;
    shaped.push({
      project_id: projectId,
      date: named.date,
      ...(dimension ? { key } : {}),
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      position: row.position,
    });
  }
  return dedupeByKey(shaped, (r) => `${r.date} ${r.key ?? ''}`);
}

type GscTable = 'gsc_site_daily' | 'gsc_query_daily' | 'gsc_page_daily';

/**
 * Upsert Search Console rows in batches. Returns the number of rows written.
 *
 * `synced_at` is not in the column list: the insert takes the column default,
 * and the update sets it explicitly, so both paths stamp the same clock.
 */
export async function upsertGscDaily(db: Db, table: GscTable, rows: readonly GscDailyRow[]): Promise<number> {
  const keyColumn = table === 'gsc_query_daily' ? 'query' : table === 'gsc_page_daily' ? 'page' : null;
  let written = 0;
  for (const batch of chunk(rows, BATCH_ROWS)) {
    if (keyColumn) {
      const values = batch.map((r) => ({
        project_id: r.project_id,
        date: r.date,
        [keyColumn]: r.key ?? '',
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: r.ctr,
        position: r.position,
      }));
      await db`
        insert into ${db(table)} ${db(values, 'project_id', 'date', keyColumn, 'clicks', 'impressions', 'ctr', 'position')}
        on conflict (project_id, date, ${db(keyColumn)}) do update set
          clicks = excluded.clicks, impressions = excluded.impressions,
          ctr = excluded.ctr, position = excluded.position, synced_at = now()
      `;
    } else {
      const values = batch.map((r) => ({
        project_id: r.project_id,
        date: r.date,
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: r.ctr,
        position: r.position,
      }));
      await db`
        insert into gsc_site_daily ${db(values, 'project_id', 'date', 'clicks', 'impressions', 'ctr', 'position')}
        on conflict (project_id, date) do update set
          clicks = excluded.clicks, impressions = excluded.impressions,
          ctr = excluded.ctr, position = excluded.position, synced_at = now()
      `;
    }
    written += batch.length;
  }
  return written;
}

export interface Ga4DailyRow {
  project_id: string;
  date: string;
  channel_group: string;
  source: string;
  sessions: number;
  engaged_sessions: number;
  conversions: number;
  revenue: number;
}

/** Shape a GA4 channel report for `ga4_channel_daily`, converting GA4's `YYYYMMDD` dates. */
export function ga4DailyRows(report: Ga4Report, projectId: string): Ga4DailyRow[] {
  const index = (name: string) => report.dimensionHeaders.indexOf(name);
  const metric = (name: string) => report.metricHeaders.indexOf(name);
  const dateAt = index('date');
  const channelAt = index('sessionDefaultChannelGroup');
  const sourceAt = index('sessionSource');
  const shaped: Ga4DailyRow[] = [];
  for (const row of report.rows) {
    const raw = row.dimensionValues[dateAt] ?? '';
    if (raw.length !== 8) continue;
    shaped.push({
      project_id: projectId,
      date: `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`,
      channel_group: row.dimensionValues[channelAt] || '(not set)',
      source: row.dimensionValues[sourceAt] ?? '',
      sessions: row.metricValues[metric('sessions')] ?? 0,
      engaged_sessions: row.metricValues[metric('engagedSessions')] ?? 0,
      conversions: row.metricValues[metric('conversions')] ?? 0,
      revenue: row.metricValues[metric('totalRevenue')] ?? 0,
    });
  }
  return dedupeByKey(shaped, (r) => `${r.date} ${r.channel_group} ${r.source}`);
}

export async function upsertGa4Daily(db: Db, rows: readonly Ga4DailyRow[]): Promise<number> {
  let written = 0;
  for (const batch of chunk(rows, BATCH_ROWS)) {
    await db`
      insert into ga4_channel_daily ${db(
        batch,
        'project_id',
        'date',
        'channel_group',
        'source',
        'sessions',
        'engaged_sessions',
        'conversions',
        'revenue',
      )}
      on conflict (project_id, date, channel_group, source) do update set
        sessions = excluded.sessions, engaged_sessions = excluded.engaged_sessions,
        conversions = excluded.conversions, revenue = excluded.revenue, synced_at = now()
    `;
    written += batch.length;
  }
  return written;
}

/**
 * Record how a sync ended on its assignment.
 *
 * Three outcomes, not two. `progress` is written after each step that
 * succeeds, so a run that dies between steps leaves its row count behind;
 * `error` names the step that failed and how many rows had landed by then,
 * so the Integrations screen can say "incomplete" instead of "never synced"
 * or, worse, nothing. `last_synced_at` moves only on a complete run: it is
 * the customer's answer to "is this data current", and a half-run is not.
 */
async function recordSyncOutcome(
  db: Db,
  assignmentId: string,
  outcome: { rows: number } | { progress: number } | { error: string },
): Promise<void> {
  if ('error' in outcome) {
    await db`
      update integration_assignments
      set last_sync_error = ${outcome.error.slice(0, 1000)}
      where id::text = ${assignmentId}
    `;
    return;
  }
  if ('progress' in outcome) {
    await db`
      update integration_assignments
      set last_sync_rows = ${outcome.progress}
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Sync one project's Search Console data.
 *
 * Three requests: property totals by date, then by date x query, then by
 * date x page. Not one date x query x page request, whose cross product is
 * enormous and answers a question nobody asks. The totals request exists
 * because a sum over the query rows is not the property's total (Google
 * leaves anonymised queries out of that dimension) and the headline number
 * has to match what the customer sees in Search Console itself.
 *
 * A 28-day window fits in one request: for a property of this size the three
 * fetches take a few seconds and the writes a few round trips. Google's own
 * cap is 25,000 rows per request, paged up to 100,000 here, and anything past
 * that is reported as `truncated`, not silently dropped.
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

  let range = window ?? defaultWindow('gsc', now);
  let backfilled = false;
  if (!window) {
    const widened = widenForBackfill(range, await earliestStoredDate(db, 'gsc_site_daily', projectId));
    range = widened.window;
    backfilled = widened.backfilled;
  }
  const { from, to } = range;
  const token = await getAccessToken(db, accountId, 'gsc', await keyringFrom(env), env, fetchImpl);

  const parts: SyncPart[] = [];
  let written = 0;
  const step = async (name: string, table: GscTable, dimension: 'query' | 'page' | null) => {
    try {
      const fetched = await queryGscAll(
        token,
        assignment.resourceId,
        { startDate: from, endDate: to, dimensions: dimension ? ['date', dimension] : ['date'] },
        fetchImpl,
      );
      const rows = await upsertGscDaily(db, table, gscDailyRows(fetched.rows, dimension, projectId));
      written += rows;
      parts.push({ name, rows, truncated: fetched.truncated });
      await recordSyncOutcome(db, assignment.id, { progress: written });
    } catch (error) {
      await recordSyncOutcome(db, assignment.id, {
        error: `${name} failed after ${written} rows were stored: ${describe(error)}`,
      });
      throw error;
    }
  };

  await step('totals', 'gsc_site_daily', null);
  await step('queries', 'gsc_query_daily', 'query');
  await step('pages', 'gsc_page_daily', 'page');

  await recordSyncOutcome(db, assignment.id, { rows: written });
  return {
    provider: 'gsc',
    projectId,
    resourceId: assignment.resourceId,
    rows: written,
    truncated: parts.some((p) => p.truncated),
    from,
    to,
    parts,
    backfilled,
  };
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

  let range = window ?? defaultWindow('ga4', now);
  let backfilled = false;
  if (!window) {
    const widened = widenForBackfill(range, await earliestStoredDate(db, 'ga4_channel_daily', projectId));
    range = widened.window;
    backfilled = widened.backfilled;
  }
  const { from, to } = range;
  const token = await getAccessToken(db, accountId, 'ga4', await keyringFrom(env), env, fetchImpl);

  try {
    const report = await ga4ChannelReport(token, assignment.resourceId, from, to, fetchImpl);
    const written = await upsertGa4Daily(db, ga4DailyRows(report, projectId));
    const truncated = report.rowCount > report.rows.length;
    await recordSyncOutcome(db, assignment.id, { rows: written });
    return {
      provider: 'ga4',
      projectId,
      resourceId: assignment.resourceId,
      rows: written,
      truncated,
      from,
      to,
      parts: [{ name: 'channels', rows: written, truncated }],
      backfilled,
    };
  } catch (error) {
    await recordSyncOutcome(db, assignment.id, { error: `channels failed: ${describe(error)}` });
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
      // This path did fetch the review list. An empty one here means the
      // location genuinely has no reviews, which is a real finding — unlike a
      // hand-typed profile, where an empty list means nobody could type it.
      reviewsSourced: true,
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
