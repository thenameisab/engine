-- Per-account Google OAuth connections — the foundation for GSC, GA4 and GBP
-- being connected by the customer in the product, rather than by us as Worker
-- secrets.
--
-- Every integration before this one held one credential for the whole
-- deployment: one SERPER_API_KEY, one GBP_REFRESH_TOKEN, set with
-- `wrangler secret put` and identical for every customer. That works for a
-- vendor key we pay for. It cannot work for a customer's Search Console
-- property or their Business Profile, where the credential belongs to them,
-- arrives at runtime, and must be revocable by them alone.
--
-- Three tables. "Which Google account consented" and "which of its properties
-- belongs to which project" are genuinely different facts with different
-- lifetimes: an agency consents once with a Google account that can see forty
-- client properties, then maps them onto forty projects. Re-consent must not
-- discard that mapping, and re-assigning a property must not force re-consent.
--
-- The credential is the third, split out so that no read of a connection can
-- leak it by omission. See `integration_credentials`.

-- One consented Google account per (account, provider).
--
-- Deliberately holds no credential. The sealed refresh token lives in
-- `integration_credentials` below, so `select *` on this table is safe by
-- construction — see that table's comment for why that is worth a second table.
create table integration_connections (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  provider text not null check (provider in ('gsc', 'ga4', 'gbp')),

  -- Which Google identity consented. Read from the id_token's `sub`/`email` at
  -- callback time, and shown in the UI so a user can tell *whose* access is
  -- wired before they rely on it or revoke it. `sub` is the stable key; email
  -- is a display label and can change.
  google_subject text,
  google_email text,

  -- The scopes Google actually granted, which is not always what we asked for
  -- — a user can uncheck one on the consent screen. Stored so a feature can
  -- say "this needs a scope you did not grant" instead of failing on the call.
  granted_scopes text[] not null default '{}',

  -- 'connected'     — usable.
  -- 'needs_reauth'  — Google rejected the refresh token (user revoked access,
  --                   changed password, or the grant expired). Distinct from
  --                   'revoked' because the fix is different: the user must
  --                   re-consent, and the UI has to say so rather than
  --                   silently returning stale data.
  -- 'revoked'       — disconnected from our side. The row is kept so the audit
  --                   trail survives; its `integration_credentials` row is
  --                   deleted, so no credential outlives the disconnect.
  status text not null default 'connected' check (status in ('connected', 'needs_reauth', 'revoked')),

  -- Who wired it up. `on delete set null`: the connection must outlive the
  -- employee who created it, or an offboarding silently breaks the account's
  -- data sync.
  connected_by text references users(id) on delete set null,
  connected_at timestamptz not null default now(),

  -- Refresh-health, for the UI and for diagnosing a stalled sync. last_error
  -- holds Google's message on the most recent failure; it is operational
  -- detail, never a credential.
  last_refresh_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now(),

  unique (account_id, provider)
);

create index integration_connections_account_id_idx on integration_connections(account_id);

-- The sealed refresh token, in its own table.
--
-- A 1:1 table for a single column looks like over-normalisation until you ask
-- what happens when someone writes `select * from integration_connections` in a
-- year's time. With the token in that table, the answer is that a live
-- customer credential lands in an API response, and nothing catches it: not the
-- type checker, not a test, not review unless the reader happens to recognise
-- the column name. Keeping the token here makes that mistake impossible rather
-- than merely discouraged, and it removes the hand-maintained "every column
-- except the token" list that every read would otherwise need.
--
-- It also narrows the answer to "what can see this credential": one table name,
-- one reader (`getAccessToken` in apps/api/src/repositories/integrations.ts).
--
-- The value is AES-256-GCM sealed under the ENCRYPTION_KEY Worker secret
-- (packages/auth/src/secretBox.ts), with the account id and provider bound in
-- as authenticated additional data — so a blob lifted from one row into another
-- fails to open rather than yielding a usable token. The key is never written
-- to this database, so a Postgres dump alone does not hand over write access to
-- a customer's Business Profile.
--
-- Disconnecting deletes this row and leaves the connection behind, so the
-- audit trail of who connected what and when survives having revoked it.
create table integration_credentials (
  -- PK, not just a FK: one credential per connection, enforced rather than
  -- assumed. `on delete cascade` means dropping a connection cannot strand a
  -- token nobody can reach but which is still on disk.
  connection_id uuid primary key references integration_connections(id) on delete cascade,
  -- 'v1.<iv>.<ciphertext>', base64. See packages/auth/src/secretBox.ts.
  refresh_token_sealed text not null,
  updated_at timestamptz not null default now()
);

-- Lets integration_assignments carry a provider that is guaranteed to match
-- its connection's, via a composite foreign key (below).
create unique index integration_connections_id_provider_key on integration_connections(id, provider);

-- Which provider-side resource is assigned to which project.
--
-- `resource_id` is the provider's own identifier, kept verbatim so a later API
-- call needs no reconstruction:
--   gsc — the siteUrl, e.g. 'sc-domain:example.com' or 'https://example.com/'
--   ga4 — the property id, e.g. 'properties/123456789'
--   gbp — the location resource name, e.g. 'locations/12345678901234567890'
--
-- entity_id is set for gbp only. A location *is* an entity in this schema
-- (B5, migration 0013), so a GBP assignment resolves to the entity whose
-- local_profiles row the sync writes. GSC and GA4 describe the whole site, so
-- they attach to the project and leave it null.
create table integration_assignments (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references integration_connections(id) on delete cascade,

  -- Denormalized from the connection so the partial unique index below can see
  -- it. The composite FK makes the copy non-divergent: a row whose provider
  -- disagrees with its connection's cannot be inserted.
  provider text not null,

  project_id uuid not null references projects(id) on delete cascade,
  entity_id uuid references entities(id) on delete cascade,

  resource_id text not null,
  -- Human label as Google reports it (site name, property display name, store
  -- name), so the UI can list assignments without a live API call.
  resource_label text,

  created_at timestamptz not null default now(),

  foreign key (connection_id, provider) references integration_connections(id, provider) on delete cascade,

  -- The same resource must not be assigned to one project twice.
  unique (connection_id, project_id, resource_id),

  -- gbp assignments must name the entity they write to; gsc/ga4 must not.
  constraint integration_assignments_entity_shape check (
    (provider = 'gbp' and entity_id is not null) or (provider in ('gsc', 'ga4') and entity_id is null)
  )
);

create index integration_assignments_project_id_idx on integration_assignments(project_id);
create index integration_assignments_connection_id_idx on integration_assignments(connection_id);
create index integration_assignments_entity_id_idx on integration_assignments(entity_id);

-- A project has exactly one Search Console property and one GA4 property —
-- "the site's search performance" is not a sum over several. GBP is
-- deliberately excluded: one project can own many locations, which is the
-- whole point of B5's multi-location audit.
create unique index integration_assignments_one_property_per_project
  on integration_assignments(project_id, provider)
  where provider in ('gsc', 'ga4');
