-- Operational store (Architecture §1 Layer 3 / §3).
-- Holds accounts, projects, configs, and Fix Queue state.
-- Time-series data (SERP positions, citation events) lives in ClickHouse instead
-- — see infra/migrations/clickhouse/0001_init.sql.

create extension if not exists pgcrypto;

create table accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table projects (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  name text not null,
  domain text not null,
  created_at timestamptz not null default now()
);

-- Mirrors packages/core/src/entity.ts Entity — the join key for everything else.
create table entities (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  canonical_name text not null,
  wikidata_id text,
  urls text[] not null default '{}',
  keywords text[] not null default '{}',
  prompts text[] not null default '{}',
  citations text[] not null default '{}',
  mentions text[] not null default '{}',
  schema jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A1 tracked {keyword, geo, device, language} tuple (SerpQuery in packages/connectors).
create table keyword_configs (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references entities(id) on delete cascade,
  keyword text not null,
  geo_country text not null,
  geo_city text,
  geo_postcode text,
  device text not null check (device in ('desktop', 'mobile', 'tablet')),
  language text not null,
  engine text not null check (engine in ('google', 'bing')),
  cadence text not null default 'weekly' check (cadence in ('weekly', 'daily', 'on_demand')),
  created_at timestamptz not null default now()
);

-- Mirrors packages/core/src/contract.ts Finding.
create table findings (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references entities(id) on delete cascade,
  source text not null check (source in ('technical', 'content', 'entity', 'local')),
  severity numeric not null,
  predicted_impact numeric not null,
  evidence jsonb not null default '{}',
  action_templates jsonb not null default '[]',
  created_at timestamptz not null default now()
);

-- Mirrors packages/core/src/contract.ts Action — the Fix Queue state machine.
create table actions (
  id uuid primary key default gen_random_uuid(),
  finding_id uuid not null references findings(id) on delete cascade,
  type text not null check (type in ('schema', 'meta', 'redirect', 'robots', 'content', 'gbp')),
  target jsonb not null,
  diff jsonb not null,
  status text not null default 'proposed'
    check (status in ('proposed', 'approved', 'deployed', 'verified', 'rolled_back')),
  audit_log jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index entities_project_id_idx on entities(project_id);
create index keyword_configs_entity_id_idx on keyword_configs(entity_id);
create index findings_entity_id_idx on findings(entity_id);
create index actions_finding_id_idx on actions(finding_id);
create index actions_status_idx on actions(status);
