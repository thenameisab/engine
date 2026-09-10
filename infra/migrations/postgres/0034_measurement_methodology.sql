-- 0034: keep the answer, name who was named, and let each account set its rhythm.
--
-- Wave 3 of the 2026-09-10 action plan (issues 16, 17, 10): what the AI poll
-- measures, and how often anything is measured.

-- 1. The answer text itself.
--
-- `raw_answer_ref` was meant to point into a raw lake that was never built:
-- every connector's default sink returns a synthetic ref such as
-- `sarvam:pending:<timestamp>`, so nothing about what the model actually said
-- has ever been stored. The plan's brand-name mining ("an extraction pass over
-- each stored answer") therefore has nothing to run over for existing rows,
-- and no backfill is possible: the text was discarded at poll time.
--
-- Nullable, no default, no backfill — a row from before this migration did
-- not record its answer, and must read as such rather than as an empty one.
alter table citation_events add column answer_text text;

comment on column citation_events.answer_text is
  'The model''s answer, verbatim. Null for samples stored before migration 0034 — not recorded, not empty.';

-- 2. Who each answer named.
--
-- A mention is evidence attached to the sample it came from, so re-mining
-- rewrites a sample's mentions rather than inventing history. `brand_key` is
-- the lower-cased, whitespace-collapsed name and is what makes "Acme" and
-- "ACME" one brand per sample. `matched_entity_id` links a name to the
-- customer's own brand or a tracked competitor when the name is one we know;
-- null means the model named someone nobody in this project is tracking yet,
-- which is the thing the customer most wants to be told.
create table answer_mentions (
  id uuid primary key default gen_random_uuid(),
  citation_event_id uuid not null references citation_events(id) on delete cascade,
  brand text not null,
  brand_key text not null,
  is_self boolean not null default false,
  matched_entity_id uuid references entities(id) on delete set null,
  -- 'known': matched deterministically against a tracked name.
  -- 'extracted': the model was asked which companies the answer names.
  source text not null check (source in ('known', 'extracted')),
  created_at timestamptz not null default now(),
  unique (citation_event_id, brand_key)
);

create index answer_mentions_event_idx on answer_mentions (citation_event_id);

-- 3. Per-account cadence overrides.
--
-- The plan's defaults (§5) depend on the plan tier and live in code, in
-- `@engine/core`'s CADENCE_DEFAULTS. A row here exists only when an
-- administrator has overridden one or more of them for an account; a null
-- column means "the plan default", so upgrading a plan changes an
-- un-overridden cadence without anyone editing this table.
--
-- Deterministic audits are not here: they call no vendor and run nightly for
-- everyone, which §5 records as the case since #87.
create table account_cadence (
  account_id uuid primary key references accounts(id) on delete cascade,
  rank_poll text check (rank_poll in ('daily', 'weekly')),
  ai_poll text check (ai_poll in ('weekly', 'monthly')),
  crawl text check (crawl in ('weekly', 'monthly', 'on_demand')),
  updated_by text,
  updated_at timestamptz not null default now()
);
