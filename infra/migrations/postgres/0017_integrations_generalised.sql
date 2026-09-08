-- Generalise the integration tables from "three Google products" to "any
-- vendor, OAuth or API key".
--
-- Migration 0014 built the right shape for the wrong scope. Its three-table
-- split — connection, credential, assignment — was correct and survives here
-- untouched. What did not survive contact with a second vendor is everything
-- that assumed the vendor was Google:
--
--   * `check (provider in ('gsc','ga4','gbp'))` — adding Bing meant a migration
--   * `google_subject` / `google_email` — HubSpot has a portal id, not an email
--   * `refresh_token_sealed` — an API key is not a refresh token, and a column
--     named for one is a column every reader has to guess about
--   * `entity_shape` and the one-property-per-project index, both of which
--     hardcoded the same three ids
--
-- The provider set now lives in `@engine/integrations`'s registry, which is
-- also what the API validates against. Moving that check out of the database
-- is a deliberate trade: the database stops rejecting a typo'd provider id,
-- and in exchange adding a vendor stops requiring a schema change. The
-- application gate (`assertConnectable`) is the single place that decides, and
-- it is exercised by every route that touches a credential.
--
-- Shape rules that *are* still enforced here are the ones that describe data
-- rather than vocabulary: an assignment scoped to an entity must name one, and
-- a project-scoped provider must not be assigned twice.

/* ── connections ─────────────────────────────────────────────────────────── */

-- Vendor-neutral names. `sub` is the stable key; the label is for display and
-- can change under the customer (an email is renamed, a portal is retitled).
alter table integration_connections rename column google_subject to external_subject;
alter table integration_connections rename column google_email to external_label;

-- The registry decides what a provider is. See the note above.
alter table integration_connections drop constraint if exists integration_connections_provider_check;

-- Which encryption key sealed this connection's credential, so the keyring can
-- rotate without invalidating every stored connection. Nullable: rows written
-- before this migration were sealed under the single unversioned key, which
-- `@engine/integrations` loads as 'v1'.
alter table integration_credentials add column if not exists key_version text not null default 'v1';

-- What is actually in the sealed blob. 'oauth2' holds a refresh token;
-- 'api_key' holds a JSON object of the vendor's secret fields. Without this a
-- reader has to infer the kind from the provider id, which puts the registry
-- in the query path of every credential read.
alter table integration_credentials
  add column if not exists credential_kind text not null default 'oauth2'
  check (credential_kind in ('oauth2', 'api_key'));

-- Renamed to match: the column holds whichever secret `credential_kind` says.
alter table integration_credentials rename column refresh_token_sealed to secret_sealed;

-- Non-secret fields of an API-key credential — a site URL, a username, a
-- region. Deliberately *not* in the sealed blob: the UI has to show what is
-- configured, and a connection whose settings cannot be displayed cannot be
-- diagnosed. Empty for OAuth.
alter table integration_credentials add column if not exists public_fields jsonb not null default '{}'::jsonb;

/* ── assignments ─────────────────────────────────────────────────────────── */

-- Both old constraints named the three Google ids. Replaced by the same rules
-- expressed against a column that says which shape this row is, written from
-- the registry's `resourceScope` at insert time.
alter table integration_assignments drop constraint if exists integration_assignments_entity_shape;
drop index if exists integration_assignments_one_property_per_project;

alter table integration_assignments
  add column if not exists resource_scope text not null default 'project'
  check (resource_scope in ('project', 'entity'));

-- Backfill before the shape rule is enforced: gbp rows are the entity-scoped
-- ones, and they are the only rows that can exist at this point.
update integration_assignments set resource_scope = 'entity' where provider = 'gbp';

-- The same rule as before, now stated in terms of the scope rather than a list
-- of provider ids: an entity-scoped assignment names its entity, a
-- project-scoped one does not.
alter table integration_assignments
  add constraint integration_assignments_scope_shape check (
    (resource_scope = 'entity' and entity_id is not null)
    or (resource_scope = 'project' and entity_id is null)
  );

-- "A project has one Search Console property" generalised: a project-scoped
-- provider is assigned at most once per project. Entity-scoped providers are
-- excluded, which is what lets one project own many locations.
create unique index integration_assignments_one_resource_per_project
  on integration_assignments(project_id, provider)
  where resource_scope = 'project';

/* ── audit trail ─────────────────────────────────────────────────────────── */

-- What was done to a customer's credential, append-only.
--
-- `integration_connections` records that a connection exists and who created
-- it. It cannot answer the questions asked after an incident — when did this
-- grant start failing, who disconnected the Business Profile last Tuesday,
-- was the credential used between the revocation and our noticing — because
-- it is overwritten in place. This table is not.
--
-- No foreign key to `integration_connections`: the events must outlive the
-- connection they describe, and a disconnect that erased its own audit trail
-- would defeat the purpose. `account_id` cascades, because deleting an account
-- is a deliberate erasure of that customer's data.
create table integration_events (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  provider text not null,

  event_type text not null check (
    event_type in (
      'connect_started', 'connected', 'connect_failed',
      'refreshed', 'refresh_failed',
      'disconnected', 'key_rotated', 'assignment_changed'
    )
  ),

  -- 'user:<id>' or 'service:<name>'. A nightly sync refreshing a token is not
  -- the person who connected it in March, and recording it as them would make
  -- the trail actively misleading.
  actor text not null,

  -- Machine-readable failure reason from IntegrationError, for the failure
  -- events. Null on success.
  reason text,
  -- Human context. Redacted before it arrives — vendor error bodies routinely
  -- echo the request, including secrets. See packages/integrations/src/redact.ts.
  detail text,
  -- Non-secret structured context: resource ids, scope names, key versions.
  metadata jsonb not null default '{}'::jsonb,

  occurred_at timestamptz not null default now()
);

-- The two queries this table exists to answer: "what happened to this account's
-- integrations" and "what happened to this provider", both newest-first.
create index integration_events_account_idx on integration_events(account_id, occurred_at desc);
create index integration_events_provider_idx on integration_events(account_id, provider, occurred_at desc);
