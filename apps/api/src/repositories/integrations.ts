/**
 * Persistence for per-account Google connections (migration 0014), and the one
 * place a refresh token is sealed or opened.
 *
 * The sealing lives here rather than in the route handlers on purpose. A
 * credential that is encrypted at four of five call sites is not encrypted; a
 * repository that will not hand out the ciphertext, and will not accept a
 * plaintext token into the column, is. Nothing this module exports returns
 * `refresh_token_sealed` — `getAccessToken` returns a short-lived access token
 * and keeps the long-lived one inside.
 */
import {
  importEncryptionKey,
  seal,
  open,
  credentialAad,
} from '@engine/auth';
import {
  refreshAccessToken,
  revokeToken,
  isPermanentGrantFailure,
  hasRequiredScopes,
  type GoogleProvider,
} from '@engine/connectors';
import type { Db } from '../db.js';

/** What the UI and the sync jobs may see. Deliberately has no token field. */
export interface IntegrationConnection {
  id: string;
  accountId: string;
  provider: GoogleProvider;
  googleEmail?: string;
  googleSubject?: string;
  grantedScopes: string[];
  status: 'connected' | 'needs_reauth' | 'revoked';
  connectedBy?: string;
  connectedAt: string;
  lastRefreshAt?: string;
  lastError?: string;
  /** False when the user unticked a scope on the consent screen. */
  scopesSufficient: boolean;
}

interface ConnectionRow {
  id: string;
  account_id: string;
  provider: GoogleProvider;
  google_subject: string | null;
  google_email: string | null;
  granted_scopes: string[];
  status: 'connected' | 'needs_reauth' | 'revoked';
  connected_by: string | null;
  connected_at: Date;
  last_refresh_at: Date | null;
  last_error: string | null;
}

function toConnection(row: ConnectionRow): IntegrationConnection {
  return {
    id: row.id,
    accountId: row.account_id,
    provider: row.provider,
    googleEmail: row.google_email ?? undefined,
    googleSubject: row.google_subject ?? undefined,
    grantedScopes: row.granted_scopes ?? [],
    status: row.status,
    connectedBy: row.connected_by ?? undefined,
    connectedAt: row.connected_at.toISOString(),
    lastRefreshAt: row.last_refresh_at?.toISOString(),
    lastError: row.last_error ?? undefined,
    scopesSufficient: hasRequiredScopes(row.provider, row.granted_scopes ?? []),
  };
}

export interface UpsertConnectionInput {
  accountId: string;
  provider: GoogleProvider;
  refreshToken: string;
  grantedScopes: string[];
  googleSubject?: string;
  googleEmail?: string;
  connectedBy: string;
}

/**
 * Store a freshly consented connection, replacing any previous one for the same
 * account and provider.
 *
 * Reconnecting deliberately does **not** touch `integration_assignments`. An
 * agency that reconnects after revoking access in their Google settings would
 * otherwise lose the mapping of forty properties onto forty projects and have
 * to rebuild it by hand. The assignments' composite FK keeps them valid, since
 * the connection row's id is preserved by the upsert.
 */
export async function upsertConnection(
  db: Db,
  input: UpsertConnectionInput,
  encryptionKey: string | undefined,
): Promise<IntegrationConnection> {
  const key = await importEncryptionKey(encryptionKey);
  const sealed = await seal(key, input.refreshToken, credentialAad(input.accountId, input.provider));

  const [row] = await db<ConnectionRow[]>`
    insert into integration_connections (
      account_id, provider, google_subject, google_email,
      granted_scopes, refresh_token_sealed, status, connected_by
    )
    values (
      ${input.accountId}, ${input.provider}, ${input.googleSubject ?? null}, ${input.googleEmail ?? null},
      ${input.grantedScopes}, ${sealed}, 'connected', ${input.connectedBy}
    )
    on conflict (account_id, provider) do update set
      google_subject = excluded.google_subject,
      google_email = excluded.google_email,
      granted_scopes = excluded.granted_scopes,
      refresh_token_sealed = excluded.refresh_token_sealed,
      status = 'connected',
      connected_by = excluded.connected_by,
      connected_at = now(),
      last_error = null,
      last_refresh_at = null,
      updated_at = now()
    returning id, account_id, provider, google_subject, google_email, granted_scopes,
              status, connected_by, connected_at, last_refresh_at, last_error
  `;
  return toConnection(row);
}

/** Every connection on an account, for the integrations screen. */
export async function listConnections(db: Db, accountId: string): Promise<IntegrationConnection[]> {
  const rows = await db<ConnectionRow[]>`
    select id, account_id, provider, google_subject, google_email, granted_scopes,
           status, connected_by, connected_at, last_refresh_at, last_error
    from integration_connections
    where account_id::text = ${accountId}
    order by provider
  `;
  return rows.map(toConnection);
}

export async function getConnection(
  db: Db,
  accountId: string,
  provider: GoogleProvider,
): Promise<IntegrationConnection | null> {
  const rows = await db<ConnectionRow[]>`
    select id, account_id, provider, google_subject, google_email, granted_scopes,
           status, connected_by, connected_at, last_refresh_at, last_error
    from integration_connections
    where account_id::text = ${accountId} and provider = ${provider}
  `;
  return rows[0] ? toConnection(rows[0]) : null;
}

/**
 * Record that a refresh failed.
 *
 * A permanent failure moves the row to 'needs_reauth' so the UI can ask for a
 * reconnect. A transient one records the error and leaves `status` alone — a
 * single 500 from Google must not present itself to the user as revoked access.
 */
export async function markConnectionError(
  db: Db,
  accountId: string,
  provider: GoogleProvider,
  error: string,
  permanent: boolean,
): Promise<void> {
  const detail = error.slice(0, 1000);
  if (permanent) {
    await db`
      update integration_connections
      set last_error = ${detail}, status = 'needs_reauth', updated_at = now()
      where account_id::text = ${accountId} and provider = ${provider}
    `;
    return;
  }
  await db`
    update integration_connections
    set last_error = ${detail}, updated_at = now()
    where account_id::text = ${accountId} and provider = ${provider}
  `;
}

export class ConnectionUnavailableError extends Error {
  readonly reason: 'not-connected' | 'needs-reauth' | 'insufficient-scope' | 'unconfigured';
  constructor(reason: ConnectionUnavailableError['reason'], message: string) {
    super(message);
    this.name = 'ConnectionUnavailableError';
    this.reason = reason;
  }
}

export interface GoogleClientEnv {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}

/**
 * Produce a usable access token for an account's provider.
 *
 * This is the only path from a stored credential to a live API call. It opens
 * the sealed refresh token, exchanges it, and returns just the access token —
 * so no caller ever holds the long-lived one and no caller can accidentally log
 * it.
 *
 * A permanent grant failure (the user revoked access in their Google settings,
 * changed their password) flips the row to 'needs_reauth' before throwing, so
 * the UI can ask for a reconnect instead of showing a connection that looks
 * healthy and silently returns nothing.
 */
export async function getAccessToken(
  db: Db,
  accountId: string,
  provider: GoogleProvider,
  env: GoogleClientEnv & { ENCRYPTION_KEY?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new ConnectionUnavailableError(
      'unconfigured',
      'Google OAuth is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)',
    );
  }

  const rows = await db<{ refresh_token_sealed: string; status: string; granted_scopes: string[] }[]>`
    select refresh_token_sealed, status, granted_scopes
    from integration_connections
    where account_id::text = ${accountId} and provider = ${provider}
  `;
  const row = rows[0];
  if (!row || row.status === 'revoked') {
    throw new ConnectionUnavailableError('not-connected', `${provider} is not connected for this account`);
  }
  if (row.status === 'needs_reauth') {
    throw new ConnectionUnavailableError('needs-reauth', `${provider} access was revoked — reconnect required`);
  }
  if (!hasRequiredScopes(provider, row.granted_scopes ?? [])) {
    throw new ConnectionUnavailableError(
      'insufficient-scope',
      `${provider} was connected without the scope it needs — reconnect and grant it`,
    );
  }

  const key = await importEncryptionKey(env.ENCRYPTION_KEY);
  const refreshToken = await open(key, row.refresh_token_sealed, credentialAad(accountId, provider));

  try {
    const tokens = await refreshAccessToken(
      refreshToken,
      { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
      fetchImpl,
    );
    await db`
      update integration_connections
      set last_refresh_at = now(), last_error = null, updated_at = now()
      where account_id::text = ${accountId} and provider = ${provider}
    `;
    return tokens.accessToken;
  } catch (error) {
    const permanent = isPermanentGrantFailure(error);
    await markConnectionError(db, accountId, provider, error instanceof Error ? error.message : String(error), permanent);
    if (permanent) {
      throw new ConnectionUnavailableError('needs-reauth', `${provider} access was revoked — reconnect required`);
    }
    throw error;
  }
}

/**
 * Disconnect a provider: revoke at Google, then clear the stored token.
 *
 * Revoking first, and continuing even when Google refuses, is deliberate. A
 * token Google no longer recognises (already revoked from the user's account
 * settings) must not be able to block the disconnect — the user asked to
 * disconnect, and leaving a row that says 'connected' because a revoke call
 * failed would be the wrong answer to give them.
 *
 * The row is kept, with the token cleared, so the audit trail of who connected
 * what and when survives a disconnect.
 */
export async function disconnect(
  db: Db,
  accountId: string,
  provider: GoogleProvider,
  env: { ENCRYPTION_KEY?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ revokedAtGoogle: boolean }> {
  const rows = await db<{ refresh_token_sealed: string }[]>`
    select refresh_token_sealed from integration_connections
    where account_id::text = ${accountId} and provider = ${provider}
  `;

  let revokedAtGoogle = false;
  if (rows[0]) {
    try {
      const key = await importEncryptionKey(env.ENCRYPTION_KEY);
      const refreshToken = await open(key, rows[0].refresh_token_sealed, credentialAad(accountId, provider));
      revokedAtGoogle = await revokeToken(refreshToken, fetchImpl);
    } catch {
      // A token that cannot be opened (rotated key) or a revoke that fails
      // still has to be forgotten locally. Swallowing here is the point.
      revokedAtGoogle = false;
    }
  }

  await db`
    update integration_connections
    set status = 'revoked', refresh_token_sealed = '', last_error = null, updated_at = now()
    where account_id::text = ${accountId} and provider = ${provider}
  `;
  return { revokedAtGoogle };
}

/* ── Assignments ────────────────────────────────────────────────────────── */

export interface IntegrationAssignment {
  id: string;
  connectionId: string;
  provider: GoogleProvider;
  projectId: string;
  entityId?: string;
  resourceId: string;
  resourceLabel?: string;
  createdAt: string;
  /** Sync health (migration 0015). Null `lastSyncedAt` means it has never synced. */
  lastSyncedAt?: string;
  lastSyncError?: string;
  /** Rows on the last successful sync. Zero is a real result; undefined means never. */
  lastSyncRows?: number;
}

interface AssignmentRow {
  id: string;
  connection_id: string;
  provider: GoogleProvider;
  project_id: string;
  entity_id: string | null;
  resource_id: string;
  resource_label: string | null;
  created_at: Date;
  last_synced_at: Date | null;
  last_sync_error: string | null;
  last_sync_rows: number | null;
}

function toAssignment(row: AssignmentRow): IntegrationAssignment {
  return {
    id: row.id,
    connectionId: row.connection_id,
    provider: row.provider,
    projectId: row.project_id,
    entityId: row.entity_id ?? undefined,
    resourceId: row.resource_id,
    resourceLabel: row.resource_label ?? undefined,
    createdAt: row.created_at.toISOString(),
    lastSyncedAt: row.last_synced_at?.toISOString(),
    lastSyncError: row.last_sync_error ?? undefined,
    // `?? undefined` not `?? 0`: zero rows synced and never synced are different
    // facts, and the UI says "0 rows" for one and "never" for the other.
    lastSyncRows: row.last_sync_rows ?? undefined,
  };
}

/** Assignments on one project, across providers. */
export async function listAssignments(db: Db, projectId: string): Promise<IntegrationAssignment[]> {
  const rows = await db<AssignmentRow[]>`
    select * from integration_assignments where project_id::text = ${projectId}
    order by provider, resource_id
  `;
  return rows.map(toAssignment);
}

/** The assignment a sync job needs: one project's property for a read-only provider. */
export async function getProjectAssignment(
  db: Db,
  projectId: string,
  provider: GoogleProvider,
): Promise<IntegrationAssignment | null> {
  const rows = await db<AssignmentRow[]>`
    select * from integration_assignments
    where project_id::text = ${projectId} and provider = ${provider}
    limit 1
  `;
  return rows[0] ? toAssignment(rows[0]) : null;
}

/** The GBP location assigned to one entity, for a local audit or a C5 deploy. */
export async function getEntityAssignment(db: Db, entityId: string): Promise<IntegrationAssignment | null> {
  const rows = await db<AssignmentRow[]>`
    select * from integration_assignments where entity_id::text = ${entityId} and provider = 'gbp' limit 1
  `;
  return rows[0] ? toAssignment(rows[0]) : null;
}

export interface AssignInput {
  projectId: string;
  provider: GoogleProvider;
  resourceId: string;
  resourceLabel?: string;
  /** Required for gbp, rejected for gsc/ga4 — enforced by the DB check constraint too. */
  entityId?: string;
}

/**
 * Assign a provider resource to a project.
 *
 * For the single-property providers this replaces any existing assignment
 * rather than erroring: "point this project at a different GA4 property" is a
 * normal thing to do, and making the user delete first would be friction for no
 * safety gain. GBP is additive, since a project legitimately has many locations.
 */
export async function assignResource(
  db: Db,
  accountId: string,
  input: AssignInput,
): Promise<IntegrationAssignment | { error: 'not-connected' }> {
  const connectionRows = await db<{ id: string }[]>`
    select id from integration_connections
    where account_id::text = ${accountId} and provider = ${input.provider} and status = 'connected'
  `;
  const connection = connectionRows[0];
  if (!connection) return { error: 'not-connected' };

  if (input.provider !== 'gbp') {
    await db`
      delete from integration_assignments
      where project_id::text = ${input.projectId} and provider = ${input.provider}
    `;
  }

  const [row] = await db<AssignmentRow[]>`
    insert into integration_assignments (connection_id, provider, project_id, entity_id, resource_id, resource_label)
    values (
      ${connection.id}, ${input.provider}, ${input.projectId},
      ${input.entityId ?? null}, ${input.resourceId}, ${input.resourceLabel ?? null}
    )
    on conflict (connection_id, project_id, resource_id) do update set
      resource_label = excluded.resource_label,
      entity_id = excluded.entity_id
    returning *
  `;
  return toAssignment(row);
}

/** Remove one assignment. Returns false when it does not belong to the project. */
export async function unassignResource(db: Db, projectId: string, assignmentId: string): Promise<boolean> {
  const rows = await db`
    delete from integration_assignments
    where id::text = ${assignmentId} and project_id::text = ${projectId}
    returning id
  `;
  return rows.length > 0;
}
