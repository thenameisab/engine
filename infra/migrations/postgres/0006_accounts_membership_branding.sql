-- M2.5 agency white-label: the accounts/projects tables (0001_init.sql) already
-- had the right shape -- one account owns many projects -- but nothing ever
-- linked a signed-in identity to an account, and nothing could create either
-- row at all (every account/project in this environment was seeded straight
-- into Postgres). This is the foundation a "multi-client grid" needs to exist
-- safely: a real membership model, not just a caller-supplied accountId.

-- Mirrors apps/api/src/middleware/auth.ts's AuthUser.id (the Neon Auth JWT
-- `sub` claim). Upserted lazily on first authenticated request rather than
-- synced via a webhook -- there is no Neon Auth webhook wired, and an
-- account_members row needs a real users row to FK against regardless of
-- when the sync happens.
create table users (
  id text primary key,
  email text,
  name text,
  created_at timestamptz not null default now()
);

-- Which accounts a user belongs to, and at what level. 'owner' is the account
-- creator; 'member' is a later-invited teammate (invite flow itself is out of
-- scope for this slice -- nothing seeds a 'member' row yet, but the role
-- column exists so adding that flow later is additive, not a redesign).
create table account_members (
  account_id uuid not null references accounts(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  role text not null default 'owner' check (role in ('owner', 'member')),
  created_at timestamptz not null default now(),
  primary key (account_id, user_id)
);

create index account_members_user_id_idx on account_members(user_id);

-- Agency white-label branding: {companyName?, logoUrl?, primaryColor?}.
-- Validated at the API boundary (apps/api/src/validate.ts), not by a DB
-- constraint -- consistent with every other jsonb column in this schema
-- (entities.schema, findings.evidence, actions.diff).
alter table accounts add column branding jsonb not null default '{}';
