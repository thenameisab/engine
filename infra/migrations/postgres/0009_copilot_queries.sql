-- M2.4 "Copilot GA": NL question -> cited, drill-downable answer <3s. The
-- answer itself is computed from data three pillars already persist (A1/A2/B1
-- joined entity-first), so this migration adds no new answer data — only a
-- log of what was asked, so latency against the <3s budget and intent coverage
-- (how often we land on `unknown`) are measurable in production rather than
-- guessed at.
--
-- One row per answered question. `entity_id` is nullable: an `unknown` intent
-- resolved no entity, and that is exactly the row we most want to see (a
-- question the taxonomy couldn't map). `latency_ms` is the server-measured
-- round trip including retrieval and phrasing.
create table copilot_queries (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  entity_id uuid references entities(id) on delete set null,
  question text not null,
  intent text not null,
  latency_ms integer not null,
  asked_at timestamptz not null default now()
);

create index copilot_queries_project_id_idx on copilot_queries(project_id);
