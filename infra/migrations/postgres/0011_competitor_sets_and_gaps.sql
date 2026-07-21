-- A5 Competitor Intelligence. Two things must persist that findings alone
-- can't carry: (1) which competitors a project tracks (the competitor set,
-- spec §4.1), and (2) the ranked gap list — the lead metric "biggest gaps to
-- close" (spec §8), which is continuous like B3's strength score and only
-- partly crosses the finding threshold. Mirrors 0010 (entity_graph_audits):
-- persist the current computation, upserted on re-run, not a history.

-- The competitor set: the project's self-entity paired with each competitor
-- entity it is measured against. Both are entities in the entity-first model
-- (Architecture §1) — a competitor is not a special record, it is an Entity —
-- so gap analysis reads the same keywords/prompts/citations/mentions columns
-- for both sides. One row per (self, competitor) link.
create table competitor_sets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  self_entity_id uuid not null references entities(id) on delete cascade,
  competitor_entity_id uuid not null references entities(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (project_id, self_entity_id, competitor_entity_id)
);

create index competitor_sets_project_id_idx on competitor_sets(project_id);

-- The persisted ranked gaps for a project's self-entity. Upserted per
-- (self_entity, gap_type, item) so a re-run refreshes impact/held-by in place
-- rather than accumulating duplicates. `item` is the specific missing thing (a
-- keyword, prompt, topic, referring domain) or the stronger competitor's name
-- for the entity gap; `held_by` is the competitor entity ids that hold it.
create table competitor_gaps (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  self_entity_id uuid not null references entities(id) on delete cascade,
  gap_type text not null,
  item text not null,
  held_by_count integer not null,
  held_by jsonb not null default '[]'::jsonb,
  impact numeric not null,
  evidence jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  unique (self_entity_id, gap_type, item)
);

create index competitor_gaps_project_id_idx on competitor_gaps(project_id);
create index competitor_gaps_self_entity_idx on competitor_gaps(self_entity_id);
