-- 0030: record which model produced a sample, and split "cited" into the two
-- different claims it was conflating.
--
-- Both columns exist because `citation_events` was recording less than it
-- appeared to.
--
-- 1. `engine` is the vendor ('sarvam'), not the instrument. A vendor's models
--    disagree: measured 2026-09-09 across three category prompts,
--    `sarvam-105b` named a company in one of them while
--    `sarvam-105b-conversations` named companies in all three. A citation rate
--    is a series over time, so pooling samples from two models into one band
--    reports a change of instrument as a change in the brand's visibility.
--    Until now `SARVAM_MODEL` could be changed and nothing recorded that it
--    had been.
--
-- 2. `cited` was `citedByName || citedByDomain` — "the model said your name"
--    OR "the model linked your site". Those are different products of
--    different strength, and on an engine that does not browse the second is
--    structurally unreachable, so the single boolean silently changed meaning
--    with the engine it came from.
--
-- All three columns are nullable with no backfill, deliberately. The existing
-- rows were written before anything recorded a model, and the point of this
-- migration is that unrecorded provenance must not masquerade as recorded
-- provenance — a default would assert a fact about history that the database
-- never observed. Reads render a null as "not recorded" instead.
alter table citation_events add column model text;

alter table citation_events add column cited_by_name boolean;
alter table citation_events add column cited_by_domain boolean;

-- The band is grouped per (engine, model), so that pair leads the index.
create index citation_events_entity_engine_model_idx
  on citation_events (entity_id, engine, model, sampled_at desc);

comment on column citation_events.model is
  'Vendor model id that produced the sample. Null for rows written before migration 0030 — not recorded, not assumed.';
comment on column citation_events.cited_by_name is
  'The answer text named the brand. The only half a non-browsing engine can satisfy.';
comment on column citation_events.cited_by_domain is
  'A cited source URL belonged to the brand''s own domain. Requires an engine that returns sources.';
