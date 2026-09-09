/**
 * Engine's own OAuth client credentials (migration 0019), and who may change
 * them.
 *
 * The distinction this file exists to hold:
 *
 *   A **customer credential** is the customer's grant. They create it, assign
 *   it, revoke it, and nobody else can. That is `integrations.ts`.
 *
 *   A **platform credential** is Engine's identity to a vendor. One per vendor
 *   for the whole deployment. Every customer consents to this same OAuth app,
 *   exactly as they would with Zapier or HubSpot.
 *
 * Getting these the wrong way round is what made the Integrations screen
 * unusable: it asked a *customer* to supply something only an *operator* can
 * have, through a channel (`wrangler secret put`) no customer will ever have.
 */
import {
  sealCredential,
  openCredential,
  type Keyring,
} from '@engine/integrations';
import type { Db } from '../db.js';

/**
 * Vendors Engine holds its own identity with.
 *
 * 'github' shares this table without stretching it, because the three columns
 * mean the same things: `client_id` is the App id (public, and the `iss` of
 * every App JWT), `client_secret_sealed` is the App private key, and
 * `redirect_uri` is the setup callback registered on the App. What differs is
 * only that GitHub's secret is a PEM rather than a short string.
 */
export type PlatformVendor = 'google' | 'github';

const VENDORS: readonly string[] = ['google', 'github'];

export function isPlatformVendor(value: string): value is PlatformVendor {
  return VENDORS.includes(value);
}

/**
 * A platform credential as the admin screen may see it.
 *
 * Deliberately has no secret field. The screen shows *which* client is
 * configured and lets it be replaced; it can never read the secret back, so a
 * compromised admin session cannot exfiltrate one that was set earlier.
 */
export interface PlatformClientStatus {
  vendor: PlatformVendor;
  clientId: string;
  redirectUri: string;
  configured: boolean;
  configuredBy?: string;
  configuredAt: string;
  updatedAt: string;
}

interface PlatformRow {
  vendor: PlatformVendor;
  client_id: string;
  client_secret_sealed: string;
  key_version: string;
  redirect_uri: string;
  state_secret_sealed: string | null;
  configured_by: string | null;
  configured_at: Date;
  updated_at: Date;
}

function toStatus(row: PlatformRow): PlatformClientStatus {
  return {
    vendor: row.vendor,
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    configured: true,
    configuredBy: row.configured_by ?? undefined,
    configuredAt: row.configured_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Seal a platform secret bound to its vendor, so a row cannot be moved. */
function aadVendor(vendor: string): string {
  return `platform:${vendor}`;
}

/**
 * The bootstrap admin list, from the environment.
 *
 * Someone has to be the first admin, and they cannot be promoted through a
 * screen only an admin can reach. `PLATFORM_ADMIN_EMAILS` breaks that circle
 * and does nothing else — once a real admin exists, promotion happens in the
 * product and this can be emptied.
 *
 * Deliberately not `ALLOWED_EMAILS`: that is who may *use* Engine, and reusing
 * it would make every customer a platform admin the moment one is invited.
 * Unset means nobody, not everybody.
 */
export function isBootstrapAdmin(email: string | undefined, env: { PLATFORM_ADMIN_EMAILS?: string }): boolean {
  if (!email) return false;
  const list = (env.PLATFORM_ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (list.length === 0) return false;
  return list.includes(email.trim().toLowerCase());
}

/**
 * Whether this person works on Engine.
 *
 * The stored role wins, and the environment list is only a bootstrap. Checked
 * in that order rather than the reverse: an admin *demoted* in the product must
 * actually lose access, and an env list that overrode the database would keep
 * letting them in until someone edited a Cloudflare variable.
 *
 * The exception is a user with no row yet — their first sign-in has not run
 * `upsertUser`. Falling back to the env list there is what makes the very first
 * bootstrap work at all.
 */
export async function isPlatformAdmin(
  db: Db,
  user: { id: string; email?: string },
  env: { PLATFORM_ADMIN_EMAILS?: string },
): Promise<boolean> {
  const rows = await db<{ platform_role: string }[]>`
    select platform_role from users where id = ${user.id}
  `;
  if (rows[0]) return rows[0].platform_role === 'admin';
  return isBootstrapAdmin(user.email, env);
}

/* ── Users and roles ─────────────────────────────────────────────────────── */

export type PlatformRole = 'admin' | 'user';

export interface PlatformUser {
  id: string;
  email?: string;
  name?: string;
  platformRole: PlatformRole;
  /** True when this person can sign in with a password. */
  hasCredential: boolean;
  createdAt: string;
}

/** Everyone who can sign in, for the admin Users screen. */
export async function listUsers(db: Db): Promise<PlatformUser[]> {
  const rows = await db<
    { id: string; email: string | null; name: string | null; platform_role: PlatformRole; created_at: Date; has_credential: boolean }[]
  >`
    select u.id, u.email, u.name, u.platform_role, u.created_at,
           (c.user_id is not null) as has_credential
    from users u
    left join user_credentials c on c.user_id = u.id
    order by u.platform_role, u.created_at
  `;
  return rows.map((r) => ({
    id: r.id,
    email: r.email ?? undefined,
    name: r.name ?? undefined,
    platformRole: r.platform_role,
    hasCredential: r.has_credential,
    createdAt: r.created_at.toISOString(),
  }));
}

export type SetRoleResult =
  | { ok: true; from: PlatformRole; to: PlatformRole }
  | { ok: false; reason: 'not-found' | 'last-admin' | 'self' };

/**
 * Change someone's platform role.
 *
 * Two refusals, both of which prevent a state nobody can recover from without
 * database access:
 *
 *   **self** — an admin cannot demote themselves. It is almost always a
 *   misclick, and on a one-admin deployment it locks the platform screens for
 *   everyone.
 *
 *   **last-admin** — the final admin cannot be demoted by anyone. Zero admins
 *   means Engine's OAuth client can never be changed again through the product.
 *
 * The count and the update are one transaction, so two concurrent demotions
 * cannot each see two admins and both proceed.
 */
export async function setPlatformRole(
  db: Db,
  subjectUserId: string,
  toRole: PlatformRole,
  actorUserId: string,
): Promise<SetRoleResult> {
  if (subjectUserId === actorUserId && toRole === 'user') return { ok: false, reason: 'self' };

  return (await db.begin(async (tx) => {
    const rows = await tx<{ platform_role: PlatformRole }[]>`
      select platform_role from users where id = ${subjectUserId} for update
    `;
    if (!rows[0]) return { ok: false, reason: 'not-found' } as SetRoleResult;
    const from = rows[0].platform_role;
    if (from === toRole) return { ok: true, from, to: toRole } as SetRoleResult;

    if (from === 'admin' && toRole === 'user') {
      const [{ count }] = await tx<{ count: string }[]>`
        select count(*)::text as count from users where platform_role = 'admin'
      `;
      if (Number(count) <= 1) return { ok: false, reason: 'last-admin' } as SetRoleResult;
    }

    await tx`update users set platform_role = ${toRole} where id = ${subjectUserId}`;
    await tx`
      insert into user_role_events (subject_user_id, actor_user_id, from_role, to_role)
      values (${subjectUserId}, ${actorUserId}, ${from}, ${toRole})
    `;
    return { ok: true, from, to: toRole } as SetRoleResult;
  })) as SetRoleResult;
}

/** How many platform admins exist. Used to warn when a deployment has none. */
export async function countAdmins(db: Db): Promise<number> {
  const [{ count }] = await db<{ count: string }[]>`
    select count(*)::text as count from users where platform_role = 'admin'
  `;
  return Number(count);
}

export async function getPlatformClientStatus(
  db: Db,
  vendor: PlatformVendor,
): Promise<PlatformClientStatus | null> {
  const rows = await db<PlatformRow[]>`select * from platform_credentials where vendor = ${vendor}`;
  return rows[0] ? toStatus(rows[0]) : null;
}

export interface SetPlatformClientInput {
  vendor: PlatformVendor;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  actorUserId: string;
}

export async function setPlatformClient(
  db: Db,
  keyring: Keyring,
  input: SetPlatformClientInput,
): Promise<PlatformClientStatus> {
  const sealed = await sealCredential(keyring, aadVendor(input.vendor), input.vendor, {
    kind: 'oauth2',
    refreshToken: input.clientSecret,
  });

  const existing = await getPlatformClientStatus(db, input.vendor);

  const [row] = await db<PlatformRow[]>`
    insert into platform_credentials (
      vendor, client_id, client_secret_sealed, key_version, redirect_uri, configured_by
    )
    values (
      ${input.vendor}, ${input.clientId}, ${sealed.sealed}, ${sealed.keyVersion},
      ${input.redirectUri}, ${input.actorUserId}
    )
    on conflict (vendor) do update set
      client_id = excluded.client_id,
      client_secret_sealed = excluded.client_secret_sealed,
      key_version = excluded.key_version,
      redirect_uri = excluded.redirect_uri,
      configured_by = excluded.configured_by,
      updated_at = now()
    returning *
  `;

  await recordPlatformEvent(db, {
    vendor: input.vendor,
    type: existing ? 'rotated' : 'configured',
    actorUserId: input.actorUserId,
    // Client id only. It is public, and it is the one value that makes the
    // trail useful — "which app was this pointing at in March".
    detail: `client_id=${input.clientId}`,
  });
  return toStatus(row);
}

/**
 * Remove Engine's client for a vendor.
 *
 * Customers' stored grants are left alone. They become unusable, because a
 * refresh needs the client that issued them, and they become usable again the
 * moment the same client is restored — which is the right behaviour for an
 * operator who cleared it by mistake.
 */
export async function clearPlatformClient(
  db: Db,
  vendor: PlatformVendor,
  actorUserId: string,
): Promise<boolean> {
  const rows = await db`delete from platform_credentials where vendor = ${vendor} returning vendor`;
  if (rows.length === 0) return false;
  await recordPlatformEvent(db, { vendor, type: 'cleared', actorUserId });
  return true;
}

/**
 * The OAuth client for a vendor, opened for use.
 *
 * The one function that returns the secret, and the only caller is the request
 * path that must present it to the vendor's token endpoint.
 */
export interface ResolvedPlatformClient {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export async function resolvePlatformClient(
  db: Db,
  keyring: Keyring,
  vendor: PlatformVendor,
): Promise<ResolvedPlatformClient | null> {
  const rows = await db<PlatformRow[]>`select * from platform_credentials where vendor = ${vendor}`;
  const row = rows[0];
  if (!row) return null;
  const opened = await openCredential(keyring, aadVendor(vendor), vendor, {
    kind: 'oauth2',
    sealed: row.client_secret_sealed,
    keyVersion: row.key_version,
    public: {},
  });
  /* c8 ignore next -- sealed as 'oauth2' above, so this is always the branch. */
  if (opened.credential.kind !== 'oauth2') return null;
  return {
    clientId: row.client_id,
    clientSecret: opened.credential.refreshToken,
    redirectUri: row.redirect_uri,
  };
}

/**
 * The secret that signs OAuth `state`, generated on first use.
 *
 * Previously `OAUTH_STATE_SECRET`, set by hand. There is no reason a human
 * should choose it: it is machine-generated randomness with no meaning outside
 * this deployment, and asking someone to invent one invites a weak value.
 *
 * Generated lazily and stored sealed, so the first consent flow after
 * configuring a client creates it and every later flow reuses it. Rotating it
 * only invalidates consent links that are already in flight, which expire in
 * ten minutes anyway.
 */
export async function ensureStateSecret(
  db: Db,
  keyring: Keyring,
  vendor: PlatformVendor,
): Promise<string | null> {
  const rows = await db<PlatformRow[]>`select * from platform_credentials where vendor = ${vendor}`;
  const row = rows[0];
  if (!row) return null;

  if (row.state_secret_sealed) {
    const opened = await openCredential(keyring, aadVendor(`${vendor}:state`), vendor, {
      kind: 'oauth2',
      sealed: row.state_secret_sealed,
      keyVersion: row.key_version,
      public: {},
    });
    /* c8 ignore next */
    if (opened.credential.kind === 'oauth2') return opened.credential.refreshToken;
  }

  const generated = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const sealed = await sealCredential(keyring, aadVendor(`${vendor}:state`), vendor, {
    kind: 'oauth2',
    refreshToken: generated,
  });
  // `where state_secret_sealed is null` so two concurrent first flows cannot
  // each generate one and have the loser's signed states fail to verify.
  const updated = await db<{ state_secret_sealed: string }[]>`
    update platform_credentials
    set state_secret_sealed = ${sealed.sealed}, updated_at = now()
    where vendor = ${vendor} and state_secret_sealed is null
    returning state_secret_sealed
  `;
  if (updated.length > 0) return generated;

  // Someone else won the race; use theirs.
  return ensureStateSecret(db, keyring, vendor);
}

function base64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* ── Audit ───────────────────────────────────────────────────────────────── */

export interface PlatformEventInput {
  vendor: string;
  type: 'configured' | 'rotated' | 'cleared';
  actorUserId: string;
  detail?: string;
}

export async function recordPlatformEvent(db: Db, input: PlatformEventInput): Promise<void> {
  try {
    await db`
      insert into platform_credential_events (vendor, event_type, actor, detail)
      values (${input.vendor}, ${input.type}, ${`user:${input.actorUserId}`}, ${input.detail ?? null})
    `;
  } catch {
    // Same trade as the per-account trail: losing an event must not fail the
    // operation that produced it.
  }
}

export interface PlatformEventRow {
  id: string;
  vendor: string;
  type: string;
  actor: string;
  detail?: string;
  occurredAt: string;
}

export async function listPlatformEvents(db: Db, limit = 50): Promise<PlatformEventRow[]> {
  const rows = await db<
    { id: string; vendor: string; event_type: string; actor: string; detail: string | null; occurred_at: Date }[]
  >`
    select * from platform_credential_events
    order by occurred_at desc
    limit ${Math.min(Math.max(limit, 1), 200)}
  `;
  return rows.map((r) => ({
    id: r.id,
    vendor: r.vendor,
    type: r.event_type,
    actor: r.actor,
    detail: r.detail ?? undefined,
    occurredAt: r.occurred_at.toISOString(),
  }));
}

/** Engine's GitHub App: the App id and its private key. */
export interface ResolvedGitHubApp {
  appId: string;
  privateKeyPem: string;
  setupRedirectUri: string;
}

/**
 * Engine's GitHub App credentials, or null when no administrator has
 * registered one. Separate from `resolvePlatformClient` because the two are
 * different things behind the same columns — an OAuth client id and secret
 * against an App id and a signing key — and a caller that wanted one and got
 * the other would fail somewhere much less obvious than here.
 */
export async function resolveGitHubApp(
  db: Db,
  keyring: Keyring,
): Promise<ResolvedGitHubApp | null> {
  const resolved = await resolvePlatformClient(db, keyring, 'github');
  if (!resolved) return null;
  return {
    appId: resolved.clientId,
    privateKeyPem: resolved.clientSecret,
    setupRedirectUri: resolved.redirectUri,
  };
}
