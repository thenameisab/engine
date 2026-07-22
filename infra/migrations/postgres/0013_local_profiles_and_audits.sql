-- B5 Local SEO Audit (v1.5). Two things persist per location (a location is an
-- entity, spec §5): the profile facts B5 audits, and the computed local
-- visibility score. Until the GBP API connector lands, the profile is settable
-- via PUT (the same pattern M2.3 used for projects.deploy_target) so the audit
-- and the whole Fix Queue loop can be exercised against real data now. The
-- score, like B3's strength and A5's gaps, is a continuous computation that
-- only partly crosses the finding threshold, so it's persisted separately.

-- The settable profile facts for one location (Name/Address/Phone, GBP fields,
-- directory listings, reviews) as a single jsonb document — the connector will
-- write the same shape later. One row per entity, upserted.
create table local_profiles (
  entity_id uuid primary key references entities(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  profile jsonb not null,
  updated_at timestamptz not null default now()
);

create index local_profiles_project_id_idx on local_profiles(project_id);

-- The latest local visibility breakdown per location (spec §8 lead metric),
-- upserted on re-audit. Components stored split out so the UX shows *why* a
-- location scores low (thin GBP vs inconsistent NAP vs unhealthy reviews).
create table local_audits (
  entity_id uuid primary key references entities(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  score numeric not null,
  gbp_score numeric not null,
  nap_score numeric not null,
  review_score numeric not null,
  reviews_considered integer not null,
  updated_at timestamptz not null default now()
);

create index local_audits_project_id_idx on local_audits(project_id);
