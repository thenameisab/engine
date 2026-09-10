-- Give the four deterministic audits (entity, off-site, competitor, local) a
-- run history, so they can leave a button behind.
--
-- Each of the four persists only its *results*: entity_graph_audits,
-- citation_opportunities, competitor_gaps, local_audits. Every one of those
-- tables carries an updated_at, so "when did this last run?" looks answerable
-- from max(updated_at) — and it is not. An audit that runs and finds nothing
-- writes no row at all, so max(updated_at) is null and the screen would say
-- "never run" about an audit that ran ten minutes ago and returned a clean
-- result. A clean result is the answer a customer most wants to trust, so the
-- one case the product must not misreport is exactly the case that breaks.
--
-- This table records the run itself, whatever it found. It also drives the
-- nightly pass's due-check: without it the scheduler would have to infer
-- "already done tonight" from result rows, which has the same blind spot.
create table deterministic_audit_runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  -- Null for 'entity': that audit runs over every entity in the project at
  -- once and has no single subject. The other three are per-entity.
  entity_id uuid references entities(id) on delete cascade,
  kind text not null check (kind in ('entity', 'offsite', 'competitor', 'local')),
  -- Why it ran. A customer reading "last run 3 minutes ago" should be able to
  -- tell a crawl's automatic pass from their own button press.
  trigger text not null check (trigger in ('crawl', 'schedule', 'manual')),
  findings_count integer not null default 0,
  ran_at timestamptz not null default now()
);

-- The screens read the newest run per kind for one project; the scheduler asks
-- the same question across every project. Both are served by this index.
create index deterministic_audit_runs_lookup_idx
  on deterministic_audit_runs (project_id, kind, ran_at desc);
