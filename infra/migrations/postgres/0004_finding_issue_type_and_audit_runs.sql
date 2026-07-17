-- Make a persisted finding able to say what is wrong, and give the technical
-- health score somewhere to live.
--
-- Two gaps, both of which forced the dashboard's Audit view to stay on mocks:
--
-- 1. The issue type never survived the audit. packages/diagnosis used it to
--    pick the severity weight, the action templates and the fingerprint, then
--    dropped it: it was absent from the Finding contract and from this table.
--    A stored finding therefore carried a severity and an evidence blob but no
--    statement of the problem. It cannot be reconstructed later — the
--    fingerprint hashes it one-way (FNV-1a is not reversible), and inferring it
--    from action_templates is lossy, since schema-missing/schema-invalid and
--    meta-title-missing/meta-description-missing each share a single template.
--
-- 2. The health score (§8) was computed per crawl and thrown away. It is
--    normalized by pages audited, so it is a property of a *run*, not of the
--    finding inventory — and pages are not persisted (the rule engine takes
--    CrawledPage[] and keeps only what it concludes). Recomputing it from
--    findings alone is impossible; inventing one would be a number that means
--    nothing.

alter table findings add column issue_type text;

-- Existing rows predate the column and genuinely cannot be recovered, so they
-- say so rather than guessing. This self-heals: /audit upserts on
-- (entity_id, fingerprint) and now writes issue_type, so the next crawl that
-- still finds the issue replaces 'unknown' with the real type. Rows that never
-- reappear were already stale.
update findings set issue_type = 'unknown' where issue_type is null;

alter table findings alter column issue_type set not null;

-- Not a check constraint: each Pillar B source owns its own issue vocabulary
-- (B1 technical here, B2 content later), and pinning B1's list into the schema
-- would mean a migration every time the rule engine learns a new check. The
-- vocabulary is enforced in code, where it is defined.

-- One row per completed audit run. Keeps the score honest (it records the
-- pages_audited it was normalized by) and gives the score a history to be
-- trended against later, rather than only ever knowing "now".
create table audit_runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  pages_audited integer not null,
  findings_count integer not null,
  health_score integer not null,
  created_at timestamptz not null default now()
);

-- The Audit view reads the newest run per project.
create index audit_runs_project_created_idx on audit_runs (project_id, created_at desc);
