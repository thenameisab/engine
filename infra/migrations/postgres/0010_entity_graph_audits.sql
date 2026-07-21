-- B3 Entity & Knowledge Graph Audit: the lead metric (spec §8) is an entity's
-- strength/corroboration score, which — like B1's health score — is a property
-- of an audit run and can't be recomputed from findings alone (the findings
-- only fire below a threshold; the score is continuous). Persist the latest
-- strength breakdown per entity so the dashboard shows a real number, and the
-- Copilot can join it entity-first alongside A1/A2/B1.
--
-- One row per entity (upserted on re-audit): the "current" strength, not a
-- history. The component sub-scores are stored split out so the UX can show
-- *why* an entity is weak (missing schema vs. weak corroboration), not just
-- the blend.
create table entity_graph_audits (
  entity_id uuid primary key references entities(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  score numeric not null,
  wikidata_score numeric not null,
  schema_score numeric not null,
  sameas_score numeric not null,
  corroboration_score numeric not null,
  corroborating_domains integer not null,
  updated_at timestamptz not null default now()
);

create index entity_graph_audits_project_id_idx on entity_graph_audits(project_id);
