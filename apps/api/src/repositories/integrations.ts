/**
 * Persistence for per-account customer connections (migrations 0014 + 0017),
 * and the one place a credential is sealed or opened.
 *
 * The sealing lives here rather than in the route handlers on purpose. A
 * credential that is encrypted at four of five call sites is not encrypted; a
 * repository that will not hand out the ciphertext, and will not accept a
 * plaintext secret into the column, is. Nothing this module exports returns
 * `secret_sealed` — `getAccessToken` returns a short-lived access token and
 * keeps the long-lived one inside, and `getApiKeyCredential` is the single
 * narrow exception, documented at its definition.
 *
 * The credential lives in its own table (`integration_credentials`), which
 * makes that guarantee structural rather than a convention. Reading a
 * connection is a plain `select *`: there is no "every column except the
 * secret" list to keep correct, and a future query written without this file's
 * context cannot select a credential it would have to name a second table to
 * reach.
 *
 * What changed in the port to `@engine/integrations`: the provider is a string
 * validated against the registry rather than a Google-only union, a credential
 * has a kind, and the encryption key is a keyring so it can rotate. Behaviour
 * for the three Google providers is unchanged.
 */
import {
  getProvider,
  signAppJwt,
  mintInstallationToken,
  deleteInstallation,
  type AuthMethod,
  refreshAccessToken as refreshOAuthToken,
  revokeToken as revokeOAuthToken,
  missingScopes,
  sealCredential,
  openCredential,
  IntegrationError,
  isIntegrationError,
  redactError,
  type Keyring,
  type Credential,
  type ApiKeyCredential,
  type IntegrationProvider,
  type IntegrationActor,
  type IntegrationEventType,
} from '@engine/integrations';
import { toJsonb, type Db } from '../db.js';
import { resolvePlatformClient, resolveGitHubApp } from './platformCredentials.js';

/** What the UI and the sync jobs may see. Deliberately has no secret field. */
export interface IntegrationConnection {
  id: string;
  accountId: string;
  provider: string;
  /** Display label for the connected vendor account — an email, a portal name. */
  externalLabel?: string;
  /** Stable vendor-side id of that account. */
  externalSubject?: string;
  grantedScopes: string[];
  status: 'connected' | 'needs_reauth' | 'revoked';
  connectedBy?: string;
  connectedAt: string;
  lastRefreshAt?: string;
  lastError?: string;
  /** False when the user unticked a scope on the consent screen. */
  scopesSufficient: boolean;
  /** 'oauth2' or 'api_key'. Absent when the credential has been cleared. */
  credentialKind?: AuthMethod['kind'];
  /** Non-secret settings of an API-key credential — a site URL, a username. */
  publicFields?: Record<string, string>;
}

interface ConnectionRow {
  id: string;
  account_id: string;
  provider: string;
  external_subject: string | null;
  external_label: string | null;
  granted_scopes: string[];
  status: 'connected' | 'needs_reauth' | 'revoked';
  connected_by: string | null;
  connected_at: Date;
  last_refresh_at: Date | null;
  last_error: string | null;
  credential_kind?: 'oauth2' | 'api_key' | null;
  public_fields?: Record<string, string> | null;
}

/**
 * Scope sufficiency for a provider the registry no longer knows.
 *
 * A row can outlive its registry entry — a provider withdrawn after customers
 * connected it. Reported as insufficient rather than sufficient: the connection
 * is unusable either way, and the honest render is "reconnect", not "healthy".
 */
function scopesSufficientFor(providerId: string, granted: string[]): boolean {
  const provider = getProvider(providerId);
  if (!provider) return false;
  if (provider.auth.kind !== 'oauth2') return true;
  return missingScopes(provider, granted).length === 0;
}

function toConnection(row: ConnectionRow): IntegrationConnection {
  return {
    id: row.id,
    accountId: row.account_id,
    provider: row.provider,
    externalLabel: row.external_label ?? undefined,
    externalSubject: row.external_subject ?? undefined,
    grantedScopes: row.granted_scopes ?? [],
    status: row.status,
    connectedBy: row.connected_by ?? undefined,
    connectedAt: row.connected_at.toISOString(),
    lastRefreshAt: row.last_refresh_at?.toISOString(),
    lastError: row.last_error ?? undefined,
    scopesSufficient: scopesSufficientFor(row.provider, row.granted_scopes ?? []),
    // A GitHub App connection has no credentials row — there is no
    // per-customer secret to seal — so the kind comes from the registry
    // instead of the database. Derived rather than stored, and therefore
    // incapable of disagreeing with the provider it describes.
    credentialKind: row.credential_kind ?? getProvider(row.provider)?.auth.kind,
    publicFields: row.public_fields ?? undefined,
  };
}

/** `select` list used wherever a connection is read with its credential shape. */
const CONNECTION_COLUMNS = 'c.*, cr.credential_kind, cr.public_fields';

/* ── Audit ───────────────────────────────────────────────────────────────── */

export interface RecordEventInput {
  accountId: string;
  provider: string;
  type: IntegrationEventType;
  actor: IntegrationActor;
  reason?: string;
  detail?: string;
  metadata?: Record<string, string | number | boolean>;
}

/**
 * Append one row to the integration audit trail (migration 0017).
 *
 * Never throws. An audit sink that is down must not turn a working token
 * refresh into a failed one. The trade loses events under failure rather than
 * losing the operation, which is the right side for an operational trail and
 * the wrong side for a compliance one — if this ever has to be the latter, the
 * fix is a durable queue, not a rethrow.
 */
export async function recordEvent(db: Db, input: RecordEventInput): Promise<void> {
  const actor = input.actor.kind === 'user' ? `user:${input.actor.userId}` : `service:${input.actor.name}`;
  try {
    await db`
      insert into integration_events (account_id, provider, event_type, actor, reason, detail, metadata)
      values (
        ${input.accountId}, ${input.provider}, ${input.type}, ${actor},
        ${input.reason ?? null}, ${input.detail ? redactError(input.detail) : null},
        ${toJsonb(db, input.metadata ?? {})}
      )
    `;
  } catch {
    /* deliberately swallowed — see the note above */
  }
}

export interface IntegrationEventRow {
  id: string;
  provider: string;
  type: string;
  actor: string;
  reason?: string;
  detail?: string;
  metadata: Record<string, unknown>;
  occurredAt: string;
}

/** The audit trail for one account, newest first. */
export async function listEvents(db: Db, accountId: string, limit = 100): Promise<IntegrationEventRow[]> {
  const rows = await db<
    {
      id: string;
      provider: string;
      event_type: string;
      actor: string;
      reason: string | null;
      detail: string | null;
      metadata: Record<string, unknown>;
      occurred_at: Date;
    }[]
  >`
    select * from integration_events
    where account_id::text = ${accountId}
    order by occurred_at desc
    limit ${Math.min(Math.max(limit, 1), 500)}
  `;
  return rows.map((r) => ({
    id: r.id,
    provider: r.provider,
    type: r.event_type,
    actor: r.actor,
    reason: r.reason ?? undefined,
    detail: r.detail ?? undefined,
    metadata: r.metadata ?? {},
    occurredAt: r.occurred_at.toISOString(),
  }));
}

/* ── Storing a connection ────────────────────────────────────────────────── */

export interface UpsertConnectionInput {
  accountId: string;
  provider: string;
  credential: Credential;
  /** Empty for an API-key provider, which has no consent screen. */
  grantedScopes?: string[];
  externalSubject?: string;
  externalLabel?: string;
  connectedBy: string;
}

/**
 * Store a freshly connected provider, replacing any previous one for the same
 * account.
 *
 * Reconnecting deliberately does **not** touch `integration_assignments`. An
 * agency that reconnects after revoking access in their vendor settings would
 * otherwise lose the mapping of forty properties onto forty projects and have
 * to rebuild it by hand. The assignments' composite FK keeps them valid, since
 * the connection row's id is preserved by the upsert.
 */
export async function upsertConnection(
  db: Db,
  keyring: Keyring,
  input: UpsertConnectionInput,
): Promise<IntegrationConnection> {
  const sealed = await sealCredential(keyring, input.accountId, input.provider, input.credential);

  // One transaction, because the two rows are one fact. A connection stored
  // without its credential would show as healthy in the UI and fail on the
  // first API call; a credential stored against a connection that rolled back
  // would be unreachable ciphertext.
  const connection = (await db.begin(async (tx) => {
    const [row] = await tx<ConnectionRow[]>`
      insert into integration_connections (
        account_id, provider, external_subject, external_label,
        granted_scopes, status, connected_by
      )
      values (
        ${input.accountId}, ${input.provider}, ${input.externalSubject ?? null}, ${input.externalLabel ?? null},
        ${input.grantedScopes ?? []}, 'connected', ${input.connectedBy}
      )
      on conflict (account_id, provider) do update set
        external_subject = excluded.external_subject,
        external_label = excluded.external_label,
        granted_scopes = excluded.granted_scopes,
        status = 'connected',
        connected_by = excluded.connected_by,
        connected_at = now(),
        last_error = null,
        last_refresh_at = null,
        updated_at = now()
      returning *
    `;
    await tx`
      insert into integration_credentials (
        connection_id, secret_sealed, credential_kind, key_version, public_fields, updated_at
      )
      values (
        ${row.id}, ${sealed.sealed}, ${sealed.kind}, ${sealed.keyVersion},
        ${/* `db`, not `tx`: json() only wraps a value for binding — it is not
             bound to a connection, and TransactionSql does not expose it. */
          toJsonb(db, sealed.public)}, now()
      )
      on conflict (connection_id) do update set
        secret_sealed = excluded.secret_sealed,
        credential_kind = excluded.credential_kind,
        key_version = excluded.key_version,
        public_fields = excluded.public_fields,
        updated_at = now()
    `;
    return { ...row, credential_kind: sealed.kind, public_fields: sealed.public };
  })) as ConnectionRow;

  await recordEvent(db, {
    accountId: input.accountId,
    provider: input.provider,
    type: 'connected',
    actor: { kind: 'user', userId: input.connectedBy },
    metadata: { kind: sealed.kind, keyVersion: sealed.keyVersion, scopes: (input.grantedScopes ?? []).length },
  });
  return toConnection(connection);
}

/** Every connection on an account, for the integrations screen. */
export async function listConnections(db: Db, accountId: string): Promise<IntegrationConnection[]> {
  const rows = await db<ConnectionRow[]>`
    select ${db.unsafe(CONNECTION_COLUMNS)} from integration_connections c
    left join integration_credentials cr on cr.connection_id = c.id
    where c.account_id::text = ${accountId}
    order by c.provider
  `;
  return rows.map(toConnection);
}

export async function getConnection(
  db: Db,
  accountId: string,
  provider: string,
): Promise<IntegrationConnection | null> {
  const rows = await db<ConnectionRow[]>`
    select ${db.unsafe(CONNECTION_COLUMNS)} from integration_connections c
    left join integration_credentials cr on cr.connection_id = c.id
    where c.account_id::text = ${accountId} and c.provider = ${provider}
  `;
  return rows[0] ? toConnection(rows[0]) : null;
}

/**
 * Record that a refresh failed.
 *
 * A permanent failure moves the row to 'needs_reauth' so the UI can ask for a
 * reconnect. A transient one records the error and leaves `status` alone — a
 * single 500 from a vendor must not present itself to the user as revoked
 * access.
 */
export async function markConnectionError(
  db: Db,
  accountId: string,
  provider: string,
  error: string,
  permanent: boolean,
): Promise<void> {
  // Redacted here as well as at IntegrationError construction: this is the
  // last hop before a vendor string lands in a column the UI renders, and a
  // caller may have assembled the message itself.
  const detail = redactError(error, 1000);
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

/* ── Reading a credential ────────────────────────────────────────────────── */

export class ConnectionUnavailableError extends Error {
  readonly reason: 'not-connected' | 'needs-reauth' | 'insufficient-scope' | 'unconfigured';
  constructor(reason: ConnectionUnavailableError['reason'], message: string) {
    super(message);
    this.name = 'ConnectionUnavailableError';
    this.reason = reason;
  }
}

export interface OAuthClientEnv {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
}

/**
 * The OAuth client credentials for a provider, from the database first.
 *
 * This is Engine's own identity to the vendor, not a customer's credential —
 * every customer consents to this same app. It used to come only from
 * `GOOGLE_*` Worker secrets, which meant registering Engine's Google app
 * required a terminal and Cloudflare access. It is now configurable on the
 * platform admin screen and stored in `platform_credentials` (migration 0019).
 *
 * The environment is kept as a fallback rather than removed, for two reasons:
 * a deployment already configured that way keeps working with no migration
 * step, and local development can set three variables in `.dev.vars` without
 * standing up an admin session first.
 *
 * When a second OAuth vendor ships, this stays the one place that changes —
 * the routes and the rest of the repository never learn which vendor is which.
 */
export async function clientFor(
  provider: IntegrationProvider,
  env: OAuthClientEnv,
  db?: Db,
  keyring?: Keyring,
): Promise<{ clientId: string; clientSecret: string; redirectUri: string } | null> {
  if (provider.vendor !== 'Google') return null;

  if (db && keyring) {
    try {
      const stored = await resolvePlatformClient(db, keyring, 'google');
      if (stored) return stored;
    } catch {
      // An unreachable database or a key dropped from the keyring must not
      // make a deployment that is configured by environment stop working.
      // Falling through is the safe direction here: the fallback is equally
      // authentic, just configured elsewhere.
    }
  }

  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REDIRECT_URI) return null;
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: env.GOOGLE_REDIRECT_URI,
  };
}

interface CredentialRow {
  secret_sealed: string | null;
  credential_kind: 'oauth2' | 'api_key' | null;
  key_version: string | null;
  public_fields: Record<string, string> | null;
  status: string;
  granted_scopes: string[];
}

/**
 * Load and open a stored credential, or explain why it cannot be used.
 *
 * A left join, so a connection whose credential was deleted (a disconnect) is
 * still distinguishable from no connection at all — the two need different
 * messages, and an inner join would collapse them into "not connected".
 */
async function loadCredential(
  db: Db,
  keyring: Keyring,
  accountId: string,
  provider: IntegrationProvider,
): Promise<{ credential: Credential; staleKey: boolean }> {
  const rows = await db<CredentialRow[]>`
    select c.status, c.granted_scopes,
           cr.secret_sealed, cr.credential_kind, cr.key_version, cr.public_fields
    from integration_connections c
    left join integration_credentials cr on cr.connection_id = c.id
    where c.account_id::text = ${accountId} and c.provider = ${provider.id}
  `;
  const row = rows[0];
  if (!row || row.status === 'revoked') {
    throw new ConnectionUnavailableError('not-connected', `${provider.name} is not connected for this account`);
  }
  if (row.status === 'needs_reauth') {
    throw new ConnectionUnavailableError('needs-reauth', `${provider.name} access was revoked — reconnect required`);
  }
  if (!row.secret_sealed) {
    // A 'connected' row with no credential should not exist — `upsertConnection`
    // writes both in one transaction. Treated as needing a reconnect rather than
    // asserting, because the honest fix for the user is the same either way.
    throw new ConnectionUnavailableError(
      'needs-reauth',
      `${provider.name} has no stored credential — reconnect required`,
    );
  }
  if (provider.auth.kind === 'oauth2') {
    const missing = missingScopes(provider, row.granted_scopes ?? []);
    if (missing.length > 0) {
      throw new ConnectionUnavailableError(
        'insufficient-scope',
        `${provider.name} was connected without the access it needs (${missing.join(', ')}) — reconnect and grant it`,
      );
    }
  }

  return openCredential(keyring, accountId, provider.id, {
    kind: row.credential_kind ?? 'oauth2',
    sealed: row.secret_sealed,
    keyVersion: row.key_version ?? 'v1',
    public: row.public_fields ?? {},
  });
}

/**
 * Re-seal a credential that was opened under a superseded key.
 *
 * Rotation drains on read rather than in a migration, so an operator adds a new
 * primary key and the fleet converts itself as connections are used. Failure is
 * swallowed: the caller already has a working credential, and turning a
 * successful sync into an error because a housekeeping write failed would be
 * the wrong trade.
 */
async function reSeal(
  db: Db,
  keyring: Keyring,
  accountId: string,
  provider: IntegrationProvider,
  credential: Credential,
): Promise<void> {
  try {
    const sealed = await sealCredential(keyring, accountId, provider.id, credential);
    await db`
      update integration_credentials
      set secret_sealed = ${sealed.sealed}, key_version = ${sealed.keyVersion}, updated_at = now()
      where connection_id in (
        select id from integration_connections
        where account_id::text = ${accountId} and provider = ${provider.id}
      )
    `;
    await recordEvent(db, {
      accountId,
      provider: provider.id,
      type: 'key_rotated',
      actor: { kind: 'service', name: 'credential-store' },
      metadata: { keyVersion: sealed.keyVersion },
    });
  } catch {
    /* housekeeping only — see the note above */
  }
}

/**
 * Produce a usable access token for an account's OAuth provider.
 *
 * This is the only path from a stored refresh token to a live API call. It
 * opens the sealed token, exchanges it, and returns just the access token — so
 * no caller ever holds the long-lived one and no caller can accidentally log
 * it.
 *
 * A permanent grant failure (the user revoked access, changed their password)
 * flips the row to 'needs_reauth' before throwing, so the UI can ask for a
 * reconnect instead of showing a connection that looks healthy and silently
 * returns nothing.
 */
export async function getAccessToken(
  db: Db,
  accountId: string,
  providerId: string,
  keyring: Keyring,
  env: OAuthClientEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const provider = getProvider(providerId);
  if (!provider) {
    throw new ConnectionUnavailableError('unconfigured', `unknown integration provider '${providerId}'`);
  }

  // A GitHub App holds no stored token to refresh: access is minted from
  // Engine's App private key and the account's installation id, valid for an
  // hour and never written down. So this path shares the function's contract
  // — "give me a usable bearer token for this account" — and none of its
  // machinery.
  if (provider.auth.kind === 'github_app') {
    return mintGitHubToken(db, keyring, accountId, provider, fetchImpl);
  }

  if (provider.auth.kind !== 'oauth2') {
    throw new ConnectionUnavailableError('unconfigured', `${provider.name} does not use an access token`);
  }
  const client = await clientFor(provider, env, db, keyring);
  if (!client) {
    throw new ConnectionUnavailableError(
      'unconfigured',
      `${provider.name} is not connectable yet — an administrator has not configured Engine's OAuth client`,
    );
  }

  const { credential, staleKey } = await loadCredential(db, keyring, accountId, provider);
  /* c8 ignore next -- an oauth2 provider's credential is always oauth2 by AAD. */
  if (credential.kind !== 'oauth2') {
    throw new ConnectionUnavailableError('needs-reauth', `${provider.name} has the wrong kind of credential stored`);
  }

  try {
    const tokens = await refreshOAuthToken(provider, client, credential.refreshToken, { fetchImpl });

    // A rotating vendor invalidates the old refresh token on every exchange, so
    // the new one must replace it or the *next* refresh fails. A non-rotating
    // vendor returns none, and writing that absence would destroy a working
    // connection — which is why this is a provider flag and not a null check.
    if (provider.auth.rotatesRefreshToken && tokens.refreshToken) {
      await reSeal(db, keyring, accountId, provider, { kind: 'oauth2', refreshToken: tokens.refreshToken });
    } else if (staleKey) {
      await reSeal(db, keyring, accountId, provider, credential);
    }

    await db`
      update integration_connections
      set last_refresh_at = now(), last_error = null, updated_at = now()
      where account_id::text = ${accountId} and provider = ${provider.id}
    `;
    await recordEvent(db, {
      accountId,
      provider: provider.id,
      type: 'refreshed',
      actor: { kind: 'service', name: 'credential-store' },
    });
    return tokens.accessToken;
  } catch (error) {
    const permanent = isIntegrationError(error) && error.needsReauth;
    const message = error instanceof Error ? error.message : String(error);
    await markConnectionError(db, accountId, provider.id, message, permanent);
    await recordEvent(db, {
      accountId,
      provider: provider.id,
      type: 'refresh_failed',
      actor: { kind: 'service', name: 'credential-store' },
      reason: isIntegrationError(error) ? error.reason : 'unknown',
      detail: message,
    });
    if (permanent) {
      throw new ConnectionUnavailableError('needs-reauth', `${provider.name} access was revoked — reconnect required`);
    }
    throw error;
  }
}

/**
 * Open a stored API-key credential.
 *
 * The one exported path that yields a long-lived secret, and it exists because
 * an API key has no short-lived equivalent to hand back — there is no exchange
 * step, so the caller must hold the key to make the call. Callers must pass the
 * result straight to `applyApiKey` and never log or return it.
 */
export async function getApiKeyCredential(
  db: Db,
  accountId: string,
  providerId: string,
  keyring: Keyring,
): Promise<ApiKeyCredential> {
  const provider = getProvider(providerId);
  if (!provider) {
    throw new ConnectionUnavailableError('unconfigured', `unknown integration provider '${providerId}'`);
  }
  if (provider.auth.kind !== 'api_key') {
    throw new ConnectionUnavailableError('unconfigured', `${provider.name} does not use an API key`);
  }
  const { credential, staleKey } = await loadCredential(db, keyring, accountId, provider);
  /* c8 ignore next -- an api_key provider's credential is always api_key by AAD. */
  if (credential.kind !== 'api_key') {
    throw new ConnectionUnavailableError('needs-reauth', `${provider.name} has the wrong kind of credential stored`);
  }
  if (staleKey) await reSeal(db, keyring, accountId, provider, credential);
  return credential;
}

/**
 * Disconnect a provider: revoke at the vendor, then clear the stored secret.
 *
 * Revoking first, and continuing even when the vendor refuses, is deliberate. A
 * token the vendor no longer recognises (already revoked from the user's own
 * account settings) must not be able to block the disconnect — the user asked
 * to disconnect, and leaving a row that says 'connected' because a revoke call
 * failed would be the wrong answer to give them.
 *
 * The row is kept, with the secret cleared, so the audit trail of who connected
 * what and when survives a disconnect.
 */
export async function disconnect(
  db: Db,
  keyring: Keyring,
  accountId: string,
  providerId: string,
  env: OAuthClientEnv,
  actor: IntegrationActor,
  fetchImpl: typeof fetch = fetch,
): Promise<{ revokedAtVendor: boolean; revocationSupported: boolean }> {
  const provider = getProvider(providerId);
  let revokedAtVendor = false;
  // An API-key provider has nothing to revoke remotely; the customer rotates
  // the key at the vendor. Reported honestly rather than claimed.
  let revocationSupported = provider?.auth.kind === 'oauth2' && Boolean(provider.auth.revocationUrl);

  // A GitHub App disconnect is a real uninstall, not a token revocation: the
  // App leaves the customer's installed list and every repository it could
  // reach becomes unreachable at once. So revocation is always supported here,
  // and worth doing — leaving the App installed with nothing behind it would
  // show the customer access they had asked us to give up.
  if (provider && provider.auth.kind === 'github_app') {
    revocationSupported = true;
    const app = await resolveGitHubApp(db, keyring);
    const connection = await getConnection(db, accountId, provider.id);
    if (app && connection?.externalSubject) {
      try {
        const jwt = await signAppJwt(app.appId, app.privateKeyPem);
        await deleteInstallation(provider.auth.apiBaseUrl, jwt, connection.externalSubject, fetchImpl);
        revokedAtVendor = true;
      } catch {
        // Same rule as the OAuth path below: a failed uninstall must not stop
        // us forgetting the installation locally.
        revokedAtVendor = false;
      }
    }
  }

  if (provider && provider.auth.kind === 'oauth2') {
    const client = await clientFor(provider, env, db, keyring);
    try {
      const rows = await db<{ secret_sealed: string; key_version: string | null }[]>`
        select cr.secret_sealed, cr.key_version
        from integration_connections c
        join integration_credentials cr on cr.connection_id = c.id
        where c.account_id::text = ${accountId} and c.provider = ${provider.id}
      `;
      if (rows[0] && client) {
        const opened = await openCredential(keyring, accountId, provider.id, {
          kind: 'oauth2',
          sealed: rows[0].secret_sealed,
          keyVersion: rows[0].key_version ?? 'v1',
          public: {},
        });
        if (opened.credential.kind === 'oauth2') {
          const result = await revokeOAuthToken(provider, client, opened.credential.refreshToken, { fetchImpl });
          revokedAtVendor = result.revoked;
          revocationSupported = result.supported;
        }
      }
    } catch {
      // A credential that cannot be opened (a key dropped from the keyring) or
      // a revoke that fails still has to be forgotten locally. Swallowing here
      // is the point.
      revokedAtVendor = false;
    }
  }

  // Delete the credential and mark the connection revoked, together — a
  // half-done disconnect that leaves the secret behind is the one outcome the
  // user must not get after asking us to sever access.
  await db.begin(async (tx) => {
    await tx`
      delete from integration_credentials
      where connection_id in (
        select id from integration_connections
        where account_id::text = ${accountId} and provider = ${providerId}
      )
    `;
    await tx`
      update integration_connections
      set status = 'revoked', last_error = null, updated_at = now()
      where account_id::text = ${accountId} and provider = ${providerId}
    `;
  });

  await recordEvent(db, {
    accountId,
    provider: providerId,
    type: 'disconnected',
    actor,
    metadata: { revokedAtVendor, revocationSupported },
  });
  return { revokedAtVendor, revocationSupported };
}

/* ── Assignments ────────────────────────────────────────────────────────── */

export interface IntegrationAssignment {
  id: string;
  connectionId: string;
  provider: string;
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
  provider: string;
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

/** The assignment a sync job needs: one project's resource for a project-scoped provider. */
export async function getProjectAssignment(
  db: Db,
  projectId: string,
  provider: string,
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
  provider: string;
  resourceId: string;
  resourceLabel?: string;
  /** Required for an entity-scoped provider, rejected for a project-scoped one. */
  entityId?: string;
}

/**
 * Assign a provider resource to a project.
 *
 * For project-scoped providers this replaces any existing assignment rather
 * than erroring: "point this project at a different GA4 property" is a normal
 * thing to do, and making the user delete first would be friction for no safety
 * gain. Entity-scoped providers are additive, since a project legitimately has
 * many locations.
 *
 * `resource_scope` is written from the registry rather than inferred from the
 * provider id, which is what let migration 0017 drop the hardcoded list.
 */
export async function assignResource(
  db: Db,
  accountId: string,
  input: AssignInput,
  actor: IntegrationActor,
): Promise<IntegrationAssignment | { error: 'not-connected' | 'unknown-provider' }> {
  const provider = getProvider(input.provider);
  if (!provider) return { error: 'unknown-provider' };

  const connectionRows = await db<{ id: string }[]>`
    select id from integration_connections
    where account_id::text = ${accountId} and provider = ${input.provider} and status = 'connected'
  `;
  const connection = connectionRows[0];
  if (!connection) return { error: 'not-connected' };

  if (provider.resourceScope === 'project') {
    await db`
      delete from integration_assignments
      where project_id::text = ${input.projectId} and provider = ${input.provider}
    `;
  }

  const [row] = await db<AssignmentRow[]>`
    insert into integration_assignments (
      connection_id, provider, project_id, entity_id, resource_id, resource_label, resource_scope
    )
    values (
      ${connection.id}, ${input.provider}, ${input.projectId},
      ${input.entityId ?? null}, ${input.resourceId}, ${input.resourceLabel ?? null}, ${provider.resourceScope}
    )
    on conflict (connection_id, project_id, resource_id) do update set
      resource_label = excluded.resource_label,
      entity_id = excluded.entity_id
    returning *
  `;
  await recordEvent(db, {
    accountId,
    provider: input.provider,
    type: 'assignment_changed',
    actor,
    metadata: { action: 'assigned', projectId: input.projectId, resourceId: input.resourceId },
  });
  return toAssignment(row);
}

/** Remove one assignment. Returns false when it does not belong to the project. */
export async function unassignResource(db: Db, projectId: string, assignmentId: string): Promise<boolean> {
  const rows = await db<{ id: string; provider: string }[]>`
    delete from integration_assignments
    where id::text = ${assignmentId} and project_id::text = ${projectId}
    returning id, provider
  `;
  return rows.length > 0;
}

export { IntegrationError };

export interface UpsertAppInstallationInput {
  accountId: string;
  provider: string;
  /** GitHub's installation id. An identifier, not a credential. */
  installationId: string;
  /** The GitHub user or organisation that installed the App. */
  label: string;
  connectedBy: string;
}

/**
 * Record a GitHub App installation.
 *
 * Deliberately not `upsertConnection`: that function's contract is a
 * connection *and* its sealed credential, written in one transaction because
 * they are one fact. Here there is no credential. The installation id is
 * useless without Engine's App private key, which lives once in
 * `platform_credentials`, so it goes in `external_subject` in the clear —
 * where it can be read, diagnosed and shown, like every other non-secret
 * identifier.
 *
 * Any credentials row left over from a previous connection of the same
 * provider is removed, so a provider that once stored a secret cannot leave
 * one behind after being reconnected as an app.
 */
export async function upsertAppInstallation(
  db: Db,
  input: UpsertAppInstallationInput,
): Promise<IntegrationConnection> {
  const row = (await db.begin(async (tx) => {
    const [connection] = await tx<ConnectionRow[]>`
      insert into integration_connections (
        account_id, provider, external_subject, external_label, granted_scopes, status, connected_by
      )
      values (
        ${input.accountId}, ${input.provider}, ${input.installationId}, ${input.label},
        '{}', 'connected', ${input.connectedBy}
      )
      on conflict (account_id, provider) do update set
        external_subject = excluded.external_subject,
        external_label = excluded.external_label,
        status = 'connected',
        connected_by = excluded.connected_by,
        connected_at = now(),
        last_error = null,
        last_refresh_at = null,
        updated_at = now()
      returning *
    `;
    await tx`delete from integration_credentials where connection_id = ${connection.id}`;
    return connection;
  })) as ConnectionRow;
  return toConnection(row);
}

/**
 * An installation access token for one account's GitHub App installation.
 *
 * Two facts combine: Engine's App private key, held once for the deployment,
 * and the installation id this account came back with. Neither alone reaches
 * a repository. The result lives an hour and is deliberately not stored —
 * there is no table for it, and adding one would create the long-lived
 * credential this design exists to avoid.
 */
async function mintGitHubToken(
  db: Db,
  keyring: Keyring,
  accountId: string,
  provider: IntegrationProvider,
  fetchImpl: typeof fetch,
): Promise<string> {
  /* c8 ignore next -- the caller checked the kind. */
  if (provider.auth.kind !== 'github_app') {
    throw new ConnectionUnavailableError('unconfigured', `${provider.name} is not installed as an app`);
  }
  const app = await resolveGitHubApp(db, keyring);
  if (!app) {
    throw new ConnectionUnavailableError(
      'unconfigured',
      `${provider.name} is not connectable yet — an administrator has not configured Engine's GitHub App`,
    );
  }
  const connection = await getConnection(db, accountId, provider.id);
  if (!connection || connection.status === 'revoked' || !connection.externalSubject) {
    throw new ConnectionUnavailableError('not-connected', `${provider.name} is not connected for this account`);
  }

  try {
    const jwt = await signAppJwt(app.appId, app.privateKeyPem);
    const minted = await mintInstallationToken(
      provider.auth.apiBaseUrl,
      jwt,
      connection.externalSubject,
      fetchImpl,
    );
    await db`
      update integration_connections
      set last_refresh_at = now(), last_error = null, updated_at = now()
      where account_id::text = ${accountId} and provider = ${provider.id}
    `;
    return minted.token;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A 404 from the token endpoint means the customer uninstalled the App on
    // GitHub. That is a disconnect they performed, and the fix is to install
    // it again — which is what 'needs_reauth' tells the UI to offer.
    const uninstalled = /HTTP 404/.test(message);
    await markConnectionError(db, accountId, provider.id, message, uninstalled);
    throw new ConnectionUnavailableError(
      uninstalled ? 'needs-reauth' : 'unconfigured',
      uninstalled
        ? `${provider.name} was uninstalled on GitHub. Connect it again to choose repositories.`
        : `${provider.name} token could not be minted: ${message}`,
    );
  }
}
