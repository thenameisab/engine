-- 0033: sign in by email, invite by email, and count the attempts.
--
-- Three tables for wave 2 of the 2026-09-10 action plan (issues 1b, 4, 13):
-- one-time sign-in codes, account invitations, and the attempt log that
-- login rate limiting reads. Postgres for all three rather than KV or a
-- Durable Object, because it is the store this deployment already has and the
-- volumes are a handful of rows a day.

-- A code sent to an address. The code itself is never stored: `code_hash` is
-- SHA-256 over `<id>:<code>`, so a database read yields nothing that signs
-- anyone in, and the row id salts it so two people sent "482913" in the same
-- minute do not share a hash.
--
-- `attempts` is the per-code guess counter — six digits is a million codes,
-- and an unlimited verifier would be brute-forced in an afternoon. `consumed_at`
-- makes a code single-use; an unconsumed, unexpired code with attempts to
-- spare is the only kind `verify` accepts.
create table login_codes (
  id uuid primary key default gen_random_uuid(),
  -- Lower-cased at the boundary, so the lookup is exact.
  email text not null,
  code_hash text not null,
  expires_at timestamptz not null,
  attempts integer not null default 0,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

-- `verify` reads the newest open code for an address; `request` counts how
-- many were sent recently. Both walk this index.
create index login_codes_email_idx on login_codes (email, created_at desc);

-- An invitation to join an account. No token: the invitee proves the address
-- by signing in with a code sent to it, and that sign-in accepts every pending
-- invitation for the address. So an invitation is a standing fact ("this
-- address may join this account as this role") with an expiry, not a secret.
--
-- Membership itself is still only ever written to `account_members` — this
-- table records the intent, `acceptInvitations` writes the row, and the
-- schema-invariant test that keeps `account_members` the single path from a
-- user to an account holds.
create table invitations (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  email text not null,
  role text not null default 'member' check (role in ('owner', 'member')),
  -- Who sent it. Kept when the inviter's user row goes, because the invitation
  -- is still the account's, not theirs.
  invited_by text references users(id) on delete set null,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);

-- One open invitation per address per account. A repeat invite updates the
-- expiry rather than adding a second row.
create unique index invitations_open_idx on invitations (account_id, email) where accepted_at is null;
-- Sign-in accepts by address.
create index invitations_email_open_idx on invitations (email) where accepted_at is null;

-- Every sign-in attempt, by kind and subject, so a route can ask "how many in
-- the last fifteen minutes". The subject is a lower-cased email or a client
-- IP; the kind says which door was tried. Rows are pruned after a day by the
-- code that writes them — there is nothing to learn from an attempt older
-- than the largest window.
create table auth_attempts (
  id bigserial primary key,
  kind text not null check (kind in ('password', 'code-request', 'code-verify')),
  subject text not null,
  created_at timestamptz not null default now()
);

create index auth_attempts_lookup_idx on auth_attempts (kind, subject, created_at desc);
