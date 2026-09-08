-- Credential storage for the fixed pre-alpha roster, moved out of a Worker
-- secret and into the database.
--
-- Until now the three users lived in `LOCAL_AUTH_USERS`: `email:password:Name`,
-- comma-separated, in one Cloudflare secret. That was chosen deliberately (see
-- packages/auth/src/localAuth.ts) and it has two costs that grow with use.
-- Passwords sit in plaintext in the Worker's configuration, readable by anyone
-- who can open the dashboard or run `wrangler secret list`-adjacent tooling;
-- and changing one person means re-typing the whole roster, where a stray colon
-- silently drops a user rather than failing loudly.
--
-- Here the password is never stored. What is stored is a PBKDF2-HMAC-SHA-256
-- derivation of it, with a per-user random salt, in the self-describing format
-- `pbkdf2-sha256$<iterations>$<salt>$<hash>` (see packages/auth/src/passwordHash.ts).
-- The iteration count travels with each hash, so raising the work factor later
-- is a re-hash on next sign-in, not a migration and not a flag day.
--
-- Keyed by `user_id`, not by email, and that is the point rather than a detail:
-- the principal id for a credential user is `local:<lowercased email>`, derived
-- (localUserId), so a lookup needs no unique index on `users.email` — which does
-- not exist and could not be added safely, since Neon Auth rows may legitimately
-- repeat an address. One row per principal, cascading with it.

create table if not exists user_credentials (
  user_id text primary key references users (id) on delete cascade,

  -- `pbkdf2-sha256$<iterations>$<salt-b64url>$<hash-b64url>`. Never the password.
  password_hash text not null,

  -- When the password last changed. Not a security control on its own: an
  -- existing session token stays valid for its full TTL after a password
  -- change, because the token is signed by LOCAL_AUTH_SECRET and knows nothing
  -- about this table. Rotating that secret is what ends every session at once.
  password_changed_at timestamptz not null default now(),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A blank hash would be a credential that verifies against nothing, which is
-- safe, or against everything, depending on a future bug. Refuse it at the
-- boundary where the refusal cannot be forgotten.
alter table user_credentials
  add constraint user_credentials_hash_not_blank
  check (length(trim(password_hash)) > 0);
