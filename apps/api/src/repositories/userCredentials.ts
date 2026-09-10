/**
 * Reads and writes for `user_credentials` (migration 0016) — the roster that
 * used to be the `LOCAL_AUTH_USERS` Worker secret.
 *
 * Lookup is by principal id, never by email, and that is deliberate. The id
 * for a credential user is `local:<lowercased email>`, derived by
 * `localUserId()`, so this needs no unique index on `users.email` — an index
 * that does not exist and could not be added safely, because Neon Auth rows
 * may legitimately repeat an address across providers.
 */
import type { Db } from '../db.js';
import { localUserId, type LocalUser } from '@engine/auth';

export interface StoredCredential {
  user: LocalUser;
  passwordHash: string;
}

/**
 * Fetch the stored credential for an email address, or null.
 *
 * Joins `users` for the display name so a successful sign-in can mint a token
 * that carries it, exactly as the roster version did.
 */
export async function getCredentialByEmail(db: Db, email: string): Promise<StoredCredential | null> {
  const id = localUserId(email);
  const rows = await db<{ id: string; email: string | null; name: string | null; password_hash: string }[]>`
    select u.id, u.email, u.name, c.password_hash
    from user_credentials c
    join users u on u.id = c.user_id
    where c.user_id = ${id}
    limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    user: { id: row.id, email: row.email ?? email.trim().toLowerCase(), name: row.name ?? '' },
    passwordHash: row.password_hash,
  };
}

/**
 * Create or update a credential user: the `users` row and its hash together.
 *
 * One transaction, for the same reason `createAccount` is one (see
 * repositories/accounts.ts and the 2026-08-25 orphan-account triage): the two
 * rows are one fact. A `users` row with no credential is a person who cannot
 * sign in and whom nothing reports as missing, and the credential insert FKs
 * to the user row, so the order matters and a failure between them must undo
 * both.
 */
export async function upsertCredential(
  db: Db,
  user: { id: string; email: string; name: string },
  passwordHash: string,
): Promise<void> {
  if (!passwordHash.trim()) throw new Error('refusing to store a blank password hash');
  await db.begin(async (tx) => {
    await tx`
      insert into users (id, email, name)
      values (${user.id}, ${user.email}, ${user.name})
      on conflict (id) do update set email = excluded.email, name = excluded.name
    `;
    await tx`
      insert into user_credentials (user_id, password_hash)
      values (${user.id}, ${passwordHash})
      on conflict (user_id) do update
        set password_hash = excluded.password_hash,
            password_changed_at = now(),
            updated_at = now()
    `;
  });
}

/**
 * Replace only the hash, leaving `password_changed_at` alone.
 *
 * This is the transparent-rehash path: the password did not change, its work
 * factor did. Touching `password_changed_at` here would make the column lie
 * about when someone last chose a new password.
 */
export async function updatePasswordHash(db: Db, userId: string, passwordHash: string): Promise<void> {
  await db`
    update user_credentials
    set password_hash = ${passwordHash}, updated_at = now()
    where user_id = ${userId}
  `;
}

/** How many credentials exist — for the readiness endpoint, which must not reveal who they are. */
export async function countCredentials(db: Db): Promise<number> {
  const rows = await db<{ count: string }[]>`select count(*)::text as count from user_credentials`;
  return Number(rows[0]?.count ?? 0);
}

/**
 * Set or replace a user's own password (`POST /auth/password`).
 *
 * The `users` row already exists — the caller is signed in — so only the
 * credential is written. `password_changed_at` moves, because this is the
 * person choosing a new password, not a transparent re-hash.
 */
export async function setPassword(db: Db, userId: string, passwordHash: string): Promise<void> {
  if (!passwordHash.trim()) throw new Error('refusing to store a blank password hash');
  await db`
    insert into user_credentials (user_id, password_hash, password_changed_at, updated_at)
    values (${userId}, ${passwordHash}, now(), now())
    on conflict (user_id) do update
      set password_hash = excluded.password_hash,
          password_changed_at = now(),
          updated_at = now()
  `;
}
