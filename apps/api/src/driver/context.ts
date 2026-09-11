/**
 * What a Driver tool runs against, and the vocabulary its answers share.
 *
 * `@engine/driver` declares what the tools mean; this directory runs them. The
 * split follows the one every other package in this repo keeps — packages hold
 * logic, `apps/api/src/repositories/` reads rows — and it is what lets the
 * Google tools reuse `googleMetrics.ts` rather than restate its definitions of
 * brand, "within reach" and "AI assistant" in a second place.
 *
 * `registry.ts` binds each definition to exactly one handler and fails if the
 * two sets differ, so the split cannot become a tool described in one repo
 * location and answering something else in another.
 */
import type { ToolNextStep, ToolProvenance, ToolResult, ToolState } from '@engine/driver';
import type { Db } from '../db.js';

/**
 * Everything a tool is allowed to know about who is asking.
 *
 * `projectId` and `accountId` arrive here from the session, after
 * `projectAccessError` has already established that this user may read this
 * project. They are not arguments, they are not in any tool's schema, and no
 * handler accepts an override — §4.2 rule 1. The model's arguments arrive
 * separately, validated, and can only ever narrow a query inside this scope.
 */
export interface DriverToolContext {
  db: Db;
  projectId: string;
  accountId: string;
  /** The project's domain, used for brand detection. */
  domain: string;
}

/** One tool's implementation. Arguments are already validated against the schema. */
export type ToolHandler = (
  ctx: DriverToolContext,
  args: Record<string, unknown>,
) => Promise<ToolResult>;

/* ── Result builders ──────────────────────────────────────────────────────── */

/**
 * A result with rows in it.
 *
 * Takes the tables from the definition rather than from the call site, so the
 * provenance a customer is shown and the provenance the catalogue promises are
 * the same list.
 */
export function ok<T>(data: T, provenance: ToolProvenance): ToolResult<T> {
  return { state: 'ok', data, provenance };
}

/**
 * The query ran against live data and the true answer is nothing.
 *
 * This is a measurement, and the difference between it and the two states
 * below is the whole of §4.2 rule 3. "You had no clicks on these terms" is a
 * fact about the site; "Search Console is not connected" is a fact about the
 * setup. A customer told the first when the second is true will go and rewrite
 * a page that was ranking fine.
 */
export function zero<T>(data: T, provenance: ToolProvenance, nextStep?: ToolNextStep): ToolResult<T> {
  return { state: 'zero', data, provenance, ...(nextStep ? { nextStep } : {}) };
}

/** The source that would fill this has not been connected. Always says what to connect. */
export function notConnected<T>(
  data: T,
  provenance: ToolProvenance,
  nextStep: ToolNextStep,
): ToolResult<T> {
  return { state: 'not-connected', data, provenance, nextStep };
}

/** The source is connected or applicable, but nothing has landed in it yet. */
export function noDataYet<T>(
  data: T,
  provenance: ToolProvenance,
  nextStep: ToolNextStep,
): ToolResult<T> {
  return { state: 'no-data-yet', data, provenance, nextStep };
}

/* ── Periods ──────────────────────────────────────────────────────────────── */

/** Read a validated integer argument, falling back when the schema had no default. */
export function intArg(args: Record<string, unknown>, name: string, fallback: number): number {
  const value = args[name];
  return typeof value === 'number' ? value : fallback;
}

/** Read a validated string argument. */
export function strArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** Read a validated boolean argument. */
export function boolArg(args: Record<string, unknown>, name: string, fallback: boolean): boolean {
  const value = args[name];
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * A period of `days` ending on the latest day the data source actually holds.
 *
 * Deliberately not ending on today. A source that last synced on Sunday, read
 * with a period ending on Wednesday, reports three empty days and a collapse
 * that never happened — and the customer's first experience of Driver is it
 * confidently describing a disaster. `latest` comes from the table being read,
 * so the window is always over data that exists.
 */
export function periodEndingAt(latest: string, days: number): { from: string; to: string } {
  const end = new Date(`${latest}T00:00:00Z`);
  const from = new Date(end);
  from.setUTCDate(from.getUTCDate() - (days - 1));
  return { from: from.toISOString().slice(0, 10), to: latest };
}

/** The equal-length period immediately before `period`. */
export function precedingPeriod(period: { from: string; to: string }, days: number): {
  from: string;
  to: string;
} {
  const start = new Date(`${period.from}T00:00:00Z`);
  const to = new Date(start);
  to.setUTCDate(to.getUTCDate() - 1);
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - (days - 1));
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

/* ── Google connection state ──────────────────────────────────────────────── */

/**
 * Why a Google-backed tool has nothing, in the product's own words.
 *
 * §9a decision 6 ships Driver with no gate on Google data, so on a new account
 * every one of the six Google tools returns empty and this function writes the
 * whole first impression. Each branch names the specific missing step, because
 * §8's trust answer requires that and because "no data available" four times in
 * a row is what a product that does not work looks like.
 */
export type GoogleProvider = 'gsc' | 'ga4';

const PROVIDER_NAME: Record<GoogleProvider, string> = {
  gsc: 'Google Search Console',
  ga4: 'Google Analytics',
};

export interface GoogleReadiness {
  /** Null when the provider is ready to be read. Otherwise the state to report. */
  blocked: { state: Extract<ToolState, 'not-connected' | 'no-data-yet'>; nextStep: ToolNextStep } | null;
  resourceLabel: string | null;
  syncedAt: string | null;
  syncError: string | null;
}

interface ConnectionLike {
  provider: string;
  status: 'connected' | 'needs_reauth' | 'revoked';
}

interface AssignmentLike {
  provider: string;
  resourceId: string;
  resourceLabel?: string;
  lastSyncedAt?: string;
  lastSyncError?: string;
}

/**
 * Resolve a provider to one of: ready, not connected, or connected-but-empty.
 *
 * The order of the checks is the order a customer hits them in the connect
 * flow, so the step reported is always the earliest one still outstanding
 * rather than the last one checked.
 */
export function googleReadiness(
  provider: GoogleProvider,
  connections: readonly ConnectionLike[],
  assignments: readonly AssignmentLike[],
): GoogleReadiness {
  const name = PROVIDER_NAME[provider];
  const connection = connections.find((c) => c.provider === provider);
  const assignment = assignments.find((a) => a.provider === provider);
  const base = {
    resourceLabel: assignment?.resourceLabel ?? assignment?.resourceId ?? null,
    syncedAt: assignment?.lastSyncedAt ?? null,
    syncError: assignment?.lastSyncError ?? null,
  };

  if (!connection || connection.status === 'revoked') {
    return {
      ...base,
      blocked: {
        state: 'not-connected',
        nextStep: {
          reason: `${name} is not connected to this account, so nothing has ever been collected.`,
          action: `Connect ${name} on the Integrations screen.`,
        },
      },
    };
  }

  if (connection.status === 'needs_reauth') {
    return {
      ...base,
      blocked: {
        state: 'not-connected',
        nextStep: {
          reason: `${name} is connected but its access has expired, so syncing has stopped.`,
          action: `Reconnect ${name} on the Integrations screen.`,
        },
      },
    };
  }

  if (!assignment) {
    return {
      ...base,
      blocked: {
        state: 'not-connected',
        nextStep: {
          reason: `${name} is connected, but no property has been assigned to this project yet.`,
          action: `Choose which ${name} property this site reads from, on the Integrations screen.`,
        },
      },
    };
  }

  if (assignment.lastSyncError) {
    return {
      ...base,
      blocked: {
        state: 'no-data-yet',
        nextStep: {
          reason: `The last ${name} sync did not finish: ${assignment.lastSyncError.slice(0, 200)}`,
          action: 'Run "Sync now" on the Integrations screen.',
        },
      },
    };
  }

  if (!assignment.lastSyncedAt) {
    return {
      ...base,
      blocked: {
        state: 'no-data-yet',
        nextStep: {
          reason: `${name} is connected and a property is chosen, but the first sync has not run yet.`,
          action: 'Wait for the nightly sync, or run "Sync now" on the Integrations screen.',
        },
      },
    };
  }

  return { ...base, blocked: null };
}

/**
 * A Google tool's answer when `googleReadiness` says it cannot run.
 *
 * Carries the tables anyway: "we would have read `gsc_site_daily` and it is not
 * connected" is a provenance-carrying answer, and dropping provenance on empty
 * results is how an empty answer becomes unauditable.
 */
export function blockedResult<T>(
  data: T,
  tables: string[],
  blocked: NonNullable<GoogleReadiness['blocked']>,
): ToolResult<T> {
  return { state: blocked.state, data, provenance: { tables }, nextStep: blocked.nextStep };
}
