-- Property-level Search Console totals per day.
--
-- The two tables from migration 0015 are grouped by query and by page. Neither
-- sums to the number Search Console itself shows: Google leaves anonymised
-- queries out of the query dimension, so a sum over gsc_query_daily is lower
-- than the property's real click count, and a customer who compares the two
-- numbers stops trusting ours. The date-only request returns the property's
-- own totals, one row per day, and that is what the Pulse headline reads.
-- Sparklines read it too: 28 rows per period instead of a group-by over
-- thousands of query rows.
create table gsc_site_daily (
  project_id uuid not null references projects(id) on delete cascade,
  date date not null,
  clicks integer not null default 0,
  impressions integer not null default 0,
  ctr numeric not null default 0,
  position numeric not null default 0,
  synced_at timestamptz not null default now(),
  primary key (project_id, date)
);
