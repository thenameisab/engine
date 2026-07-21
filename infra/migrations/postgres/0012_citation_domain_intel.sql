-- A6 Backlink & Mention Index (v1.5). The lead metric (spec §8) is "citation
-- opportunities" — high-authority domains AI engines cite in the customer's
-- category where the entity is absent — mined from the A2 answer archive
-- (citation_events.sources_cited). Like B3's strength and A5's gaps, it is a
-- continuous computation that only partly crosses the finding threshold, so
-- persist the current ranked opportunity list per self-entity, upserted on
-- re-run. One row per (self_entity, domain).
create table citation_opportunities (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  self_entity_id uuid not null references entities(id) on delete cascade,
  domain text not null,
  authority numeric not null,
  citation_count integer not null,
  distinct_entities integer not null,
  impact numeric not null,
  updated_at timestamptz not null default now(),
  unique (self_entity_id, domain)
);

create index citation_opportunities_project_id_idx on citation_opportunities(project_id);
create index citation_opportunities_self_entity_idx on citation_opportunities(self_entity_id);
