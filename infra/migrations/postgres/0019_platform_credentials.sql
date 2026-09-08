-- Engine's own OAuth client credentials, configurable in the product instead of
-- with `wrangler secret put`.
--
-- These are a different thing from `integration_credentials`, and conflating
-- them is what made the Integrations screen impossible to use:
--
--   integration_credentials — the *customer's* grant. One per account. The
--   customer creates it, assigns it, and revokes it, and nobody else can.
--
--   platform_credentials    — *Engine's* identity to a vendor. One per vendor
--   for the whole deployment. Every customer consents to this same OAuth app,
--   exactly as they would with Zapier or HubSpot. A customer must never see it
--   and must never be asked to create one.
--
-- The second was living in five Worker secrets, which meant the person who
-- registers Engine's Google app needed a terminal and Cloudflare access. That
-- is a one-time operator task, not a deployment detail, and it belongs on an
-- admin screen.
--
-- What deliberately does NOT move here: ENCRYPTION_KEY. It is the key these
-- rows are sealed with, so storing it alongside them would be circular — you
-- would need it to read it. It stays a Worker secret permanently, and it is
-- the only one that has to.
create table platform_credentials (
  -- The vendor whose OAuth app this is: 'google' today, one row per vendor
  -- later. Not a provider id — gsc, ga4 and gbp share one Google client, which
  -- is the whole reason `clientFor` keys off `provider.vendor`.
  vendor text primary key,

  -- Public half. Stored in the clear because it is not a secret — it appears
  -- in every authorization URL the browser is sent to — and because the admin
  -- screen has to show which client is configured without being able to reveal
  -- the secret half.
  client_id text not null,

  -- 'v1.<iv>.<ciphertext>', sealed exactly as a customer credential is
  -- (packages/auth/src/secretBox.ts), with the vendor bound in as AAD.
  client_secret_sealed text not null,
  key_version text not null default 'v1',

  -- The redirect URI registered with the vendor. Stored rather than derived
  -- from the request origin: the vendor compares it byte for byte, and a value
  -- that changes with the caller is the single most common setup failure.
  redirect_uri text not null,

  -- Signs the OAuth `state` parameter. Generated on first use and sealed here,
  -- so OAUTH_STATE_SECRET no longer has to be set by hand. Nullable because a
  -- row can be written before the first flow needs one.
  state_secret_sealed text,

  -- Who configured it and when. `on delete set null` so the row outlives the
  -- employee who created it.
  configured_by text references users(id) on delete set null,
  configured_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- An append-only record of changes to Engine's own credentials.
--
-- Separate from `integration_events`, which is per-account and readable by that
-- account's owner. Rotating the platform client silently disconnects every
-- customer at once, so who did it and when is a different question with a
-- different audience.
create table platform_credential_events (
  id uuid primary key default gen_random_uuid(),
  vendor text not null,
  event_type text not null check (event_type in ('configured', 'rotated', 'cleared')),
  -- 'user:<id>'. No service actor: nothing automatic may change these.
  actor text not null,
  -- Non-secret context only — never the client id or secret.
  detail text,
  occurred_at timestamptz not null default now()
);

create index platform_credential_events_vendor_idx
  on platform_credential_events(vendor, occurred_at desc);
