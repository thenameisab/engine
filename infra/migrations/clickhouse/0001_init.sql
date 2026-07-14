-- Time-series store (Architecture §1 Layer 3): SERP positions, AI citation
-- events, crawl results, metrics history — sub-second aggregations.
-- Operational data (accounts, entities, fix-queue state) lives in Postgres
-- instead — see infra/migrations/postgres/0001_init.sql.

-- A1 rank tracking: one row per {keyword, geo, device, language} poll.
-- Mirrors SerpResult in packages/connectors/src/serp.ts.
create table serp_positions
(
  entity_id      UUID,
  keyword        String,
  geo_country    String,
  geo_city       String,
  geo_postcode   String,
  device         LowCardinality(String),
  language       LowCardinality(String),
  engine         LowCardinality(String),
  position       Nullable(UInt16),
  url            String,
  features       Array(LowCardinality(String)),
  raw_snapshot_ref String,
  polled_at      DateTime64(3)
)
engine = MergeTree
partition by toYYYYMM(polled_at)
order by (entity_id, keyword, device, language, polled_at);

-- A2 AI visibility: one row per sampled LLM answer.
-- Mirrors CitationMeasurement in packages/core/src/citation.ts and
-- LlmAnswerResult in packages/connectors/src/llmEngine.ts.
create table citation_events
(
  entity_id       UUID,
  engine          LowCardinality(String),
  prompt          String,
  cited           UInt8,
  sources_cited   Array(String),
  sentiment       LowCardinality(String),
  accuracy        LowCardinality(String),
  method          LowCardinality(String),
  raw_answer_ref  String,
  sampled_at      DateTime64(3)
)
engine = MergeTree
partition by toYYYYMM(sampled_at)
order by (entity_id, engine, prompt, sampled_at);

-- Materialized daily citation-rate confidence band per {entity, engine, prompt}.
-- Point estimates are never surfaced (Architecture §3.2) — always low/point/high.
create materialized view citation_rate_daily_mv
engine = AggregatingMergeTree
partition by toYYYYMM(day)
order by (entity_id, engine, prompt, day)
as
select
  entity_id,
  engine,
  prompt,
  toDate(sampled_at) as day,
  countState() as n_samples,
  sumState(cited) as n_cited
from citation_events
group by entity_id, engine, prompt, day;
