-- The A1/A2 data spine, standing in for the ClickHouse warehouse the
-- architecture doc specifies (see infra/migrations/clickhouse/0001_init.sql)
-- until a managed ClickHouse instance is provisioned. Postgres is the wrong
-- long-term home for sub-second time-series aggregation at scale, but it is
-- the store that already exists, and a poll result with nowhere to land is a
-- worse failure than one sitting in the "wrong" database. Both tables mirror
-- the ClickHouse column shapes exactly, so a later migration to ClickHouse is
-- a data copy, not a redesign.
--
-- Before this migration, POST /rank/poll and POST /ai/poll fetched live data
-- and discarded it after responding — M1.1 ("ingestion -> warehouse -> query
-- <500ms") and the 24-month raw-lake rule (roadmap dependency #4) were both
-- unmet. This is the fix.

-- A1 rank tracking: one row per {keyword, geo, device, language} poll.
-- Mirrors SerpResult in packages/connectors/src/serp.ts.
create table serp_positions (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references entities(id) on delete cascade,
  keyword text not null,
  geo_country text not null,
  geo_city text,
  geo_postcode text,
  device text not null check (device in ('desktop', 'mobile', 'tablet')),
  language text not null,
  engine text not null check (engine in ('google', 'bing')),
  -- Best organic position for the tracked domain, 1-indexed. Null = not
  -- ranking in the tracked result depth (organicSov treats null as 0 CTR).
  position integer,
  url text,
  features text[] not null default '{}',
  -- Search volume for the keyword, used as organicSov's demand weight (A3.1).
  -- Null until A4 keyword research supplies real volume; the rollup treats a
  -- null volume as an equal weight of 1 rather than 0, so an unweighted
  -- keyword still counts instead of vanishing from the score.
  volume integer,
  raw_snapshot_ref text not null,
  polled_at timestamptz not null
);

create index serp_positions_entity_polled_idx on serp_positions (entity_id, polled_at desc);
create index serp_positions_entity_keyword_idx on serp_positions (entity_id, keyword, polled_at desc);

-- A2 AI visibility: one row per sampled LLM answer.
-- Mirrors LlmAnswerSample/LlmAnswerResult in packages/connectors/src/llmEngine.ts
-- and CitationEvent within it.
create table citation_events (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references entities(id) on delete cascade,
  engine text not null check (engine in ('openai', 'gemini', 'perplexity', 'anthropic', 'google-ai-overview')),
  prompt text not null,
  cited boolean not null,
  sources_cited text[] not null default '{}',
  sentiment text check (sentiment in ('positive', 'neutral', 'negative')),
  accuracy text check (accuracy in ('accurate', 'inaccurate', 'unverifiable')),
  method text not null check (method in ('api', 'consumer', 'reconciled')),
  raw_answer_ref text not null,
  sampled_at timestamptz not null
);

create index citation_events_entity_sampled_idx on citation_events (entity_id, sampled_at desc);
create index citation_events_entity_engine_prompt_idx on citation_events (entity_id, engine, prompt, sampled_at desc);
