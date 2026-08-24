-- Where synced Google data lands.
--
-- Postgres, not ClickHouse, and deliberately so: `infra/migrations/clickhouse/`
-- has a schema file but nothing in any `src/` connects to it, and migration 0005
-- already put the equivalent A1/A2 timeseries here for exactly that reason. A
-- synced metric with nowhere to land is a worse failure than one sitting in the
-- "wrong" database. When a managed ClickHouse exists, these column shapes copy
-- across.
--
-- Two GSC tables rather than one. Search Console will happily return
-- date × query × page, but that cross product is enormous and answers a question
-- nobody asks — "how did this one query perform on this one page on this one
-- day". The product asks two separate questions, keyword performance and page
-- performance, so it makes two narrower requests. Country and device are
-- deliberately not stored: no surface reads them yet, and dimensions we do not
-- use are cardinality for nothing. Adding them later is an additive migration.

-- GSC performance per query per day.
create table gsc_query_daily (
  project_id uuid not null references projects(id) on delete cascade,
  date date not null,
  query text not null,
  clicks integer not null default 0,
  impressions integer not null default 0,
  -- Google reports ctr as 0..1 and position as a 1-indexed average. Stored as
  -- reported, not rescaled to a percentage: converting on write means every
  -- reader has to know which convention this table chose.
  ctr numeric not null default 0,
  position numeric not null default 0,
  synced_at timestamptz not null default now(),
  -- A re-sync of the same day must overwrite, never accumulate. Without this a
  -- scheduled job that runs twice reports double the clicks, and nothing about
  -- the number looks wrong.
  primary key (project_id, date, query)
);

create index gsc_query_daily_project_date_idx on gsc_query_daily(project_id, date desc);

-- GSC performance per page per day.
create table gsc_page_daily (
  project_id uuid not null references projects(id) on delete cascade,
  date date not null,
  page text not null,
  clicks integer not null default 0,
  impressions integer not null default 0,
  ctr numeric not null default 0,
  position numeric not null default 0,
  synced_at timestamptz not null default now(),
  primary key (project_id, date, page)
);

create index gsc_page_daily_project_date_idx on gsc_page_daily(project_id, date desc);

-- GA4 sessions and conversions per channel per day (PRD D2.1's denominator).
--
-- `channel_group` is GA4's own `sessionDefaultChannelGroup`. It does not isolate
-- AI assistants — ChatGPT or Perplexity traffic lands in Referral or Organic
-- Social depending on the referrer — so `source` is stored alongside it and any
-- "AI referral" figure is derived from the source, never claimed to be a channel
-- GA4 reports.
create table ga4_channel_daily (
  project_id uuid not null references projects(id) on delete cascade,
  date date not null,
  channel_group text not null,
  source text not null default '',
  sessions integer not null default 0,
  engaged_sessions integer not null default 0,
  conversions numeric not null default 0,
  revenue numeric not null default 0,
  synced_at timestamptz not null default now(),
  primary key (project_id, date, channel_group, source)
);

create index ga4_channel_daily_project_date_idx on ga4_channel_daily(project_id, date desc);

-- Per-assignment sync health, so the UI can say "last synced 3 hours ago" and
-- a stalled sync is visible rather than looking like a site with no traffic.
-- On the assignment rather than the connection because a connection can serve
-- forty projects, each syncing on its own schedule and failing independently.
alter table integration_assignments add column last_synced_at timestamptz;
alter table integration_assignments add column last_sync_error text;
-- Rows fetched on the most recent successful sync. Zero is a legitimate result
-- (a new property, a quiet day); null means it has never synced.
alter table integration_assignments add column last_sync_rows integer;
