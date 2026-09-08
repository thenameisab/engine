-- Audit requests: the queue between "Run audit" in the product and the crawl
-- runner outside Workers (docs/46-Audit-Runner.md).
--
-- The product inserts a row; the runner (a GitHub Action, later possibly a
-- container) lists queued rows, claims one with a conditional update, crawls,
-- posts the result to /projects/:id/audit, and marks the row done or failed.
-- The dashboard polls the newest row per project to show progress.

create table audit_requests (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  -- The brand the crawled pages are attributed to (findings.entity_id).
  entity_id uuid not null references entities(id) on delete cascade,
  root_url text not null,
  max_pages integer not null default 50 check (max_pages between 1 and 500),
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  -- A user id, or 'service:internal' when the product queued it on a schedule.
  requested_by text not null,
  error text,
  audit_run_id uuid references audit_runs(id) on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

-- The dashboard reads the newest request per project.
create index audit_requests_project_created_idx on audit_requests (project_id, created_at desc);

-- The runner scans for queued work, oldest first.
create index audit_requests_live_idx on audit_requests (status, created_at)
  where status in ('queued', 'running');

-- One live request per project: a double click, or a second tab, is one crawl.
-- The insert that violates this is answered 409 by the API.
create unique index audit_requests_one_live_per_project on audit_requests (project_id)
  where status in ('queued', 'running');
