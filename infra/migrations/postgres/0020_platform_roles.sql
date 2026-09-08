-- Two kinds of person, told apart in the database rather than in a Worker
-- secret.
--
-- "Admin" was overloaded, and separating the two meanings is most of this
-- migration's value:
--
--   account_members.role ('owner' | 'member') — a role *inside one customer
--   account*. An owner may connect and disconnect that account's integrations
--   because the credential is shared by everyone in it. This already existed
--   and is unchanged.
--
--   users.platform_role ('admin' | 'user') — whether this person works on
--   Engine. It decides who may configure Engine's own OAuth client and who may
--   create other users. It has nothing to do with any customer account, and a
--   platform admin has no special access to customer *data* — see the note at
--   the bottom.
--
-- Previously the second lived in PLATFORM_ADMIN_EMAILS, which meant promoting
-- someone required Cloudflare access and a redeploy. That is the same mistake
-- the OAuth client had: a product decision expressed as deployment
-- configuration.
alter table users
  add column if not exists platform_role text not null default 'user'
  check (platform_role in ('admin', 'user'));

-- 'user' is the default on purpose. A column that defaults to 'admin' would
-- silently promote every existing row, and every row created by `upsertUser`
-- on first sign-in — which is every customer.
create index users_platform_role_idx on users(platform_role) where platform_role = 'admin';

-- An append-only record of who changed whose role.
--
-- Promotion is the single most consequential action in the product: it grants
-- the ability to replace Engine's OAuth client and to create further admins.
-- A role column alone cannot answer "who made this person an admin, and when",
-- because it is overwritten.
create table user_role_events (
  id uuid primary key default gen_random_uuid(),
  -- Not a FK: the trail must survive the deletion of either party. A promotion
  -- that vanishes when the promoted user is removed is the one record you would
  -- most want to still have.
  subject_user_id text not null,
  actor_user_id text not null,
  from_role text not null,
  to_role text not null,
  occurred_at timestamptz not null default now()
);

create index user_role_events_subject_idx on user_role_events(subject_user_id, occurred_at desc);

-- Deliberately NOT granted here: cross-account data access.
--
-- It would be easy to let a platform admin read every customer's Pulse, Audit
-- and Fix Queue, and a support person will eventually want exactly that. It is
-- not in this migration because it is a different decision with different
-- consequences — every such read is a staff member looking at a customer's
-- private data, and doing it properly needs a reason recorded per access, not
-- a boolean. `isAccountMember` therefore still governs all customer data, for
-- admins and users alike.
